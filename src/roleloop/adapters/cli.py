"""Thin headless command adapter and the default Textual entry point."""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import sys
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TextIO, cast

from roleloop.adapters.serialization import to_primitive
from roleloop.application import (
    ApplicationError,
    ArtifactError,
    InboxFilters,
    InvalidTransitionError,
    NotFoundError,
    Page,
    ProgressUpdate,
    ProviderFailureError,
    ProviderUnavailableError,
    ResumeSourceDraft,
    RevisionConflictError,
    ValidationError,
)
from roleloop.domain import Decision, Outcome, ResumeSourceKind

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
    commands = parser.add_subparsers(dest="command", required=True)

    find_parser = commands.add_parser("find", help="Discover jobs for the active profile")
    find_parser.add_argument("--limit", type=positive_int, default=20)

    add_parser = commands.add_parser("add", help="Add a job URL without fetching it")
    add_parser.add_argument("job_url", metavar="JOB_URL")

    inbox_parser = commands.add_parser("inbox", help="List jobs for the active profile")
    inbox_parser.add_argument("--json", action="store_true", dest="as_json")

    review_parser = commands.add_parser("review", help="Read or refresh a detailed job review")
    review_parser.add_argument("job_id", metavar="JOB_ID")
    review_parser.add_argument("--json", action="store_true", dest="as_json")

    decide_parser = commands.add_parser("decide", help="Record a human job decision")
    decide_parser.add_argument("job_id", metavar="JOB_ID")
    decide_parser.add_argument("decision", choices=["tailor", "watch", "skip"])

    applied_parser = commands.add_parser("applied", help="Mark an application submitted")
    applied_parser.add_argument("job_id", metavar="JOB_ID")

    outcome_parser = commands.add_parser("outcome", help="Record an application outcome")
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
        required=True,
        metavar="PATH",
        help="Repository-relative path to the résumé document",
    )
    configure_source_parser.add_argument(
        "--ref",
        default=None,
        metavar="REF",
        help="Git branch, tag, or revision (defaults to HEAD locally and main remotely)",
    )
    configure_source_parser.add_argument("--json", action="store_true", dest="as_json")

    show_source_parser = source_commands.add_parser(
        "show",
        help="Show the active profile's master résumé source",
    )
    show_source_parser.add_argument("--json", action="store_true", dest="as_json")

    sync_source_parser = source_commands.add_parser(
        "sync",
        help="Resolve and activate an immutable master résumé snapshot",
    )
    sync_source_parser.add_argument("--json", action="store_true", dest="as_json")
    return parser


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
    profile_id = _active_profile_id(service)
    if args.command == "find":
        result = _resolve(service.discover_jobs(profile_id, limit=args.limit, progress=progress))
        count = len(result) if isinstance(result, Sequence) else getattr(result, "count", 0)
        return result, f"Discovery complete: {count} job{'s' if count != 1 else ''}."
    if args.command == "add":
        view = _resolve(service.add_job_url(profile_id, args.job_url))
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
    if args.command == "review":
        view = _resolve(service.review_job(profile_id, args.job_id, progress=progress))
        return view, _render_review(view)
    if args.command == "decide":
        view = _resolve(service.decide_job(profile_id, args.job_id, Decision(args.decision)))
        return view, f"Decision recorded: {args.decision}."
    if args.command == "applied":
        view = _resolve(service.mark_applied(profile_id, args.job_id))
        return view, f"Application marked submitted for {args.job_id}."
    if args.command == "outcome":
        view = _resolve(service.record_outcome(profile_id, args.job_id, Outcome(args.outcome)))
        return view, f"Outcome recorded: {args.outcome}."
    if args.command == "resume-source":
        if args.resume_source_command == "configure":
            current = _resolve(service.get_resume_source(profile_id))
            source = _resolve(
                service.configure_resume_source(
                    profile_id,
                    ResumeSourceDraft(
                        repository=args.repository,
                        kind=ResumeSourceKind(args.kind),
                        document_path=args.document_path,
                        ref=args.ref,
                    ),
                    expected_revision=getattr(current, "revision", None),
                )
            )
            return (
                source,
                "Configured master résumé source. Run `roleloop resume-source sync` to import it.",
            )
        if args.resume_source_command == "show":
            source = _resolve(service.get_resume_source(profile_id))
            return source, _render_resume_source(source)
        if args.resume_source_command == "sync":
            evidence = _resolve(service.sync_resume_source(profile_id, progress=progress))
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
    if isinstance(error, (RevisionConflictError, InvalidTransitionError)):
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
        (tui_launcher or _default_tui_launcher)()
        return 0

    args = build_parser().parse_args(arguments)
    as_json = bool(getattr(args, "as_json", False))
    try:
        service = (service_factory or _default_service_factory)()
        data, human = _dispatch(args, service, StderrProgress(sys.stderr))
    except ApplicationError as error:
        if as_json:
            print(json.dumps(error_envelope(error), sort_keys=True))
        else:
            print(f"roleloop: {error.message}", file=sys.stderr)
        return exit_code_for(error)
    except Exception as error:  # defensive console boundary
        if as_json:
            print(json.dumps(unexpected_error_envelope(), sort_keys=True))
        print(f"roleloop: unexpected failure: {error}", file=sys.stderr)
        return 1

    if as_json:
        print(json.dumps(success_envelope(data), sort_keys=True))
    else:
        print(human)
    return 0


__all__ = ["build_parser", "main"]
