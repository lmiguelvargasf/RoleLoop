from __future__ import annotations

import hashlib
import shutil
import sqlite3
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from roleloop.application import ProfileDraft, ResumeSourceDraft
from roleloop.application.dto import ApplicationStageDraft, SubmitApplicationDraft
from roleloop.bootstrap import build_service
from roleloop.domain import (
    AgentKind,
    AgentProvider,
    Answer,
    ApplicationStage,
    Decision,
    ResumeApprovalStatus,
    ResumeReviewDecision,
    ResumeSourceKind,
    ResumeStage,
    ScreenResult,
)
from roleloop.infrastructure import RoleLoopPaths

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "master_resume_contract"
NATIVE_TOOLS = ("git", "latexmk", "pdflatex", "pdfinfo", "pdftotext")


def _run_git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout.strip()


def _create_resume_repository(root: Path) -> Path:
    repository = root / "sanitized-master-resume"
    shutil.copytree(FIXTURE, repository)
    subprocess.run(
        ["git", "init", "-b", "main", str(repository)],
        check=True,
        capture_output=True,
        timeout=30,
    )
    _run_git(repository, "config", "user.email", "roleloop@example.test")
    _run_git(repository, "config", "user.name", "RoleLoop Acceptance")
    _run_git(repository, "add", "--", ".")
    _run_git(repository, "commit", "-m", "Add sanitized native contract fixture")
    return repository


def _paths(root: Path) -> RoleLoopPaths:
    data = root / "roleloop-data"
    return RoleLoopPaths(
        data_dir=data,
        database_path=data / "roleloop.sqlite3",
        artifacts_dir=data / "artifacts",
    )


@pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in NATIVE_TOOLS),
    reason="the mandatory native Git, LaTeX, and Poppler toolchain is unavailable",
)
async def test_demo_full_workflow_survives_restart_and_later_source_sync(
    tmp_path: Path,
) -> None:
    repository = _create_resume_repository(tmp_path)
    paths = _paths(tmp_path)
    service = build_service(paths)
    profile = service.create_profile(
        ProfileDraft(
            name="Sanitized Demo search",
            target_roles=("Applied AI Engineer",),
            locations=("Remote from Ecuador",),
            annual_salary_floor=100_000,
            target_hq_countries=("United States",),
            startup_required=True,
            accepted_remote_arrangements=("remote from Ecuador",),
            accepted_hiring_arrangements=("international_contractor",),
            search_queries=("applied AI engineer remote",),
            agent_provider=AgentProvider.DEMO,
        ),
        command_id="profile-create-demo-e2e",
    )
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository=str(repository),
            kind=ResumeSourceKind.LOCAL_GIT,
            ref="HEAD",
            trust_repository=True,
        ),
        command_id="resume-source-configure-demo-e2e",
    )

    cases = await service.discover_jobs(
        profile.id,
        limit=1,
        command_id="scout-demo-e2e",
    )
    assert len(cases) == 1
    job_id = cases[0].job_id
    screened = service.get_job_case(profile.id, job_id)
    assert any(item.result is ScreenResult.UNKNOWN for item in screened.screen_evaluations)
    assert screened.review is None

    first_review = await service.review_job(
        profile.id,
        job_id,
        command_id="reviewer-initial-demo-e2e",
    )
    assert first_review.review is not None
    required = tuple(question for question in first_review.review.questions if question.required)
    assert required
    question_id = required[0].id
    answer = service.answer_verification(
        profile.id,
        job_id,
        question_id,
        Answer.YES,
        command_id="answer-demo-e2e",
    )
    assert answer.answers[question_id] is Answer.YES
    assert len(service.get_answer_history(profile.id, job_id, question_id)) == 1

    current_review = await service.review_job(
        profile.id,
        job_id,
        rerun=True,
        command_id="reviewer-rerun-demo-e2e",
    )
    assert current_review.review is not None
    assert current_review.review.id != first_review.review.id
    assert current_review.answers[question_id] is Answer.YES

    decision = await service.decide_and_tailor(
        profile.id,
        job_id,
        Decision.TAILOR,
        command_id="tailor-demo-e2e",
    )
    initial_run = decision.resume_run
    assert initial_run is not None
    assert initial_run.stage is ResumeStage.READY
    assert initial_run.artifact is not None
    assert initial_run.artifact.media_type == "application/pdf"
    assert initial_run.rendered_page_count is not None
    assert 1 <= initial_run.rendered_page_count <= 2
    assert initial_run.renderer_source_revision == _run_git(repository, "rev-parse", "HEAD")
    assert initial_run.selection_artifact is not None
    assert initial_run.tailored_source_bundle_artifact is not None
    assert initial_run.render_receipt_artifact is not None

    child_run = await service.revise_resume(
        profile.id,
        job_id,
        "Keep the strongest exact production evidence first.",
        command_id="revise-demo-e2e",
    )
    assert child_run.stage is ResumeStage.READY
    assert child_run.parent_resume_run_id == initial_run.id
    assert child_run.artifact is not None
    resume_case = service.get_resume(profile.id, job_id)
    assert [run.id for run in resume_case.runs] == [initial_run.id, child_run.id]

    approval = await service.approve_resume(
        profile.id,
        job_id,
        child_run.id,
        command_id="approve-demo-e2e",
    )
    assert approval.decision is ResumeReviewDecision.APPROVED
    assert approval.pdf_artifact_id == child_run.artifact.id
    assert approval.pdf_checksum == child_run.artifact.checksum
    assert service.get_resume(profile.id, job_id).approval_status is ResumeApprovalStatus.APPROVED

    submitted_at = datetime.now(UTC)
    first_follow_up = submitted_at + timedelta(days=7)
    application = await service.submit_application(
        profile.id,
        job_id,
        SubmitApplicationDraft(
            submitted_at=submitted_at,
            follow_up_at=first_follow_up,
            follow_up_note="Check for an acknowledgement.",
        ),
        command_id="submit-demo-e2e",
    )
    assert application.application.current_stage is ApplicationStage.SUBMITTED
    assert application.application.pdf_artifact_id == child_run.artifact.id
    assert application.open_follow_up is not None
    pinned_evidence_id = application.application.evidence_version_id
    pinned_pdf_checksum = application.application.pdf_checksum

    # Simulate a process restart: all subsequent actions must use SQLite and
    # managed artifacts rather than in-memory state.
    service.close()
    service = build_service(paths)
    restarted = service.get_application(profile.id, job_id)
    assert restarted is not None
    assert restarted.application.id == application.application.id
    assert restarted.open_follow_up is not None
    original_follow_up_id = restarted.open_follow_up.id
    rescheduled = service.reschedule_followup(
        profile.id,
        original_follow_up_id,
        first_follow_up + timedelta(days=2),
        note="Wait two more days.",
        command_id="follow-up-reschedule-demo-e2e",
    )
    assert rescheduled.due_at == first_follow_up + timedelta(days=2)
    resolved = service.resolve_followup(
        profile.id,
        rescheduled.id,
        note="Acknowledgement received.",
        command_id="follow-up-resolve-demo-e2e",
    )
    assert resolved.follow_up_id == rescheduled.id

    recruiter = service.record_application_stage(
        profile.id,
        job_id,
        ApplicationStageDraft(
            stage=ApplicationStage.RECRUITER_SCREEN,
            follow_up_at=submitted_at + timedelta(days=14),
            follow_up_note="Follow up after recruiter screen.",
        ),
        command_id="stage-recruiter-demo-e2e",
    )
    assert recruiter.open_follow_up is not None
    technical = service.record_application_stage(
        profile.id,
        job_id,
        ApplicationStageDraft(
            stage=ApplicationStage.TECHNICAL_INTERVIEW,
            follow_up_at=submitted_at + timedelta(days=21),
        ),
        command_id="stage-technical-demo-e2e",
    )
    assert technical.open_follow_up is not None
    repeated = service.record_application_stage(
        profile.id,
        job_id,
        ApplicationStageDraft(
            stage=ApplicationStage.TECHNICAL_INTERVIEW,
            no_follow_up=True,
            note="Second technical round; no reminder requested.",
        ),
        command_id="stage-technical-repeat-demo-e2e",
    )
    assert repeated.open_follow_up is None
    final = service.record_application_stage(
        profile.id,
        job_id,
        ApplicationStageDraft(
            stage=ApplicationStage.FINAL_OR_ONSITE,
            follow_up_at=submitted_at + timedelta(days=28),
        ),
        command_id="stage-final-demo-e2e",
    )
    assert final.open_follow_up is not None
    terminal = service.record_application_stage(
        profile.id,
        job_id,
        ApplicationStageDraft(
            stage=ApplicationStage.REJECTED,
            note="Role closed after final interview.",
        ),
        command_id="stage-terminal-demo-e2e",
    )
    assert terminal.application.current_stage is ApplicationStage.REJECTED
    assert terminal.open_follow_up is None
    assert [event.stage for event in terminal.stages] == [
        ApplicationStage.SUBMITTED,
        ApplicationStage.RECRUITER_SCREEN,
        ApplicationStage.TECHNICAL_INTERVIEW,
        ApplicationStage.TECHNICAL_INTERVIEW,
        ApplicationStage.FINAL_OR_ONSITE,
        ApplicationStage.REJECTED,
    ]

    # A later master source commit and explicit sync may become the active
    # evidence, but it cannot rewrite the already-submitted pinned chain.
    (repository / "fixture-revision.txt").write_text(
        "Second sanitized source revision.\n", encoding="utf-8"
    )
    _run_git(repository, "add", "--", "fixture-revision.txt")
    _run_git(repository, "commit", "-m", "Advance sanitized evidence source")
    later_evidence = await service.sync_resume_source(
        profile.id,
        command_id="source-sync-after-submission-demo-e2e",
    )
    assert later_evidence.id != pinned_evidence_id
    pinned = service.get_application(profile.id, job_id)
    assert pinned is not None
    assert pinned.application.evidence_version_id == pinned_evidence_id
    assert pinned.application.pdf_checksum == pinned_pdf_checksum

    exported = tmp_path / "submitted-resume.pdf"
    await service.export_artifact(pinned.application.pdf_artifact_id, exported)
    pdf = exported.read_bytes()
    assert pdf.startswith(b"%PDF-")
    assert hashlib.sha256(pdf).hexdigest() == pinned_pdf_checksum
    history = service.get_history(profile.id, job_id)
    assert any(event.event_type == "application.submitted" for event in history.events)
    assert any(
        event.event_type == "application.stage_recorded"
        and event.metadata.get("stage") == "rejected"
        for event in history.events
    )

    with sqlite3.connect(paths.database_path) as connection:
        agent_kinds = {
            AgentKind(row[0]) for row in connection.execute("SELECT DISTINCT kind FROM agent_runs")
        }
    assert agent_kinds == {AgentKind.SCOUT, AgentKind.REVIEWER, AgentKind.RESUME}
    service.close()
