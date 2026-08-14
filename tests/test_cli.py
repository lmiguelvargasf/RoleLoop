from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pytest

from roleloop.adapters.cli import main
from roleloop.application import (
    ActiveProfileSummary,
    NotFoundError,
    ProgressUpdate,
    ProviderUnavailableError,
)
from roleloop.domain import (
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    Outcome,
    RemotePreference,
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


class FakeService:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        profile = SearchProfile(
            id="profile-1",
            name="Core search",
            target_roles=("Evidence Engineer",),
            remote_preference=RemotePreference.REMOTE,
            is_active=True,
        )
        self.summary: ActiveProfileSummary | None = ActiveProfileSummary(profile, None, {})

    def get_active_profile_summary(self) -> ActiveProfileSummary | None:
        return self.summary

    def discover_jobs(self, profile_id: str, *, limit: int, progress: Any) -> tuple[Item, ...]:
        self.calls.append(("discover_jobs", profile_id, limit))
        progress.report(ProgressUpdate("discovery", "complete", "found one", 1, 1))
        return (Item(),)

    def add_job_url(self, profile_id: str, url: str) -> Item:
        self.calls.append(("add_job_url", profile_id, url))
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

    def mark_applied(self, profile_id: str, job_id: str) -> Item:
        self.calls.append(("mark_applied", profile_id, job_id))
        return Item(application_status=ApplicationStatus.SUBMITTED)

    def record_outcome(self, profile_id: str, job_id: str, outcome: Outcome) -> Item:
        self.calls.append(("record_outcome", profile_id, job_id, outcome))
        return Item(application_status=ApplicationStatus.SUBMITTED)


def test_no_arguments_launches_tui_without_building_headless_service() -> None:
    launched: list[bool] = []

    def fail_factory() -> None:
        raise AssertionError("headless service should not be built")

    assert main([], service_factory=fail_factory, tui_launcher=lambda: launched.append(True)) == 0
    assert launched == [True]


@pytest.mark.parametrize(
    ("arguments", "exit_code"),
    [
        (["--help"], 0),
        (["find", "--limit", "0"], 2),
        (["find", "--limit", "not-a-number"], 2),
        (["decide", "job-1", "maybe"], 2),
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


def test_add_passes_the_url_without_fetching(capsys: Any) -> None:
    service = FakeService()

    assert main(["add", "https://example.com/jobs/42"], service_factory=lambda: service) == 0

    assert service.calls[-1] == (
        "add_job_url",
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


def test_applied_maps_to_submission_workflow(capsys: Any) -> None:
    service = FakeService()

    assert main(["applied", "job-1"], service_factory=lambda: service) == 0

    assert service.calls[-1] == ("mark_applied", "profile-1", "job-1")
    assert "Application marked submitted" in capsys.readouterr().out


@pytest.mark.parametrize("outcome", list(Outcome))
def test_outcome_maps_every_supported_value(outcome: Outcome, capsys: Any) -> None:
    service = FakeService()

    assert (
        main(
            ["outcome", "job-1", outcome.value],
            service_factory=lambda: service,
        )
        == 0
    )

    assert service.calls[-1] == ("record_outcome", "profile-1", "job-1", outcome)
    assert f"Outcome recorded: {outcome.value}" in capsys.readouterr().out


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


def test_unexpected_json_failure_still_emits_a_machine_envelope(capsys: Any) -> None:
    class BrokenService(FakeService):
        def list_inbox(self, profile_id: str, **kwargs: Any) -> tuple[Item, ...]:
            del profile_id, kwargs
            raise RuntimeError("database cable unplugged")

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
    assert "unexpected failure: database cable unplugged" in captured.err
