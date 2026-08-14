"""Headless pilots for the authoritative RoleLoop v1 Textual workflow."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from textual.widgets import (
    Button,
    Checkbox,
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
    AddJobModal,
    ApplicationStageModal,
    ConfirmActionModal,
    ExportPathModal,
    FollowUpRescheduleModal,
    ProfileModal,
    QuestionAnswerModal,
    ResumeFeedbackModal,
    ResumeSourceModal,
    SubmissionModal,
)
from roleloop.adapters.tui.review import JobReviewScreen
from roleloop.adapters.tui.workspace import WorkspaceScreen
from roleloop.application import JobDetails, ProfileDraft, RoleLoopService
from roleloop.domain import (
    AgentProvider,
    Decision,
    EligibilityStatus,
    ResumeExperienceSelection,
    ResumeStatus,
    ReviewStatus,
)
from roleloop.infrastructure import (
    FileSystemArtifactStore,
    LocalEvidenceExtractor,
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
    SystemClock,
    UUID4Generator,
)

from .fakes import FakeFacade, OnboardingFacade, ProfileManagementFacade


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
        assert app.focused is app.screen.query_one("#inbox-search", Input)
        switcher = app.screen.query_one("#workspace-content", ContentSwitcher)

        await pilot.press("3")
        await pilot.pause()
        assert switcher.current == "inbox-view"

        app.screen.query_one("#job-table", DataTable).focus()
        await pilot.press("3")
        await settle(app, pilot)
        assert switcher.current == "settings-view"
        assert app.screen.query_one("#profiles-table", DataTable).row_count == 1

    assert facade.closed is True


def test_workspace_help_documents_authoritative_v1_actions() -> None:
    help_text = WorkspaceScreen.HELP_TEXT

    for action in (
        "Scout discovery",
        "inspect job URL",
        "Analyze/Rerun",
        "request changes",
        "approve exact PDF",
        "record submission",
        "record stage",
    ):
        assert action in help_text
    assert "generate" not in help_text.lower()
    assert "outcome" not in help_text.lower()


async def test_scout_discovery_and_url_inspection_are_explicit_actions() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 50)) as pilot:
        await settle(app, pilot)
        await pilot.press("d")
        await settle(app, pilot)
        assert ("discover_jobs",) in facade.calls

        await pilot.press("n")
        await pilot.pause()
        assert isinstance(app.screen, AddJobModal)
        app.screen.query_one("#job-url", Input).value = "https://jobs.example.test/role-42"
        app.screen.query_one("#job-title", Input).value = "Applied AI Engineer"
        await pilot.click("#form-submit")
        await settle(app, pilot)
        assert (
            "add_job",
            "https://jobs.example.test/role-42",
            {
                "title": "Applied AI Engineer",
                "company": "",
                "location": "",
                "description": "",
            },
        ) in facade.calls


async def test_explicit_analyze_answer_rerun_and_tailor_immediately_generates() -> None:
    facade = FakeFacade(
        eligibility=EligibilityStatus.UNRESOLVED,
        review_status=ReviewStatus.MISSING,
    )
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 40)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)

        assert not [call for call in facade.calls if call[0] == "review_job"]
        assert review.query_one("#review-tailor", Button).disabled

        await pilot.click("#review-analyze")
        await settle(app, pilot)
        assert ("review_job", "job-1", False) in facade.calls
        assert review.query_one("#review-tailor", Button).disabled

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
        assert facade.review_status is ReviewStatus.STALE
        assert review.query_one("#review-tailor", Button).disabled

        await pilot.click("#review-analyze")
        await settle(app, pilot)
        assert facade.review_status is ReviewStatus.CURRENT
        assert not review.query_one("#review-tailor", Button).disabled

        await pilot.click("#review-tailor")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.click("#confirm-action")
        await settle(app, pilot)

        assert facade.case.decision is Decision.TAILOR
        assert facade.resume_status is ResumeStatus.READY
        assert ("decide_job", "job-1", "tailor") in facade.calls
        assert review.query_one("#review-tailor", Button).disabled
        status = str(review.query_one("#resume-status", Static).render())
        assert "run-1.pdf" in status
        assert "sample.claim.reliable" in status


async def test_gate_two_revision_approval_submission_and_stage_controls() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    original = await facade.generate_resume("job-1")
    facade.calls.clear()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 42)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)

        await pilot.click("#review-revise")
        await pilot.pause()
        assert isinstance(app.screen, ResumeFeedbackModal)
        app.screen.query_one("#resume-feedback", TextArea).load_text(
            "Lead with the strongest exact production evidence."
        )
        await pilot.click("#resume-feedback-save")
        await settle(app, pilot)

        assert facade.resume_run is not None
        assert facade.resume_run.parent_resume_run_id == original.id
        expected_revision = (
            "revise_resume",
            "job-1",
            "Lead with the strongest exact production evidence.",
        )
        assert expected_revision in facade.calls

        child_id = facade.resume_run.id
        await pilot.click("#review-approve")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        assert facade.resume_run.artifact is not None
        assert facade.resume_run.artifact.checksum in str(
            app.screen.query_one("#confirm-body", Static).render()
        )
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert ("approve_resume", "job-1", child_id) in facade.calls
        assert not review.query_one("#review-submit", Button).disabled

        await pilot.click("#review-submit")
        await pilot.pause()
        assert isinstance(app.screen, SubmissionModal)
        app.screen.query_one("#submission-follow-up", Input).value = "2026-08-21"
        app.screen.query_one("#submission-note", Input).value = "Check for acknowledgement"
        await pilot.click("#submission-save")
        await settle(app, pilot)

        assert (
            "submit_application",
            "job-1",
            "2026-08-21",
            "Check for acknowledgement",
        ) in facade.calls
        assert not review.query_one("#review-stage", Button).disabled

        await pilot.click("#review-stage")
        await pilot.pause()
        assert isinstance(app.screen, ApplicationStageModal)
        app.screen.query_one("#application-stage", Select).value = "technical_interview"
        app.screen.query_one("#application-follow-up-choice", Select).value = "none"
        await pilot.click("#application-stage-save")
        await settle(app, pilot)

        stage_calls = [call for call in facade.calls if call[0] == "record_application_stage"]
        assert stage_calls[-1][2] == {
            "stage": "technical_interview",
            "follow_up": None,
            "no_follow_up": True,
            "note": "",
        }


async def test_resume_lineage_shows_complete_ordered_exact_selection_diff() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    generated_parent = await facade.generate_resume("job-1")
    parent = replace(
        generated_parent,
        headline="Platform Engineer",
        selected_experiences=(
            ResumeExperienceSelection("sample", ("sample.a", "sample.b")),
            ResumeExperienceSelection("legacy", ("legacy.a",)),
        ),
        selected_bullet_ids=("sample.a", "sample.b", "legacy.a"),
        selected_skill_ids=("skill.python", "skill.sql"),
    )
    child = replace(
        parent,
        id="run-2",
        parent_resume_run_id=parent.id,
        headline="Applied AI Engineer",
        selected_experiences=(
            ResumeExperienceSelection("secondary", ("secondary.a",)),
            ResumeExperienceSelection("sample", ("sample.b", "sample.c")),
        ),
        selected_bullet_ids=("secondary.a", "sample.b", "sample.c"),
        selected_skill_ids=("skill.sql", "skill.rust"),
    )
    facade.resume_runs = [parent, child]
    facade.resume_run = child
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 48)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)
        review.query_one("#review-tabs", TabbedContent).active = "resume-tab"
        await pilot.pause()
        rendered = str(review.query_one("#resume-status", Static).render())

    for expected in (
        'headline: "Platform Engineer" -> "Applied AI Engineer"',
        "experience order: sample, legacy -> secondary, sample",
        "experiences + secondary",
        "experiences - legacy",
        "sample bullet order: sample.a, sample.b -> sample.b, sample.c",
        "sample bullets + sample.c",
        "sample bullets - sample.a",
        "skill order: skill.python, skill.sql -> skill.sql, skill.rust",
        "skills + skill.rust",
        "skills - skill.python",
    ):
        assert expected in rendered


async def test_skip_confirmation_and_watch_action_are_append_only_decisions() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        await open_review(app, pilot)

        await pilot.click("#review-skip")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.press("escape")
        await pilot.pause()
        assert facade.case.decision is Decision.UNDECIDED

        await pilot.click("#review-watch")
        await settle(app, pilot)
        assert facade.case.decision is Decision.WATCH

        await pilot.click("#review-skip")
        await pilot.pause()
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert facade.case.decision is Decision.SKIP


async def test_failed_generation_is_explicitly_retryable() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    facade.generation_returns_failed = True
    failed = await facade.generate_resume("job-1")
    assert failed.stage.value == "failed"
    facade.calls.clear()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        review = await open_review(app, pilot)
        assert not review.query_one("#review-retry", Button).disabled
        assert review.query_one("#review-tailor", Button).disabled
        assert (
            "blocking validation"
            in str(review.query_one("#resume-status", Static).render()).lower()
        )

        await pilot.click("#review-retry")
        await settle(app, pilot)
        assert ("retry_resume", "job-1") in facade.calls
        assert facade.resume_status is ResumeStatus.READY
        assert review.query_one("#review-retry", Button).disabled
        assert review.query_one("#review-tailor", Button).disabled


async def test_pdf_open_export_and_reject_actions_bind_the_current_run() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    run = await facade.generate_resume("job-1")
    assert run.artifact is not None
    facade.calls.clear()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 36)) as pilot:
        await settle(app, pilot)
        await open_review(app, pilot)

        await pilot.click("#review-open")
        await settle(app, pilot)
        assert ("open_artifact", run.artifact.id) in facade.calls

        await pilot.click("#review-export")
        await pilot.pause()
        assert isinstance(app.screen, ExportPathModal)
        app.screen.query_one("#export-path", Input).value = "/tmp/sanitized-resume.pdf"
        await pilot.click("#export-save")
        await settle(app, pilot)
        assert (
            "export_artifact",
            run.artifact.id,
            "/tmp/sanitized-resume.pdf",
        ) in facade.calls

        await pilot.click("#review-reject")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert ("reject_resume", "job-1", run.id, "") in facade.calls


async def test_first_run_requires_provider_and_trusted_master_repository() -> None:
    facade = OnboardingFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(110, 44)) as pilot:
        await pilot.pause()
        assert isinstance(app.screen, ProfileModal)
        profile_modal = app.screen
        profile_modal.query_one("#profile-name", Input).value = "Platform search"
        profile_modal.query_one("#profile-roles", Input).value = "Staff Platform Engineer"
        profile_modal.save()
        await pilot.pause()
        assert "Choose Demo or OpenAI" in str(
            app.screen.query_one("#profile-error", Static).render()
        )

        profile_modal.query_one("#profile-provider", Select).value = "demo"
        await pilot.pause()
        profile_modal.save()
        for _ in range(20):
            await pilot.pause()
            if isinstance(app.screen, ResumeSourceModal):
                break
        assert isinstance(app.screen, ResumeSourceModal)
        source_modal = app.screen
        source_modal.query_one("#resume-source-repository", Input).value = "/tmp/master-resume"
        source_modal.save()
        await pilot.pause()
        assert "Acknowledge" in str(app.screen.query_one("#resume-source-error", Static).render())

        source_modal.query_one("#resume-source-trust", Checkbox).value = True
        await pilot.pause()
        source_modal.save()
        for _ in range(20):
            await pilot.pause()
            if isinstance(app.screen, WorkspaceScreen):
                break

        assert isinstance(app.screen, WorkspaceScreen)
        create = next(call for call in facade.calls if call[0] == "create_profile")
        assert create[1]["agent_provider"] == AgentProvider.DEMO.value
        assert {item["kind"] for item in create[1]["agent_configurations"]} == {
            "scout",
            "reviewer",
            "resume",
        }
        assert facade.resume_source_requests[-1] == {
            "kind": "local_git",
            "repository": "/tmp/master-resume",
            "ref": "",
            "document_path": "roleloop_contract/v1/cli.py",
            "trust_repository": True,
        }


async def test_settings_edit_prefills_provider_from_agent_configurations() -> None:
    facade = ProfileManagementFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 44)) as pilot:
        await settle(app, pilot)
        await pilot.press("3")
        await settle(app, pilot)
        profiles = app.screen.query_one("#profiles-table", DataTable)
        assert profiles.row_count == 2

        profiles.focus()
        profiles.move_cursor(row=0)
        await pilot.click("#profile-edit")
        await pilot.pause()
        assert isinstance(app.screen, ProfileModal)
        assert app.screen.query_one("#profile-provider", Select).value == "demo"
        app.screen.query_one("#profile-name", Input).value = "Principal backend search"
        await pilot.click("#profile-save")
        await settle(app, pilot)
        assert any(call[:2] == ("update_profile", "profile-1") for call in facade.calls)

        await pilot.click("#profile-create")
        await pilot.pause()
        assert isinstance(app.screen, ProfileModal)
        app.screen.query_one("#profile-provider", Select).value = "demo"
        app.screen.query_one("#profile-name", Input).value = "Data platform search"
        app.screen.query_one("#profile-roles", Input).value = "Staff Data Engineer"
        await pilot.click("#profile-save")
        await settle(app, pilot)
        assert profiles.row_count == 3

        profiles.focus()
        profiles.move_cursor(row=2)
        await pilot.pause()
        assert profiles.cursor_row == 2
        assert str(profiles.coordinate_to_cell_key(profiles.cursor_coordinate).row_key.value) == (
            "profile-3"
        )
        await pilot.press("a")
        for _ in range(20):
            await pilot.pause()
            if facade.profile.id == "profile-3":
                break
        assert facade.profile.id == "profile-3"


async def test_settings_previews_then_applies_legacy_history_with_confirmation() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 44)) as pilot:
        await settle(app, pilot)
        await pilot.press("3")
        await settle(app, pilot)

        await pilot.click("#runtime-doctor")
        await settle(app, pilot)
        assert len([call for call in facade.calls if call[0] == "check_runtime"]) >= 2

        await pilot.click("#legacy-preview")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert ("preview_legacy_import",) in facade.calls

        await pilot.click("#legacy-apply")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.click("#confirm-action")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert ("apply_legacy_import",) in facade.calls


async def test_settings_configures_trusted_fixed_bridge_then_syncs() -> None:
    facade = FakeFacade()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 44)) as pilot:
        await settle(app, pilot)
        await pilot.press("3")
        await settle(app, pilot)
        sync_button = app.screen.query_one("#resume-source-sync", Button)
        assert sync_button.disabled

        await pilot.click("#resume-source-configure")
        await pilot.pause()
        assert isinstance(app.screen, ResumeSourceModal)
        app.screen.query_one("#resume-source-kind", Select).value = "remote_git"
        app.screen.query_one(
            "#resume-source-repository", Input
        ).value = "git@example.test:team/resume.git"
        bridge = app.screen.query_one("#resume-source-document-path", Input)
        assert bridge.disabled
        assert bridge.value == "roleloop_contract/v1/cli.py"
        app.screen.query_one("#resume-source-trust", Checkbox).value = True
        await pilot.click("#resume-source-save")
        await settle(app, pilot)

        assert facade.resume_source_requests[-1] == {
            "kind": "remote_git",
            "repository": "git@example.test:team/resume.git",
            "ref": "",
            "document_path": "roleloop_contract/v1/cli.py",
            "trust_repository": True,
        }
        assert not sync_button.disabled
        await pilot.click("#resume-source-sync")
        await settle(app, pilot)
        assert ("sync_resume_source",) in facade.calls
        summary = str(app.screen.query_one("#settings-summary", Static).render())
        assert "abc123" in summary
        assert "Trusted execution  yes" in summary


async def test_application_ledger_stage_and_follow_up_queue_actions() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    await facade.generate_resume("job-1")
    assert facade.resume_run is not None
    facade.approve_resume("job-1", facade.resume_run.id)
    facade.submit_application("job-1", "2026-08-20", "Manual reminder")
    facade.calls.clear()
    app = RoleLoopApp(facade)

    async with app.run_test(size=(120, 40)) as pilot:
        await settle(app, pilot)
        await pilot.press("2")
        await settle(app, pilot)
        applications = app.screen.query_one("#applications-table", DataTable)
        followups = app.screen.query_one("#followups-table", DataTable)
        assert applications.row_count == 1
        assert followups.row_count == 1
        assert "artifact-run-1" in str(applications.get_row_at(0)[4])

        await pilot.click("#followup-reschedule")
        await pilot.pause()
        assert isinstance(app.screen, FollowUpRescheduleModal)
        app.screen.query_one("#reschedule-date", Input).value = "2026-08-27"
        await pilot.click("#reschedule-save")
        await settle(app, pilot)
        assert any(
            call[:3] == ("reschedule_followup", "follow-up-1", "2026-08-27")
            for call in facade.calls
        )

        await pilot.click("#followup-resolve")
        await pilot.pause()
        assert isinstance(app.screen, ConfirmActionModal)
        await pilot.click("#confirm-action")
        await settle(app, pilot)
        assert any(call[0] == "resolve_followup" for call in facade.calls)
        assert followups.row_count == 0

        await pilot.click("#record-stage")
        await pilot.pause()
        assert isinstance(app.screen, ApplicationStageModal)
        app.screen.query_one("#application-stage", Select).value = "recruiter_screen"
        app.screen.query_one("#application-follow-up", Input).value = "2026-09-03"
        await pilot.click("#application-stage-save")
        await settle(app, pilot)
        stage_calls = [call for call in facade.calls if call[0] == "record_application_stage"]
        assert stage_calls[-1][2]["stage"] == "recruiter_screen"
        assert followups.row_count == 1


def test_application_facade_scopes_followup_mutations_to_active_profile() -> None:
    class FollowUpService:
        def __init__(self) -> None:
            self.calls: list[tuple[object, ...]] = []

        def get_active_profile_summary(self) -> object:
            return SimpleNamespace(
                profile=SimpleNamespace(
                    id="active-profile",
                    timezone="America/Guayaquil",
                )
            )

        def resolve_followup(
            self,
            profile_id: str,
            follow_up_id: str,
            *,
            note: str = "",
        ) -> object:
            self.calls.append(("resolve", profile_id, follow_up_id, note))
            return SimpleNamespace(id="resolution-1")

        def reschedule_followup(
            self,
            profile_id: str,
            follow_up_id: str,
            due_at: object,
            *,
            note: str = "",
        ) -> object:
            self.calls.append(("reschedule", profile_id, follow_up_id, due_at, note))
            return SimpleNamespace(id="replacement-1")

    service = FollowUpService()
    facade = ApplicationServiceFacade(service)  # type: ignore[arg-type]

    facade.resolve_followup("follow-up-1", "Acknowledged")
    facade.reschedule_followup("follow-up-2", "2026-08-27", "Wait")

    assert service.calls[0] == (
        "resolve",
        "active-profile",
        "follow-up-1",
        "Acknowledged",
    )
    assert service.calls[1][0:3] == (
        "reschedule",
        "active-profile",
        "follow-up-2",
    )
    due_at = service.calls[1][3]
    assert hasattr(due_at, "isoformat")
    assert due_at.isoformat() == "2026-08-27T00:00:00-05:00"  # type: ignore[union-attr]
    assert service.calls[1][4] == "Wait"


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
        ProfileDraft(
            name="Persisted search",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
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

    restarted = RoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3")),
        SystemClock(),
        UUID4Generator(),
    )
    persisted = restarted.get_job_case(profile.id, job.id)
    assert persisted.job.title == "Platform Engineer"
    assert persisted.job.company == "Durable Systems"
