"""Focused headless tests for RoleLoop's Textual adapter."""

from __future__ import annotations

import asyncio
from pathlib import Path

from textual.widgets import (
    Button,
    ContentSwitcher,
    DataTable,
    Input,
    Select,
    Static,
    TabbedContent,
    TextArea,
)

from roleloop.adapters.tui.app import RoleLoopApp
from roleloop.adapters.tui.facade import ApplicationServiceFacade
from roleloop.adapters.tui.modals import (
    ConfirmActionModal,
    EvidencePathModal,
    OutcomeModal,
    ProfileModal,
    QuestionAnswerModal,
)
from roleloop.adapters.tui.review import JobReviewScreen
from roleloop.adapters.tui.workspace import WorkspaceScreen
from roleloop.application import JobDetails, ProfileDraft, RoleLoopService
from roleloop.domain import Decision, EligibilityStatus, ResumeStatus, ReviewStatus
from roleloop.infrastructure import (
    FileSystemArtifactStore,
    LocalEvidenceExtractor,
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
    SystemClock,
    UUID4Generator,
)

from .fakes import FakeFacade, OnboardingFacade, ProfileManagementFacade, provider_error


async def settle(app: RoleLoopApp, pilot: object) -> None:
    """Drain Textual messages and all currently registered workers."""

    await pilot.pause()  # type: ignore[attr-defined]
    await app.workers.wait_for_complete()
    await pilot.pause()  # type: ignore[attr-defined]
    await app.workers.wait_for_complete()
    await pilot.pause()  # type: ignore[attr-defined]


async def open_review(app: RoleLoopApp, pilot: object) -> JobReviewScreen:
    table = app.screen.query_one("#job-table", DataTable)
    table.focus()
    await pilot.press("enter")  # type: ignore[attr-defined]
    await settle(app, pilot)
    assert isinstance(app.screen, JobReviewScreen)
    return app.screen


async def test_boots_inbox_and_switches_workspace_views() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(80, 24)) as pilot:
        await settle(app, pilot)

        assert isinstance(app.screen, WorkspaceScreen)
        assert app.screen.has_class("compact")
        assert app.screen.query_one("#job-table", DataTable).row_count == 1

        await pilot.press("f")
        await pilot.pause()
        assert app.screen.query_one("#inbox-view").has_class("filters-open")
        await pilot.press("f")
        await pilot.press("/")
        await pilot.pause()
        assert app.screen.query_one("#inbox-view").has_class("filters-open")
        assert app.focused is app.screen.query_one("#inbox-search", Input)
        switcher = app.screen.query_one("#workspace-content", ContentSwitcher)

        # Workspace commands stay inert while a text field owns the keystroke.
        await pilot.press("3")
        await pilot.pause()
        assert switcher.current == "inbox-view"
        app.screen.query_one("#job-table", DataTable).focus()
        await pilot.press("3")
        await settle(app, pilot)
        assert switcher.current == "settings-view"
        assert app.screen.query_one("#profiles-table", DataTable).row_count == 1

        await pilot.press("1")
        await pilot.pause()
        assert switcher.current == "inbox-view"


async def test_tailor_is_separate_from_confirmed_generation() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)

        assert review.query_one("#evidence-ledger")
        support = str(review.query_one("#evidence-support", Static).render())
        skeptic = str(review.query_one("#evidence-skeptic", Static).render())
        assert "CASE FOR" in support
        assert "Strong Python background" in support
        assert "SKEPTIC'S CASE" in skeptic
        assert "Scale is not quantified" in skeptic

        await pilot.press("t")
        await settle(app, pilot)
        assert facade.case.decision is Decision.TAILOR
        assert not [call for call in facade.calls if call[0] == "generate_resume"]

        await pilot.press("g")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.press("escape")
        await pilot.pause()
        assert not [call for call in facade.calls if call[0] == "generate_resume"]

        await pilot.press("g")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)

        assert facade.resume_status is ResumeStatus.READY
        assert [call for call in facade.calls if call[0] == "generate_resume"] == [
            ("generate_resume", "job-1")
        ]
        assert "tailored.pdf" in str(review.query_one("#resume-status", Static).render())


async def test_required_question_gates_generation_and_saves_typed_answer() -> None:
    facade = FakeFacade(
        decision=Decision.TAILOR,
        eligibility=EligibilityStatus.UNRESOLVED,
    )
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)
        assert review.query_one("#review-outcome", Button).disabled
        assert review.query_one("#review-generate", Button).disabled

        review.query_one("#review-tabs", TabbedContent).active = "questions-tab"
        questions = review.query_one("#questions-table", DataTable)
        questions.focus()
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, QuestionAnswerModal)

        app.screen.query_one("#question-answer", Select).value = "yes"
        await pilot.click("#question-save")
        await settle(app, pilot)

        assert facade.answers["question-1"].value == "yes"
        assert facade.eligibility is EligibilityStatus.ELIGIBLE
        assert not review.query_one("#review-generate", Button).disabled


async def test_skip_and_evidence_replacement_both_require_confirmation() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        await open_review(app, pilot)

        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.press("escape")
        await pilot.pause()
        assert facade.case.decision is Decision.UNDECIDED

        await pilot.press("s")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert facade.case.decision is Decision.SKIP

        await pilot.press("escape")
        await pilot.pause()
        assert isinstance(app.screen, WorkspaceScreen)
        await pilot.press("3")
        await settle(app, pilot)

        await pilot.click("#evidence-import")
        await pilot.pause()
        assert isinstance(app.screen, EvidencePathModal)
        app.screen.query_one("#evidence-path", Input).value = "/tmp/new-resume.pdf"
        await pilot.click("#path-continue")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.press("escape")
        await pilot.pause()
        assert facade.imported_paths == []

        await pilot.click("#evidence-import")
        await pilot.pause()
        app.screen.query_one("#evidence-path", Input).value = "/tmp/new-resume.pdf"
        await pilot.click("#path-continue")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert facade.imported_paths == ["/tmp/new-resume.pdf"]


async def test_marking_submitted_requires_confirmation() -> None:
    facade = FakeFacade(decision=Decision.WATCH)
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)

        await pilot.press("a")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.press("escape")
        await pilot.pause()
        assert not [call for call in facade.calls if call[0] == "mark_applied"]

        await pilot.press("a")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)

        assert [call for call in facade.calls if call[0] == "mark_applied"] == [
            ("mark_applied", "job-1")
        ]
        assert review.query_one("#review-skip", Button).disabled
        assert review.query_one("#review-applied", Button).disabled
        assert not review.query_one("#review-outcome", Button).disabled


async def test_missing_review_analyzes_and_provider_error_keeps_state() -> None:
    facade = FakeFacade(
        decision=Decision.TAILOR,
        review_status=ReviewStatus.MISSING,
    )
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)
        await settle(app, pilot)
        assert facade.review_status is ReviewStatus.CURRENT
        assert [call for call in facade.calls if call[0] == "review_job"]

        facade.generate_error = provider_error()
        await pilot.press("g")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)

        assert facade.resume_run is None
        assert "not configured" in str(review.query_one("#review-error", Static).render()).lower()
        assert app.active_operations == {}


async def test_first_run_onboarding_can_import_pasted_evidence() -> None:
    facade = OnboardingFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(100, 32)) as pilot:
        await pilot.pause()
        assert app.screen.__class__.__name__ == "ProfileModal"
        app.screen.query_one("#profile-name", Input).value = "Platform search"
        app.screen.query_one("#profile-roles", Input).value = "Staff Platform Engineer"
        await pilot.click("#profile-save")
        await pilot.pause()
        await pilot.pause()

        assert isinstance(app.screen, EvidencePathModal)
        app.screen.query_one("#evidence-kind", Select).value = "text"
        app.screen.query_one("#evidence-source-name", Input).value = "resume.txt"
        app.screen.query_one("#evidence-text", TextArea).load_text(
            "Staff engineer building reliable Python platforms."
        )
        await pilot.click("#path-continue")
        await settle(app, pilot)

        assert isinstance(app.screen, WorkspaceScreen)
        assert facade.imported_requests == [
            {
                "kind": "text",
                "text": "Staff engineer building reliable Python platforms.",
                "source_name": "resume.txt",
            }
        ]


async def test_generation_worker_keeps_navigation_responsive_and_is_singleton() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    facade.generation_gate = asyncio.Event()
    facade.generation_started = asyncio.Event()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)
        await pilot.press("g")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await asyncio.wait_for(facade.generation_started.wait(), timeout=1)
        await pilot.pause()

        assert "drafting" in str(review.query_one("#review-operation", Static).render()).lower()
        assert not app.start_operation(
            "generate:job-1",
            "Generate résumé",
            "generate_resume",
            "job-1",
            job_id="job-1",
        )

        await pilot.press("escape")
        await pilot.press("2")
        await pilot.pause()
        assert isinstance(app.screen, WorkspaceScreen)
        assert (
            app.screen.query_one("#workspace-content", ContentSwitcher).current
            == "applications-view"
        )

        facade.generation_gate.set()
        await settle(app, pilot)
        assert facade.resume_status is ResumeStatus.READY
        assert len([call for call in facade.calls if call[0] == "generate_resume"]) == 1


async def test_failed_generation_surfaces_blocking_validation_without_success() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    facade.generation_returns_failed = True
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)
        await pilot.press("g")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)

        assert facade.resume_status is ResumeStatus.FAILED
        error = str(review.query_one("#review-error", Static).render()).lower()
        assert "blocking validation" in error
        operation = str(review.query_one("#review-operation", Static).render()).lower()
        assert "complete" not in operation
        assert "blocking validation" in operation
        assert app.active_operations == {}


async def test_application_ledger_shows_artifact_and_records_outcome() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    await facade.generate_resume("job-1")
    facade.mark_applied("job-1")
    facade.calls.clear()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        await pilot.press("2")
        await settle(app, pilot)

        table = app.screen.query_one("#applications-table", DataTable)
        assert table.row_count == 1
        row = [str(cell) for cell in table.get_row_at(0)]
        assert row[2] == "artifact-resume"

        await pilot.click("#record-outcome")
        await pilot.pause()
        assert isinstance(app.screen, OutcomeModal)
        app.screen.query_one("#outcome-value", Select).value = "offer"
        await pilot.click("#outcome-save")
        await settle(app, pilot)

        assert ("record_outcome", "job-1", "offer") in facade.calls


async def test_settings_create_edit_and_activate_profile() -> None:
    facade = ProfileManagementFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 40)) as pilot:
        await settle(app, pilot)
        await pilot.press("3")
        await settle(app, pilot)
        profiles = app.screen.query_one("#profiles-table", DataTable)
        assert profiles.row_count == 2
        assert "base-resume.pdf" in str(app.screen.query_one("#settings-summary", Static).render())

        await pilot.click("#profile-create")
        await pilot.pause()
        assert isinstance(app.screen, ProfileModal)
        app.screen.query_one("#profile-name", Input).value = "Data platform search"
        app.screen.query_one("#profile-roles", Input).value = "Staff Data Engineer"
        await pilot.click("#profile-save")
        await settle(app, pilot)
        assert profiles.row_count == 3

        profiles.focus()
        profiles.move_cursor(row=2)
        await pilot.pause()
        await pilot.click("#profile-edit")
        await pilot.pause()
        assert isinstance(app.screen, ProfileModal)
        app.screen.query_one("#profile-name", Input).value = "Principal data search"
        await pilot.click("#profile-save")
        await settle(app, pilot)
        assert any(call[:2] == ("update_profile", "profile-3") for call in facade.calls)

        profiles.focus()
        profiles.move_cursor(row=2)
        await pilot.pause()
        assert profiles.cursor_row == 2
        assert (
            str(profiles.coordinate_to_cell_key(profiles.cursor_coordinate).row_key.value)
            == "profile-3"
        )
        await pilot.press("a")
        await settle(app, pilot)
        assert facade.profile.id == "profile-3"
        assert sum(profile.is_active for profile in facade.profile_list) == 1


async def test_real_service_sqlite_state_remains_authoritative(tmp_path: Path) -> None:
    ids = UUID4Generator()
    service = RoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3")),
        SystemClock(),
        ids,
        evidence_extractor=LocalEvidenceExtractor(),
        artifact_store=FileSystemArtifactStore(tmp_path / "artifacts", id_generator=ids),
    )
    profile = service.create_profile(
        ProfileDraft(name="Persisted search", target_roles=("Platform Engineer",))
    )
    case = service.add_job_url(profile.id, "https://example.test/jobs/platform")
    job = service.get_job_case(profile.id, case.job_id).job
    service.update_job_details(
        profile.id,
        job.id,
        JobDetails(title="Platform Engineer", company="Durable Systems"),
        expected_revision=job.revision,
    )
    app = RoleLoopApp(ApplicationServiceFacade(service))

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        table = app.screen.query_one("#job-table", DataTable)
        assert table.row_count == 1
        assert "Platform Engineer / Durable Systems" in str(table.get_row_at(0)[0])

        table.focus()
        await pilot.press("w")
        await settle(app, pilot)

        persisted = service.get_job_case(profile.id, job.id)
        assert persisted.case.decision is Decision.WATCH
        assert str(table.get_row_at(0)[3]) == "watch"
