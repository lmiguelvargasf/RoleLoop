"""Thin headless command adapter and the default Textual entry point."""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import sys
import tempfile
import webbrowser
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TextIO, cast

from roleloop.adapters.inputs import (
    local_date_time,
    profile_draft_from_mapping,
    resume_source_draft_from_mapping,
)
from roleloop.adapters.serialization import to_primitive
from roleloop.application import (
    ApplicationError,
    ArtifactError,
    ConcurrentInstanceError,
    InboxFilters,
    InvalidTransitionError,
    NotFoundError,
    Page,
    ProgressUpdate,
    ProviderFailureError,
    ProviderUnavailableError,
    RevisionConflictError,
    ValidationError,
)
from roleloop.application.dto import ApplicationStageDraft, SubmitApplicationDraft
from roleloop.domain import Answer, ApplicationStage, Decision, ResumeSourceKind
from roleloop.infrastructure.legacy import LegacyMasterStateReader, LegacyStateError

SCHEMA_VERSION = 1


class ServiceFactory(Protocol):
    def __call__(self) -> Any: ...


@dataclass(slots=True)
class StderrProgress:
    stream: TextIO

    def report(self, update: ProgressUpdate) -> None:
        detail = f": {update.message}" if update.message else ""
        print(f"{update.operation} [{update.stage}]{detail}", file=self.stream)


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="roleloop",
        description="An evidence-first local job-search workflow.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    profile_parser = commands.add_parser("profile", help="Create and manage search profiles")
    profile_commands = profile_parser.add_subparsers(dest="profile_command", required=True)
    create_profile_parser = profile_commands.add_parser("create", help="Create a search profile")
    _add_profile_arguments(create_profile_parser)
    _add_json_argument(create_profile_parser)
    create_profile_parser.add_argument("--command-id")
    import_profile_parser = profile_commands.add_parser(
        "import", help="Create a profile from one strict JSON object"
    )
    import_profile_parser.add_argument("path", type=str)
    _add_json_argument(import_profile_parser)
    import_profile_parser.add_argument("--command-id")
    show_profile_parser = profile_commands.add_parser("show", help="Show profile settings")
    show_profile_parser.add_argument("profile_id", nargs="?")
    _add_json_argument(show_profile_parser)
    update_profile_parser = profile_commands.add_parser(
        "update", help="Create a new immutable version from JSON"
    )
    update_profile_parser.add_argument("profile_id")
    update_profile_parser.add_argument("--from-json", required=True, dest="json_path")
    update_profile_parser.add_argument("--expected-revision", type=positive_int)
    update_profile_parser.add_argument("--command-id")
    _add_json_argument(update_profile_parser)
    activate_profile_parser = profile_commands.add_parser(
        "activate", help="Activate an existing profile"
    )
    activate_profile_parser.add_argument("profile_id")
    activate_profile_parser.add_argument("--command-id")
    _add_json_argument(activate_profile_parser)

    provider_parser = commands.add_parser("provider", help="Inspect agent-provider readiness")
    provider_commands = provider_parser.add_subparsers(dest="provider_command", required=True)
    provider_status_parser = provider_commands.add_parser("status")
    _add_json_argument(provider_status_parser)

    doctor_parser = commands.add_parser("doctor", help="Check all local and provider requirements")
    _add_json_argument(doctor_parser)

    find_parser = commands.add_parser("find", help="Discover jobs for the active profile")
    find_parser.add_argument("--limit", type=positive_int, default=20)
    find_parser.add_argument("--command-id")
    _add_json_argument(find_parser)

    add_parser = commands.add_parser("add", help="Inspect and add an original job URL")
    add_parser.add_argument("job_url", metavar="JOB_URL")
    add_parser.add_argument("--command-id")
    _add_json_argument(add_parser)

    inbox_parser = commands.add_parser("inbox", help="List jobs for the active profile")
    _add_json_argument(inbox_parser)

    analyze_parser = commands.add_parser(
        "analyze", help="Explicitly sync evidence and run Reviewer"
    )
    analyze_parser.add_argument("job_id", metavar="JOB_ID")
    analyze_parser.add_argument("--rerun", action="store_true")
    analyze_parser.add_argument("--command-id")
    _add_json_argument(analyze_parser)

    # Kept as a compatibility spelling; new documentation and UI use Analyze.
    review_parser = commands.add_parser("review")
    review_parser.add_argument("job_id", metavar="JOB_ID")
    review_parser.add_argument("--rerun", action="store_true")
    review_parser.add_argument("--command-id")
    _add_json_argument(review_parser)

    answer_parser = commands.add_parser("answer", help="Append a verification answer")
    answer_parser.add_argument("job_id", metavar="JOB_ID")
    answer_parser.add_argument("question_id", metavar="QUESTION")
    answer_parser.add_argument("answer", choices=["yes", "no", "unknown"])
    answer_parser.add_argument("--command-id")
    _add_json_argument(answer_parser)

    answer_history_parser = commands.add_parser(
        "answer-history", help="Show append-only verification answers"
    )
    answer_history_parser.add_argument("job_id", metavar="JOB_ID")
    answer_history_parser.add_argument("question_id", metavar="QUESTION", nargs="?")
    _add_json_argument(answer_history_parser)

    decide_parser = commands.add_parser("decide", help="Record a human job decision")
    decide_parser.add_argument("job_id", metavar="JOB_ID")
    decide_parser.add_argument("decision", choices=["tailor", "watch", "skip"])
    decide_parser.add_argument("--command-id")
    _add_json_argument(decide_parser)

    resume_parser = commands.add_parser("resume", help="Review and manage tailored résumé runs")
    resume_commands = resume_parser.add_subparsers(dest="resume_command", required=True)
    for name, help_text in (
        ("show", "Show the latest run and lineage"),
        ("open", "Open the latest generated PDF"),
        ("retry", "Retry a failed generation"),
        ("approve", "Approve the exact latest PDF"),
    ):
        command = resume_commands.add_parser(name, help=help_text)
        command.add_argument("job_id", metavar="JOB_ID")
        if name in {"retry", "approve"}:
            command.add_argument("--command-id")
        _add_json_argument(command)
    export_resume_parser = resume_commands.add_parser("export", help="Export a verified PDF")
    export_resume_parser.add_argument("job_id", metavar="JOB_ID")
    export_resume_parser.add_argument("destination")
    _add_json_argument(export_resume_parser)
    revise_resume_parser = resume_commands.add_parser(
        "revise", help="Create a feedback-linked child run"
    )
    revise_resume_parser.add_argument("job_id", metavar="JOB_ID")
    revise_resume_parser.add_argument("--feedback", required=True)
    revise_resume_parser.add_argument("--command-id")
    _add_json_argument(revise_resume_parser)
    reject_resume_parser = resume_commands.add_parser("reject", help="Reject the latest PDF")
    reject_resume_parser.add_argument("job_id", metavar="JOB_ID")
    reject_resume_parser.add_argument("--feedback", default="")
    reject_resume_parser.add_argument("--command-id")
    _add_json_argument(reject_resume_parser)

    application_parser = commands.add_parser(
        "application", help="Record manual applications and stage history"
    )
    application_commands = application_parser.add_subparsers(
        dest="application_command", required=True
    )
    submit_parser = application_commands.add_parser("submit")
    submit_parser.add_argument("job_id", metavar="JOB_ID")
    submit_parser.add_argument("--follow-up", required=True, metavar="YYYY-MM-DD")
    submit_parser.add_argument("--note", default="")
    submit_parser.add_argument("--command-id")
    _add_json_argument(submit_parser)
    stage_parser = application_commands.add_parser("stage")
    stage_parser.add_argument("job_id", metavar="JOB_ID")
    stage_parser.add_argument(
        "stage",
        choices=[stage.value for stage in ApplicationStage],
        metavar="STAGE",
    )
    stage_followup = stage_parser.add_mutually_exclusive_group(required=True)
    stage_followup.add_argument("--follow-up", metavar="YYYY-MM-DD")
    stage_followup.add_argument("--no-follow-up", action="store_true")
    stage_parser.add_argument("--note", default="")
    stage_parser.add_argument("--command-id")
    _add_json_argument(stage_parser)
    application_history_parser = application_commands.add_parser("history")
    application_history_parser.add_argument("job_id", metavar="JOB_ID")
    _add_json_argument(application_history_parser)

    followups_parser = commands.add_parser("followups", help="Manage the manual follow-up queue")
    followup_commands = followups_parser.add_subparsers(dest="followup_command", required=True)
    due_parser = followup_commands.add_parser("due")
    due_parser.add_argument("--at", metavar="YYYY-MM-DD")
    _add_json_argument(due_parser)
    resolve_parser = followup_commands.add_parser("resolve")
    resolve_parser.add_argument("follow_up_id")
    resolve_parser.add_argument("--note", default="")
    resolve_parser.add_argument("--command-id")
    _add_json_argument(resolve_parser)
    reschedule_parser = followup_commands.add_parser("reschedule")
    reschedule_parser.add_argument("follow_up_id")
    reschedule_parser.add_argument("date", metavar="YYYY-MM-DD")
    reschedule_parser.add_argument("--note", default="")
    reschedule_parser.add_argument("--command-id")
    _add_json_argument(reschedule_parser)

    history_parser = commands.add_parser("history", help="Show one chronological case history")
    history_parser.add_argument("job_id", metavar="JOB_ID")
    _add_json_argument(history_parser)

    legacy_parser = commands.add_parser("legacy", help="Import prototype history read-only")
    legacy_commands = legacy_parser.add_subparsers(dest="legacy_command", required=True)
    legacy_import_parser = legacy_commands.add_parser("import-master-state")
    legacy_import_parser.add_argument(
        "repository",
        nargs="?",
        help="Local master-resume repository (defaults to the configured local source)",
    )
    legacy_mode = legacy_import_parser.add_mutually_exclusive_group(required=True)
    legacy_mode.add_argument("--preview", action="store_true")
    legacy_mode.add_argument("--apply", action="store_true")
    legacy_import_parser.add_argument("--command-id")
    _add_json_argument(legacy_import_parser)

    # Pre-v1 aliases remain parseable so existing scripts receive a policy-aware error.
    applied_parser = commands.add_parser("applied")
    applied_parser.add_argument("job_id", metavar="JOB_ID")

    outcome_parser = commands.add_parser("outcome")
    outcome_parser.add_argument("job_id", metavar="JOB_ID")
    outcome_parser.add_argument(
        "outcome",
        choices=["interviewing", "offer", "rejected", "withdrawn", "no_response"],
        metavar="OUTCOME",
    )

    source_parser = commands.add_parser(
        "resume-source",
        help="Configure and explicitly sync a master résumé Git repository",
    )
    source_commands = source_parser.add_subparsers(
        dest="resume_source_command",
        required=True,
    )
    configure_source_parser = source_commands.add_parser(
        "configure",
        help="Configure the active profile's master résumé repository",
    )
    configure_source_parser.add_argument("repository", metavar="REPOSITORY")
    configure_source_parser.add_argument(
        "--kind",
        required=True,
        choices=[kind.value for kind in ResumeSourceKind],
    )
    configure_source_parser.add_argument(
        "--document-path",
        default="roleloop_contract/v1/cli.py",
        metavar="PATH",
        help=argparse.SUPPRESS,
    )
    configure_source_parser.add_argument(
        "--ref",
        default=None,
        metavar="REF",
        help="Git branch, tag, or revision (defaults to HEAD locally and main remotely)",
    )
    configure_source_parser.add_argument(
        "--trust-contract",
        required=True,
        action="store_true",
        help="Trust the fixed bridge in this repository/ref and future commits",
    )
    configure_source_parser.add_argument("--command-id")
    _add_json_argument(configure_source_parser)

    show_source_parser = source_commands.add_parser(
        "show",
        help="Show the active profile's master résumé source",
    )
    _add_json_argument(show_source_parser)

    sync_source_parser = source_commands.add_parser(
        "sync",
        help="Resolve and activate an immutable master résumé snapshot",
    )
    sync_source_parser.add_argument("--command-id")
    _add_json_argument(sync_source_parser)
    return parser


def _add_json_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", dest="as_json")


def _add_profile_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--name", required=True)
    parser.add_argument("--role", action="append", required=True, dest="target_roles")
    parser.add_argument("--provider", required=True, choices=["demo", "openai"])
    parser.add_argument("--location", action="append", default=[], dest="locations")
    parser.add_argument(
        "--remote-preference",
        choices=["any", "remote", "hybrid", "onsite"],
        default="remote",
    )
    parser.add_argument("--employment-type", action="append", default=[], dest="employment_types")
    parser.add_argument("--seniority", action="append", default=[])
    parser.add_argument("--salary-floor", type=int, dest="annual_salary_floor")
    parser.add_argument("--salary-currency", default="USD")
    parser.add_argument("--include-keyword", action="append", default=[], dest="include_keywords")
    parser.add_argument("--exclude-keyword", action="append", default=[], dest="exclude_keywords")
    parser.add_argument("--constraint", default="", dest="constraints")
    parser.add_argument("--residence-country", default="Ecuador")
    parser.add_argument("--timezone", default="America/Guayaquil")
    parser.add_argument(
        "--target-hq-country",
        action="append",
        default=[],
        dest="target_hq_countries",
    )
    parser.add_argument("--require-startup", action="store_true", dest="startup_required")
    parser.add_argument(
        "--accepted-remote-arrangement",
        action="append",
        default=[],
        dest="accepted_remote_arrangements",
    )
    parser.add_argument(
        "--accepted-hiring-arrangement",
        action="append",
        default=[],
        dest="accepted_hiring_arrangements",
    )
    parser.add_argument("--query", action="append", default=[], dest="search_queries")
    parser.add_argument("--paper-size", choices=["a4paper", "letterpaper"], default="a4paper")
    parser.add_argument("--page-limit", type=positive_int, default=2)
    for agent in ("scout", "reviewer", "resume"):
        environment_prefix = f"ROLELOOP_{agent.upper()}"
        parser.add_argument(
            f"--{agent}-model",
            default=os.environ.get(f"{environment_prefix}_MODEL", "gpt-5.6-terra"),
        )
        parser.add_argument(
            f"--{agent}-reasoning-effort",
            choices=["low", "medium", "high", "xhigh"],
            default=os.environ.get(f"{environment_prefix}_REASONING_EFFORT", "medium").lower(),
        )


def success_envelope(data: Any) -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "data": to_primitive(data)}


def error_envelope(error: ApplicationError) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "error": {
            "code": error.code,
            "message": error.message,
            "details": to_primitive(error.details),
        },
    }


def unexpected_error_envelope() -> dict[str, Any]:
    """Return a stable machine-facing failure without exposing internals."""

    return {
        "schema_version": SCHEMA_VERSION,
        "error": {
            "code": "unexpected_error",
            "message": "RoleLoop encountered an unexpected failure.",
            "details": {},
        },
    }


def _resolve(value: Any) -> Any:
    if inspect.isawaitable(value):
        return asyncio.run(cast(Coroutine[Any, Any, Any], value))
    return value


def _active_profile_id(service: Any) -> str:
    summary = _resolve(service.get_active_profile_summary())
    if summary is None:
        raise ValidationError("No active search profile. Launch `roleloop` to complete onboarding.")
    profile = getattr(summary, "profile", summary)
    profile_id = getattr(profile, "id", None)
    if not profile_id:
        raise ValidationError("The active search profile has no identifier.")
    return str(profile_id)


def _active_profile(service: Any) -> Any:
    summary = _resolve(service.get_active_profile_summary())
    if summary is None:
        raise ValidationError("No active search profile. Create or activate one first.")
    return getattr(summary, "profile", summary)


def _read_json_object(path_value: str) -> dict[str, Any]:
    path = Path(path_value).expanduser().resolve(strict=False)
    try:
        data = path.read_bytes()
    except OSError as error:
        raise ValidationError(f"Could not read JSON input: {path}") from error
    if len(data) > 2 * 1024 * 1024:
        raise ValidationError("JSON input exceeds the 2 MiB limit.")
    try:
        decoded = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("Input must be one valid UTF-8 JSON object.") from error
    if not isinstance(decoded, dict):
        raise ValidationError("Input must contain one JSON object.")
    return decoded


def _profile_values_from_args(args: argparse.Namespace) -> dict[str, Any]:
    values = {
        key: value
        for key, value in vars(args).items()
        if key
        not in {
            "command",
            "profile_command",
            "as_json",
            "command_id",
            "provider",
        }
    }
    values["agent_provider"] = args.provider
    values["agent_configurations"] = tuple(
        {
            "kind": name,
            "provider": args.provider,
            "model": getattr(args, f"{name}_model"),
            "reasoning_effort": getattr(args, f"{name}_reasoning_effort"),
        }
        for name in ("scout", "reviewer", "resume")
    )
    for name in ("scout", "reviewer", "resume"):
        values.pop(f"{name}_model", None)
        values.pop(f"{name}_reasoning_effort", None)
    return values


def _command_options(args: argparse.Namespace) -> dict[str, str]:
    command_id = getattr(args, "command_id", None)
    return {"command_id": command_id} if command_id else {}


def _latest_resume_run(service: Any, profile_id: str, job_id: str) -> Any:
    view = _resolve(service.get_job_case(profile_id, job_id))
    run = getattr(view, "latest_resume_run", None) or getattr(view, "resume_run", None)
    if run is None:
        raise ValidationError("This job has no résumé run.")
    return run


def _profile_local_date(service: Any, value: str) -> Any:
    profile = _active_profile(service)
    timezone = str(getattr(profile, "timezone", "America/Guayaquil"))
    return local_date_time(value, timezone)


def _legacy_repository(service: Any, profile_id: str, value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve(strict=False)
    source = _resolve(service.get_resume_source(profile_id))
    if source is None:
        raise ValidationError(
            "Provide a repository path or configure a local master résumé source first."
        )
    if getattr(source, "kind", None) is not ResumeSourceKind.LOCAL_GIT:
        raise ValidationError(
            "Legacy prototype databases can only be imported from a local repository."
        )
    return Path(str(source.repository)).expanduser().resolve(strict=False)


def _service_call(service: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    """Invoke a service while tolerating optional rollout-only keyword additions."""

    method = getattr(service, name)
    signature = inspect.signature(method)
    supports_arbitrary = any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
    if not supports_arbitrary:
        kwargs = {key: value for key, value in kwargs.items() if key in signature.parameters}
    return _resolve(method(*args, **kwargs))


def _artifact_id_from_run(run: Any) -> str:
    artifact = getattr(run, "artifact", None)
    artifact_id = getattr(artifact, "id", None) if artifact is not None else None
    if not artifact_id:
        raise ValidationError("The latest résumé run has no generated PDF artifact.")
    return str(artifact_id)


def _render_inbox(items: Sequence[Any]) -> str:
    if not items:
        return "Inbox is empty."
    lines = []
    for item in items:
        job_id = getattr(item, "job_id", "-")
        title = getattr(item, "title", "") or "Untitled role"
        company = getattr(item, "company", "") or "Unknown company"
        decision = getattr(getattr(item, "decision", ""), "value", getattr(item, "decision", ""))
        application = getattr(
            getattr(item, "application_status", ""),
            "value",
            getattr(item, "application_status", ""),
        )
        lines.append(f"{job_id}\t{title}\t{company}\t{decision}\t{application}")
    return "\n".join(lines)


def _render_review(view: Any) -> str:
    job = getattr(view, "job", None)
    case = getattr(view, "case", None)
    title = getattr(job, "title", "") or "Untitled role"
    company = getattr(job, "company", "") or "Unknown company"
    lines = [f"{title} at {company}", f"Job ID: {getattr(job, 'id', '-')}"]
    if case is not None:
        decision = getattr(getattr(case, "decision", ""), "value", case.decision)
        application = getattr(
            getattr(case, "application_status", ""), "value", case.application_status
        )
        lines.extend(
            (
                f"Decision: {decision}",
                f"Application: {application}",
            )
        )
    review_status = getattr(view, "review_status", None)
    eligibility = getattr(view, "eligibility_status", None)
    lines.append(f"Review: {getattr(review_status, 'value', review_status)}")
    lines.append(f"Eligibility: {getattr(eligibility, 'value', eligibility)}")
    return "\n".join(lines)


def _render_resume_source(source: Any | None) -> str:
    if source is None:
        return "No master résumé source is configured."
    kind = getattr(getattr(source, "kind", ""), "value", getattr(source, "kind", ""))
    last_revision = getattr(source, "last_synced_revision", None) or "never"
    return "\n".join(
        (
            f"Kind: {kind}",
            f"Repository: {getattr(source, 'repository', '-')}",
            f"Ref: {getattr(source, 'ref', '-')}",
            f"Document: {getattr(source, 'document_path', '-')}",
            f"Last synced revision: {last_revision}",
        )
    )


def _dispatch(args: argparse.Namespace, service: Any, progress: StderrProgress) -> tuple[Any, str]:
    if args.command == "profile":
        if args.profile_command == "create":
            profile = _service_call(
                service,
                "create_profile",
                profile_draft_from_mapping(_profile_values_from_args(args)),
                **_command_options(args),
            )
            return profile, f"Created profile {getattr(profile, 'id', '-')}."
        if args.profile_command == "import":
            profile = _service_call(
                service,
                "create_profile",
                profile_draft_from_mapping(_read_json_object(args.path)),
                **_command_options(args),
            )
            return profile, f"Imported profile {getattr(profile, 'id', '-')}."
        if args.profile_command == "show":
            profiles = tuple(_service_call(service, "list_profiles"))
            if args.profile_id:
                try:
                    profile = next(item for item in profiles if item.id == args.profile_id)
                except StopIteration as error:
                    raise NotFoundError(f"Profile not found: {args.profile_id}") from error
            else:
                profile = _active_profile(service)
            return profile, json.dumps(to_primitive(profile), indent=2, sort_keys=True)
        if args.profile_command == "update":
            profiles = tuple(_service_call(service, "list_profiles"))
            try:
                current = next(item for item in profiles if item.id == args.profile_id)
            except StopIteration as error:
                raise NotFoundError(f"Profile not found: {args.profile_id}") from error
            profile = _service_call(
                service,
                "update_profile",
                args.profile_id,
                profile_draft_from_mapping(_read_json_object(args.json_path)),
                expected_revision=args.expected_revision or current.revision,
                **_command_options(args),
            )
            return profile, f"Updated profile {args.profile_id}."
        if args.profile_command == "activate":
            profile = _service_call(
                service,
                "activate_profile",
                args.profile_id,
                **_command_options(args),
            )
            return profile, f"Activated profile {args.profile_id}."
        raise AssertionError(f"Unhandled profile command: {args.profile_command}")

    if args.command == "provider" and args.provider_command == "status":
        status = _service_call(service, "get_provider_status")
        if status is None:
            return None, "No profile is configured; choose Demo or OpenAI during onboarding."
        return status, json.dumps(to_primitive(status), indent=2, sort_keys=True)

    if args.command == "doctor":
        report = _service_call(service, "check_runtime")
        checks = tuple(getattr(report, "checks", ()) or ())
        lines = [
            f"{'OK' if getattr(check, 'available', False) else 'MISSING'}\t"
            f"{getattr(check, 'capability', 'unknown')}\t{getattr(check, 'detail', '')}"
            for check in checks
        ]
        ready = bool(getattr(report, "ready", False))
        lines.append("READY" if ready else "NOT READY")
        return report, "\n".join(lines)

    profile_id = _active_profile_id(service)
    if args.command == "legacy" and args.legacy_command == "import-master-state":
        repository = _legacy_repository(service, profile_id, args.repository)
        try:
            draft = LegacyMasterStateReader().to_import_draft(repository)
        except LegacyStateError as error:
            raise ValidationError(str(error)) from error
        preview = _service_call(service, "preview_legacy_import", draft)
        if args.preview:
            return preview, json.dumps(to_primitive(preview), indent=2, sort_keys=True)
        batch = _service_call(
            service,
            "apply_legacy_import",
            profile_id,
            draft,
            **_command_options(args),
        )
        return (
            batch,
            "Imported legacy history as legacy_unpinned records; original databases "
            "were left unchanged.",
        )
    if args.command == "find":
        result = _service_call(
            service,
            "discover_jobs",
            profile_id,
            limit=args.limit,
            progress=progress,
            **_command_options(args),
        )
        count = len(result) if isinstance(result, Sequence) else getattr(result, "count", 0)
        return result, f"Discovery complete: {count} job{'s' if count != 1 else ''}."
    if args.command == "add":
        view = _service_call(
            service,
            "inspect_job_url",
            profile_id,
            args.job_url,
            progress=progress,
            **_command_options(args),
        )
        job = getattr(view, "job", None)
        job_id = (
            getattr(job, "id", None) or getattr(view, "job_id", None) or getattr(view, "id", "-")
        )
        return view, f"Added job {job_id}."
    if args.command == "inbox":
        collected: list[Any] = []
        while True:
            batch = tuple(
                _resolve(
                    service.list_inbox(
                        profile_id,
                        filters=InboxFilters(),
                        page=Page(limit=500, offset=len(collected)),
                    )
                )
            )
            collected.extend(batch)
            if len(batch) < 500:
                break
        items = tuple(collected)
        return items, _render_inbox(items)
    if args.command in {"analyze", "review"}:
        view = _service_call(
            service,
            "review_job",
            profile_id,
            args.job_id,
            rerun=args.rerun,
            progress=progress,
            **_command_options(args),
        )
        return view, _render_review(view)
    if args.command == "answer":
        view = _service_call(
            service,
            "answer_verification",
            profile_id,
            args.job_id,
            args.question_id,
            Answer(args.answer),
            **_command_options(args),
        )
        return view, f"Recorded {args.answer} for {args.question_id}."
    if args.command == "answer-history":
        events = _service_call(
            service,
            "get_answer_history",
            profile_id,
            args.job_id,
            args.question_id,
        )
        return events, json.dumps(to_primitive(events), indent=2, sort_keys=True)
    if args.command == "decide":
        if hasattr(service, "decide_and_tailor"):
            result = _service_call(
                service,
                "decide_and_tailor",
                profile_id,
                args.job_id,
                Decision(args.decision),
                progress=progress,
                **_command_options(args),
            )
        else:
            result = _service_call(
                service,
                "decide_job",
                profile_id,
                args.job_id,
                Decision(args.decision),
            )
        suffix = " Résumé generation completed." if args.decision == "tailor" else ""
        return result, f"Decision recorded: {args.decision}.{suffix}"
    if args.command == "resume":
        run = _latest_resume_run(service, profile_id, args.job_id)
        if args.resume_command == "show":
            result = (
                _service_call(service, "get_resume", profile_id, args.job_id)
                if hasattr(service, "get_resume")
                else run
            )
            return result, json.dumps(to_primitive(result), indent=2, sort_keys=True)
        if args.resume_command == "retry":
            result = _service_call(
                service,
                "retry_resume",
                profile_id,
                args.job_id,
                progress=progress,
                **_command_options(args),
            )
            return result, f"Retried résumé generation for {args.job_id}."
        if args.resume_command == "revise":
            result = _service_call(
                service,
                "revise_resume",
                profile_id,
                args.job_id,
                args.feedback,
                progress=progress,
                **_command_options(args),
            )
            return result, f"Created a child résumé run for {args.job_id}."
        if args.resume_command == "approve":
            result = _service_call(
                service,
                "approve_resume",
                profile_id,
                args.job_id,
                run.id,
                **_command_options(args),
            )
            return result, f"Approved exact PDF for résumé run {run.id}."
        if args.resume_command == "reject":
            result = _service_call(
                service,
                "reject_resume",
                profile_id,
                args.job_id,
                run.id,
                feedback=args.feedback,
                **_command_options(args),
            )
            return result, f"Rejected résumé run {run.id}."
        if args.resume_command in {"export", "open"}:
            artifact_id = _artifact_id_from_run(run)
            if args.resume_command == "export":
                destination = Path(args.destination).expanduser()
            else:
                temporary_root = Path(tempfile.mkdtemp(prefix="roleloop-resume-open-"))
                destination = temporary_root / f"{run.id}.pdf"
            exported = _service_call(
                service,
                "export_artifact",
                artifact_id,
                destination,
            )
            if args.resume_command == "open":
                webbrowser.open(Path(exported).resolve().as_uri())
                return exported, f"Opened résumé run {run.id}."
            return exported, f"Exported résumé to {exported}."
        raise AssertionError(f"Unhandled résumé command: {args.resume_command}")

    if args.command == "application":
        if args.application_command == "submit":
            result = _service_call(
                service,
                "submit_application",
                profile_id,
                args.job_id,
                SubmitApplicationDraft(
                    follow_up_at=_profile_local_date(service, args.follow_up),
                    follow_up_note=args.note,
                ),
                **_command_options(args),
            )
            return result, f"Recorded manual submission for {args.job_id}."
        if args.application_command == "stage":
            result = _service_call(
                service,
                "record_application_stage",
                profile_id,
                args.job_id,
                ApplicationStageDraft(
                    stage=ApplicationStage(args.stage),
                    note=args.note,
                    follow_up_at=(
                        _profile_local_date(service, args.follow_up) if args.follow_up else None
                    ),
                    no_follow_up=args.no_follow_up,
                ),
                **_command_options(args),
            )
            return result, f"Recorded application stage {args.stage}."
        if args.application_command == "history":
            method = "get_application" if hasattr(service, "get_application") else "get_history"
            result = _service_call(service, method, profile_id, args.job_id)
            return result, json.dumps(to_primitive(result), indent=2, sort_keys=True)
        raise AssertionError(f"Unhandled application command: {args.application_command}")

    if args.command == "followups":
        if args.followup_command == "due":
            due_at = _profile_local_date(service, args.at) if args.at else None
            result = _service_call(
                service,
                "list_due_followups",
                profile_id,
                at=due_at,
            )
            return result, json.dumps(to_primitive(result), indent=2, sort_keys=True)
        if args.followup_command == "resolve":
            result = _service_call(
                service,
                "resolve_followup",
                profile_id,
                args.follow_up_id,
                note=args.note,
                **_command_options(args),
            )
            return result, f"Resolved follow-up {args.follow_up_id}."
        if args.followup_command == "reschedule":
            result = _service_call(
                service,
                "reschedule_followup",
                profile_id,
                args.follow_up_id,
                _profile_local_date(service, args.date),
                note=args.note,
                **_command_options(args),
            )
            return result, f"Rescheduled follow-up {args.follow_up_id}."
        raise AssertionError(f"Unhandled follow-up command: {args.followup_command}")

    if args.command == "history":
        method = "get_unified_history" if hasattr(service, "get_unified_history") else "get_history"
        result = _service_call(service, method, profile_id, args.job_id)
        return result, json.dumps(to_primitive(result), indent=2, sort_keys=True)

    if args.command == "applied":
        raise ValidationError(
            "Use `roleloop application submit JOB --follow-up YYYY-MM-DD`; "
            "v1 requires an approved PDF and first follow-up date."
        )
    if args.command == "outcome":
        raise ValidationError(
            "Use `roleloop application stage JOB STAGE --follow-up DATE|--no-follow-up`."
        )
    if args.command == "resume-source":
        if args.resume_source_command == "configure":
            current = _resolve(service.get_resume_source(profile_id))
            source = _service_call(
                service,
                "configure_resume_source",
                profile_id,
                resume_source_draft_from_mapping(
                    {
                        "repository": args.repository,
                        "kind": args.kind,
                        "ref": args.ref,
                        "trust_repository": args.trust_contract,
                    }
                ),
                expected_revision=getattr(current, "revision", None),
                **_command_options(args),
            )
            return (
                source,
                "Configured and trusted the fixed master-résumé contract. "
                "Analyze will sync it automatically; manual sync is also available.",
            )
        if args.resume_source_command == "show":
            source = _resolve(service.get_resume_source(profile_id))
            return source, _render_resume_source(source)
        if args.resume_source_command == "sync":
            evidence = _service_call(
                service,
                "sync_resume_source",
                profile_id,
                progress=progress,
                **_command_options(args),
            )
            revision = getattr(evidence, "source_revision", None) or "unknown revision"
            evidence_id = getattr(evidence, "id", "-")
            return (
                evidence,
                f"Synced master résumé at {revision}; evidence {evidence_id} is active.",
            )
        raise AssertionError(f"Unhandled résumé source command: {args.resume_source_command}")
    raise AssertionError(f"Unhandled command: {args.command}")


def _default_service_factory() -> Any:
    from roleloop.bootstrap import build_service

    return build_service()


def _default_tui_launcher() -> None:
    from roleloop.bootstrap import build_tui_app

    build_tui_app().run()


def exit_code_for(error: ApplicationError) -> int:
    if isinstance(error, ValidationError):
        return 2
    if isinstance(error, NotFoundError):
        return 3
    if isinstance(error, (RevisionConflictError, InvalidTransitionError, ConcurrentInstanceError)):
        return 4
    if isinstance(error, (ProviderUnavailableError, ProviderFailureError, ArtifactError)):
        return 5
    return 1


def main(
    argv: Sequence[str] | None = None,
    *,
    service_factory: ServiceFactory | None = None,
    tui_launcher: Callable[[], None] | None = None,
) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        try:
            (tui_launcher or _default_tui_launcher)()
        except ApplicationError as error:
            print(f"roleloop: {error.message}", file=sys.stderr)
            return exit_code_for(error)
        except Exception:
            print(
                "roleloop: RoleLoop encountered an unexpected failure; rerun Doctor "
                "and inspect the sanitized application history.",
                file=sys.stderr,
            )
            return 1
        else:
            return 0

    args = build_parser().parse_args(arguments)
    as_json = bool(getattr(args, "as_json", False))
    service: Any | None = None
    try:
        service = (service_factory or _default_service_factory)()
        data, human = _dispatch(args, service, StderrProgress(sys.stderr))
    except ApplicationError as error:
        if as_json:
            print(json.dumps(error_envelope(error), sort_keys=True))
        else:
            print(f"roleloop: {error.message}", file=sys.stderr)
        return exit_code_for(error)
    except Exception:  # defensive console boundary
        if as_json:
            print(json.dumps(unexpected_error_envelope(), sort_keys=True))
        print(
            "roleloop: RoleLoop encountered an unexpected failure; rerun Doctor "
            "and inspect the sanitized application history.",
            file=sys.stderr,
        )
        return 1
    finally:
        if service is not None:
            close = getattr(service, "close", None)
            if callable(close):
                close()

    if as_json:
        print(json.dumps(success_envelope(data), sort_keys=True))
    else:
        print(human)
    return 0


__all__ = ["build_parser", "main"]
