from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from roleloop.adapters.cli import main
from roleloop.application import (
    ActiveProfileSummary,
    ConcurrentInstanceError,
    NotFoundError,
    ProgressUpdate,
    ProviderUnavailableError,
    ResumeSourceDraft,
)
from roleloop.application.dto import ApplicationStageDraft, SubmitApplicationDraft
from roleloop.domain import (
    ApplicationStage,
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    RemotePreference,
    ResumeSource,
    ResumeSourceKind,
    ResumeStatus,
    ReviewStatus,
    SearchProfile,
)


@dataclass(frozen=True)
class Item:
    job_id: str = "job-1"
    title: str = "Evidence Engineer"
    company: str = "Casework"
    decision: Decision = Decision.WATCH
    application_status: ApplicationStatus = ApplicationStatus.NOT_SUBMITTED
    review_status: ReviewStatus = ReviewStatus.MISSING
    eligibility_status: EligibilityStatus = EligibilityStatus.UNRESOLVED
    resume_status: ResumeStatus = ResumeStatus.NONE
    updated_at: datetime = datetime(2026, 8, 13, tzinfo=UTC)


@dataclass(frozen=True)
class SyncedEvidence:
    id: str = "evidence-git-1"
    source_revision: str = "abc123"


class FakeService:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.closed = False
        profile = SearchProfile(
            id="profile-1",
            name="Core search",
            target_roles=("Evidence Engineer",),
            remote_preference=RemotePreference.REMOTE,
            is_active=True,
        )
        self.summary: ActiveProfileSummary | None = ActiveProfileSummary(profile, None, {})
        self.resume_source: ResumeSource | None = None

    def close(self) -> None:
        self.closed = True

    def get_active_profile_summary(self) -> ActiveProfileSummary | None:
        return self.summary

    def discover_jobs(self, profile_id: str, *, limit: int, progress: Any) -> tuple[Item, ...]:
        self.calls.append(("discover_jobs", profile_id, limit))
        progress.report(ProgressUpdate("discovery", "complete", "found one", 1, 1))
        return (Item(),)

    def add_job_url(self, profile_id: str, url: str) -> Item:
        self.calls.append(("add_job_url", profile_id, url))
        return Item()

    def inspect_job_url(self, profile_id: str, url: str, *, progress: Any) -> Item:
        self.calls.append(("inspect_job_url", profile_id, url))
        progress.report(ProgressUpdate("scout", "complete", "inspected original page"))
        return Item()

    def list_inbox(self, profile_id: str, **kwargs: Any) -> tuple[Item, ...]:
        self.calls.append(("list_inbox", profile_id, kwargs))
        return (Item(),)

    def review_job(self, profile_id: str, job_id: str, *, progress: Any) -> Item:
        self.calls.append(("review_job", profile_id, job_id, progress))
        return Item(review_status=ReviewStatus.CURRENT)

    def decide_job(self, profile_id: str, job_id: str, decision: Decision) -> Item:
        self.calls.append(("decide_job", profile_id, job_id, decision))
        return Item(decision=decision)

    def get_answer_history(
        self,
        profile_id: str,
        job_id: str,
        question_id: str | None = None,
    ) -> tuple[dict[str, str], ...]:
        self.calls.append(("get_answer_history", profile_id, job_id, question_id))
        return ({"job_id": job_id, "question_id": question_id or "all"},)

    def submit_application(
        self, profile_id: str, job_id: str, draft: SubmitApplicationDraft
    ) -> Item:
        self.calls.append(("submit_application", profile_id, job_id, draft))
        return Item(application_status=ApplicationStatus.SUBMITTED)

    def record_application_stage(
        self, profile_id: str, job_id: str, draft: ApplicationStageDraft
    ) -> Item:
        self.calls.append(("record_application_stage", profile_id, job_id, draft))
        return Item(application_status=ApplicationStatus.SUBMITTED)

    def resolve_followup(
        self,
        profile_id: str,
        follow_up_id: str,
        *,
        note: str = "",
        command_id: str | None = None,
    ) -> dict[str, str]:
        self.calls.append(("resolve_followup", profile_id, follow_up_id, note, command_id))
        return {"follow_up_id": follow_up_id, "disposition": "completed"}

    def reschedule_followup(
        self,
        profile_id: str,
        follow_up_id: str,
        due_at: datetime,
        *,
        note: str = "",
        command_id: str | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            ("reschedule_followup", profile_id, follow_up_id, due_at, note, command_id)
        )
        return {"id": "replacement-follow-up", "due_at": due_at}

    def get_resume_source(self, profile_id: str) -> ResumeSource | None:
        self.calls.append(("get_resume_source", profile_id))
        return self.resume_source

    def configure_resume_source(
        self,
        profile_id: str,
        draft: ResumeSourceDraft,
        *,
        expected_revision: int | None,
    ) -> ResumeSource:
        self.calls.append(("configure_resume_source", profile_id, draft, expected_revision))
        self.resume_source = ResumeSource(
            id="source-1",
            profile_id=profile_id,
            kind=draft.kind,
            repository=draft.repository,
            ref=draft.ref or ("HEAD" if draft.kind is ResumeSourceKind.LOCAL_GIT else "main"),
            document_path=draft.document_path,
            revision=1 if self.resume_source is None else self.resume_source.revision + 1,
        )
        return self.resume_source

    async def sync_resume_source(self, profile_id: str, *, progress: Any) -> SyncedEvidence:
        self.calls.append(("sync_resume_source", profile_id))
        progress.report(
            ProgressUpdate(
                "resume_source_sync",
                "complete",
                "Master résumé snapshot synchronized",
            )
        )
        return SyncedEvidence()

    def preview_legacy_import(self, draft: Any) -> dict[str, Any]:
        self.calls.append(("preview_legacy_import", draft))
        return {
            "source_job_count": draft.source_job_count,
            "source_event_count": draft.source_event_count,
            "sources": draft.sources,
        }

    def apply_legacy_import(
        self, profile_id: str, draft: Any, *, command_id: str | None = None
    ) -> dict[str, Any]:
        self.calls.append(("apply_legacy_import", profile_id, draft, command_id))
        return {"id": "legacy-batch-1", "source_job_count": draft.source_job_count}


def _write_legacy_database(path: Path, *, jobs_table: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state_column = "stage" if jobs_table == "job_runs" else "status"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            f"""
            CREATE TABLE {jobs_table} (
                job_id TEXT PRIMARY KEY,
                canonical_url TEXT NOT NULL UNIQUE,
                company TEXT NOT NULL,
                title TEXT NOT NULL,
                {state_column} TEXT NOT NULL,
                revision INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                node TEXT NOT NULL,
                event_type TEXT NOT NULL,
                detail_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            f"""INSERT INTO {jobs_table}
                (job_id, canonical_url, company, title, {state_column}, revision,
                 state_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "legacy-job",
                f"https://jobs.example.test/{jobs_table}",
                "Example Co",
                "Platform Engineer",
                "review",
                1,
                json.dumps({"job": {"description": "Build reliable services."}}),
                "2026-01-01T00:00:00+00:00",
                "2026-01-02T00:00:00+00:00",
            ),
        )
        connection.execute(
            """INSERT INTO events
               (job_id, occurred_at, node, event_type, detail_json)
               VALUES (?, ?, ?, ?, ?)""",
            (
                "legacy-job",
                "2026-01-02T00:00:00+00:00",
                "reviewer",
                "reviewed",
                "{}",
            ),
        )


def test_no_arguments_launches_tui_without_building_headless_service() -> None:
    launched: list[bool] = []

    def fail_factory() -> None:
        raise AssertionError("headless service should not be built")

    assert main([], service_factory=fail_factory, tui_launcher=lambda: launched.append(True)) == 0
    assert launched == [True]


def test_no_arguments_reports_typed_tui_startup_lock_failure_without_traceback(
    capsys: Any,
) -> None:
    def locked_launcher() -> None:
        raise ConcurrentInstanceError(
            "Another RoleLoop process is already using this data directory."
        )

    assert main([], tui_launcher=locked_launcher) == 4
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "roleloop: Another RoleLoop process is already using this data directory.\n"
    )
    assert "Traceback" not in captured.err


@pytest.mark.parametrize(
    ("arguments", "exit_code"),
    [
        (["--help"], 0),
        (["find", "--limit", "0"], 2),
        (["find", "--limit", "not-a-number"], 2),
        (["decide", "job-1", "maybe"], 2),
        (
            [
                "resume-source",
                "configure",
                "/tmp/resume",
                "--kind",
                "unknown",
                "--document-path",
                "resume.md",
            ],
            2,
        ),
        (["unknown-command"], 2),
    ],
)
def test_help_and_malformed_arguments_never_launch_tui_or_build_service(
    arguments: list[str], exit_code: int
) -> None:
    def fail() -> None:
        raise AssertionError("parser-only paths must not initialize adapters")

    with pytest.raises(SystemExit) as raised:
        main(arguments, service_factory=fail, tui_launcher=fail)
    assert raised.value.code == exit_code


@pytest.mark.parametrize(
    ("arguments", "expected_limit"),
    [(["find"], 20), (["find", "--limit", "7"], 7)],
)
def test_find_uses_default_or_explicit_positive_limit(
    arguments: list[str], expected_limit: int, capsys: Any
) -> None:
    service = FakeService()

    assert main(arguments, service_factory=lambda: service) == 0

    assert service.calls[-1] == ("discover_jobs", "profile-1", expected_limit)
    captured = capsys.readouterr()
    assert captured.out == "Discovery complete: 1 job.\n"
    assert "discovery [complete]: found one" in captured.err


def test_add_routes_the_url_through_explicit_scout_inspection(capsys: Any) -> None:
    service = FakeService()

    assert main(["add", "https://example.com/jobs/42"], service_factory=lambda: service) == 0

    assert service.calls[-1] == (
        "inspect_job_url",
        "profile-1",
        "https://example.com/jobs/42",
    )
    assert capsys.readouterr().out == "Added job job-1.\n"


def test_inbox_json_is_versioned_and_stdout_only(capsys: Any) -> None:
    service = FakeService()

    assert main(["inbox", "--json"], service_factory=lambda: service) == 0

    captured = capsys.readouterr()
    envelope = json.loads(captured.out)
    assert envelope["schema_version"] == 1
    assert envelope["data"][0]["job_id"] == "job-1"
    assert envelope["data"][0]["updated_at"] == "2026-08-13T00:00:00Z"
    assert captured.err == ""


def test_review_supports_a_synchronous_service(capsys: Any) -> None:
    service = FakeService()

    assert main(["review", "job-1"], service_factory=lambda: service) == 0

    assert service.calls[-1][:3] == ("review_job", "profile-1", "job-1")
    assert "Review: current" in capsys.readouterr().out


def test_async_review_keeps_progress_on_stderr_and_json_on_stdout(capsys: Any) -> None:
    class AsyncReviewService(FakeService):
        async def review_job(self, profile_id: str, job_id: str, *, progress: Any) -> Item:
            self.calls.append(("review_job", profile_id, job_id))
            progress.report(ProgressUpdate("review", "analyzing", "checking evidence"))
            return Item(review_status=ReviewStatus.CURRENT)

    service = AsyncReviewService()
    assert main(["review", "job-1", "--json"], service_factory=lambda: service) == 0

    captured = capsys.readouterr()
    assert json.loads(captured.out)["data"]["review_status"] == "current"
    assert captured.err == "review [analyzing]: checking evidence\n"


def test_async_review_provider_failure_uses_json_error_contract(capsys: Any) -> None:
    class UnavailableReviewService(FakeService):
        async def review_job(self, profile_id: str, job_id: str, *, progress: Any) -> Item:
            del profile_id, job_id, progress
            raise ProviderUnavailableError("Review analyzer is not configured")

    assert (
        main(
            ["review", "job-1", "--json"],
            service_factory=UnavailableReviewService,
        )
        == 5
    )
    captured = capsys.readouterr()
    assert json.loads(captured.out)["error"] == {
        "code": "provider_unavailable",
        "details": {},
        "message": "Review analyzer is not configured",
    }
    assert captured.err == ""


def test_answer_history_dispatches_each_identifier_once(capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            ["answer-history", "job-1", "question-1", "--json"],
            service_factory=lambda: service,
        )
        == 0
    )

    assert service.calls[-1] == (
        "get_answer_history",
        "profile-1",
        "job-1",
        "question-1",
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["data"] == [{"job_id": "job-1", "question_id": "question-1"}]


@pytest.mark.parametrize("decision", [Decision.TAILOR, Decision.WATCH, Decision.SKIP])
def test_decide_maps_every_cli_value_to_domain_enum(decision: Decision, capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            ["decide", "job-1", decision.value],
            service_factory=lambda: service,
        )
        == 0
    )

    assert service.calls[-1] == ("decide_job", "profile-1", "job-1", decision)
    assert f"Decision recorded: {decision.value}" in capsys.readouterr().out


def test_application_submit_requires_and_maps_first_follow_up(capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            ["application", "submit", "job-1", "--follow-up", "2026-08-20"],
            service_factory=lambda: service,
        )
        == 0
    )

    call = service.calls[-1]
    assert call[:3] == ("submit_application", "profile-1", "job-1")
    assert isinstance(call[3], SubmitApplicationDraft)
    assert call[3].follow_up_at.isoformat() == "2026-08-20T00:00:00-05:00"
    assert "Recorded manual submission" in capsys.readouterr().out


def test_application_stage_maps_fixed_stage_and_explicit_no_follow_up(capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            [
                "application",
                "stage",
                "job-1",
                "technical_interview",
                "--no-follow-up",
            ],
            service_factory=lambda: service,
        )
        == 0
    )

    call = service.calls[-1]
    assert call[:3] == ("record_application_stage", "profile-1", "job-1")
    assert call[3] == ApplicationStageDraft(
        stage=ApplicationStage.TECHNICAL_INTERVIEW,
        no_follow_up=True,
    )
    assert "Recorded application stage technical_interview" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("arguments", "expected_prefix"),
    [
        (
            [
                "followups",
                "resolve",
                "follow-up-1",
                "--note",
                "Acknowledged",
                "--command-id",
                "resolve-1",
            ],
            (
                "resolve_followup",
                "profile-1",
                "follow-up-1",
                "Acknowledged",
                "resolve-1",
            ),
        ),
        (
            [
                "followups",
                "reschedule",
                "follow-up-1",
                "2026-08-27",
                "--note",
                "Wait",
                "--command-id",
                "reschedule-1",
            ],
            (
                "reschedule_followup",
                "profile-1",
                "follow-up-1",
                datetime.fromisoformat("2026-08-27T00:00:00-05:00"),
                "Wait",
                "reschedule-1",
            ),
        ),
    ],
)
def test_followup_commands_dispatch_the_active_profile(
    arguments: list[str], expected_prefix: tuple[Any, ...], capsys: Any
) -> None:
    service = FakeService()

    assert main(arguments, service_factory=lambda: service) == 0

    assert service.calls[-1] == expected_prefix
    assert "follow-up-1" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("arguments", "replacement"),
    [
        (["applied", "job-1"], "application submit"),
        (["outcome", "job-1", "offer"], "application stage"),
    ],
)
def test_pre_v1_application_aliases_fail_with_policy_guidance(
    arguments: list[str], replacement: str, capsys: Any
) -> None:
    assert main(arguments, service_factory=FakeService) == 2
    assert replacement in capsys.readouterr().err


def test_resume_source_configure_maps_explicit_git_settings(capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            [
                "resume-source",
                "configure",
                "/work/master-resume",
                "--kind",
                "local_git",
                "--document-path",
                "resume/master.md",
                "--ref",
                "release",
                "--trust-contract",
            ],
            service_factory=lambda: service,
        )
        == 0
    )

    assert service.calls[-1] == (
        "configure_resume_source",
        "profile-1",
        ResumeSourceDraft(
            repository="/work/master-resume",
            kind=ResumeSourceKind.LOCAL_GIT,
            document_path="roleloop_contract/v1/cli.py",
            ref="release",
            trust_repository=True,
        ),
        None,
    )
    output = capsys.readouterr().out
    assert "Configured and trusted the fixed master-résumé contract" in output
    assert "Analyze will sync it automatically" in output


def test_resume_source_reconfigure_passes_optimistic_revision(capsys: Any) -> None:
    service = FakeService()
    service.resume_source = ResumeSource(
        id="source-1",
        profile_id="profile-1",
        kind=ResumeSourceKind.REMOTE_GIT,
        repository="https://example.test/old.git",
        ref="main",
        document_path="resume.md",
        revision=4,
    )

    assert (
        main(
            [
                "resume-source",
                "configure",
                "git@example.test:team/resume.git",
                "--kind",
                "remote_git",
                "--document-path",
                "cv/resume.md",
                "--trust-contract",
            ],
            service_factory=lambda: service,
        )
        == 0
    )

    assert service.calls[-1][-1] == 4
    assert capsys.readouterr().err == ""


def test_resume_source_show_json_is_versioned(capsys: Any) -> None:
    service = FakeService()
    service.resume_source = ResumeSource(
        id="source-1",
        profile_id="profile-1",
        kind=ResumeSourceKind.REMOTE_GIT,
        repository="https://example.test/resume.git",
        ref="main",
        document_path="resume.md",
        last_synced_revision="deadbeef",
    )

    assert (
        main(
            ["resume-source", "show", "--json"],
            service_factory=lambda: service,
        )
        == 0
    )

    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert data["schema_version"] == 1
    assert data["data"]["kind"] == "remote_git"
    assert data["data"]["last_synced_revision"] == "deadbeef"
    assert captured.err == ""


def test_resume_source_sync_supports_async_progress_and_json(capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            ["resume-source", "sync", "--json"],
            service_factory=lambda: service,
        )
        == 0
    )

    captured = capsys.readouterr()
    assert json.loads(captured.out)["data"] == {
        "id": "evidence-git-1",
        "source_revision": "abc123",
    }
    assert service.calls[-1] == ("sync_resume_source", "profile-1")
    assert "resume_source_sync [complete]" in captured.err


def test_legacy_preview_reads_both_manifests_without_mutating_sources(
    tmp_path: Path, capsys: Any
) -> None:
    first = tmp_path / ".job-agent" / "state.sqlite3"
    second = tmp_path / ".job-agent" / "state-v2.sqlite3"
    _write_legacy_database(first, jobs_table="job_runs")
    _write_legacy_database(second, jobs_table="jobs")
    before = {path: path.read_bytes() for path in (first, second)}
    service = FakeService()

    assert (
        main(
            ["legacy", "import-master-state", str(tmp_path), "--preview", "--json"],
            service_factory=lambda: service,
        )
        == 0
    )

    payload = json.loads(capsys.readouterr().out)["data"]
    assert payload["source_job_count"] == 2
    assert payload["source_event_count"] == 2
    assert [source["database_name"] for source in payload["sources"]] == [
        "state.sqlite3",
        "state-v2.sqlite3",
    ]
    assert service.calls[-1][0] == "preview_legacy_import"
    assert {path: path.read_bytes() for path in (first, second)} == before


def test_legacy_apply_can_use_configured_local_repository_and_command_id(
    tmp_path: Path, capsys: Any
) -> None:
    database = tmp_path / ".job-agent" / "state-v2.sqlite3"
    _write_legacy_database(database, jobs_table="jobs")
    before = database.read_bytes()
    service = FakeService()
    service.resume_source = ResumeSource(
        id="source-1",
        profile_id="profile-1",
        kind=ResumeSourceKind.LOCAL_GIT,
        repository=str(tmp_path),
        ref="HEAD",
        document_path="roleloop_contract/v1/cli.py",
    )

    assert (
        main(
            [
                "legacy",
                "import-master-state",
                "--apply",
                "--command-id",
                "legacy-import-1",
            ],
            service_factory=lambda: service,
        )
        == 0
    )

    call = service.calls[-1]
    assert call[0:2] == ("apply_legacy_import", "profile-1")
    assert call[2].source_job_count == 1
    assert call[3] == "legacy-import-1"
    assert "original databases were left unchanged" in capsys.readouterr().out
    assert database.read_bytes() == before


def test_no_profile_returns_onboarding_validation_error(capsys: Any) -> None:
    service = FakeService()
    service.summary = None

    assert main(["inbox", "--json"], service_factory=lambda: service) == 2

    captured = capsys.readouterr()
    error = json.loads(captured.out)["error"]
    assert error["code"] == "validation_error"
    assert "onboarding" in error["message"]
    assert captured.err == ""


def test_json_errors_use_stable_envelope(capsys: Any) -> None:
    class MissingService(FakeService):
        def list_inbox(self, profile_id: str, **kwargs: Any) -> tuple[Item, ...]:
            del profile_id, kwargs
            raise NotFoundError("Profile disappeared")

    assert main(["inbox", "--json"], service_factory=MissingService) == 3
    envelope = json.loads(capsys.readouterr().out)
    assert envelope == {
        "schema_version": 1,
        "error": {
            "code": "not_found",
            "details": {},
            "message": "Profile disappeared",
        },
    }


def test_cli_releases_service_ownership_after_success_and_failure(capsys: Any) -> None:
    successful = FakeService()
    assert main(["inbox", "--json"], service_factory=lambda: successful) == 0
    assert successful.closed is True

    class MissingService(FakeService):
        def list_inbox(self, profile_id: str, **kwargs: Any) -> tuple[Item, ...]:
            del profile_id, kwargs
            raise NotFoundError("Profile disappeared")

    failed = MissingService()
    assert main(["inbox", "--json"], service_factory=lambda: failed) == 3
    assert failed.closed is True
    capsys.readouterr()


def test_unexpected_json_failure_still_emits_a_machine_envelope(capsys: Any) -> None:
    secret = "sk-proj-FAKE-NEVER-LOG-THIS"

    class BrokenService(FakeService):
        def list_inbox(self, profile_id: str, **kwargs: Any) -> tuple[Item, ...]:
            del profile_id, kwargs
            raise RuntimeError(f"database cable unplugged while using {secret}")

    assert main(["inbox", "--json"], service_factory=BrokenService) == 1

    captured = capsys.readouterr()
    assert json.loads(captured.out) == {
        "schema_version": 1,
        "error": {
            "code": "unexpected_error",
            "details": {},
            "message": "RoleLoop encountered an unexpected failure.",
        },
    }
    assert "unexpected failure" in captured.err.lower()
    assert secret not in captured.out
    assert secret not in captured.err
