from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from roleloop.domain import (
    Answer,
    ApplicationStatus,
    ApplicationSubmission,
    ArtifactRef,
    ClaimProvenance,
    Decision,
    EvidenceSourceKind,
    Finding,
    Job,
    JobCase,
    Outcome,
    OutcomeEvent,
    QuestionCategory,
    RemotePreference,
    ResumeEvidenceVersion,
    ResumeRun,
    ResumeStage,
    ReviewQuestion,
    ReviewVersion,
    SearchProfile,
    ValidationFinding,
    ValidationSeverity,
    VerificationAnswer,
    WorkflowEvent,
)
from roleloop.infrastructure import SQLiteDatabase, SQLiteUnitOfWorkFactory
from roleloop.infrastructure.migration_runner import UnsupportedSchemaVersionError

NOW = datetime(2026, 8, 13, 20, 0, tzinfo=UTC)


def test_database_applies_packaged_migration_and_required_pragmas(tmp_path: Path) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3", busy_timeout_ms=2_345)

    first = database.connect()
    assert first.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert first.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert first.execute("PRAGMA busy_timeout").fetchone()[0] == 2_345
    assert [row[0] for row in first.execute("SELECT version FROM schema_migrations")] == [1]
    first.close()

    second = database.connect()
    assert [row[0] for row in second.execute("SELECT version FROM schema_migrations")] == [1]
    second.close()


def test_database_refuses_unknown_newer_schema_version(tmp_path: Path) -> None:
    path = tmp_path / "roleloop.sqlite3"
    connection = SQLiteDatabase(path).connect()
    connection.execute("INSERT INTO schema_migrations (version) VALUES (999)")
    connection.close()

    with pytest.raises(UnsupportedSchemaVersionError, match="newer than supported"):
        SQLiteDatabase(path).connect()


def test_schema_rejects_unknown_fixed_enum_values(tmp_path: Path) -> None:
    factory = _factory(tmp_path)
    profile = _profile("profile-1", active=True)
    with factory() as uow:
        uow.profiles.add(profile)
        uow.commit()

    with factory() as uow, pytest.raises(sqlite3.IntegrityError, match="CHECK constraint"):
        uow.connection.execute(
            "UPDATE profiles SET remote_preference = 'teleport' WHERE id = ?",
            (profile.id,),
        )


def test_only_opaque_provider_and_event_metadata_use_json_columns(tmp_path: Path) -> None:
    connection = SQLiteDatabase(tmp_path / "roleloop.sqlite3").connect()
    tables = [
        row["name"]
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ]
    json_columns = {
        (table, column["name"])
        for table in tables
        for column in connection.execute(f"PRAGMA table_info({table})")
        if column["name"].endswith("_json")
    }
    connection.close()

    assert json_columns == {
        ("jobs", "source_metadata_json"),
        ("workflow_events", "metadata_json"),
    }


def test_repositories_round_trip_complete_workflow(tmp_path: Path) -> None:
    factory = _factory(tmp_path)
    profile, evidence, job, case, review = _seed_review(factory)
    answer = VerificationAnswer(review.id, "q-1", Answer.YES, NOW + timedelta(minutes=1))
    artifact = ArtifactRef("pdf-1", "pdf-checksum", "managed/pdf-1.pdf", "application/pdf", 42)
    run = ResumeRun(
        id="run-1",
        job_case_id=case.id,
        review_version_id=review.id,
        evidence_version_id=evidence.id,
        input_fingerprint="resume-fingerprint",
        stage=ResumeStage.READY,
        generator_version="generator-1",
        validator_version="validator-1",
        compiler_version="compiler-1",
        structured_draft={
            "summary": "Evidence-led engineer",
            "sections": [
                {
                    "title": "Experience",
                    "bullets": ("Built RoleLoop", "Improved reliability"),
                    "years": 4,
                    "highlight": True,
                    "score": 0.75,
                    "note": None,
                }
            ],
        },
        provenance=(
            ClaimProvenance("Built RoleLoop", "resume:2"),
            ClaimProvenance("Improved reliability", "resume:3"),
        ),
        validation_findings=(
            ValidationFinding(ValidationSeverity.WARNING, "Short summary", "summary"),
        ),
        artifact=artifact,
        created_at=NOW + timedelta(minutes=2),
        updated_at=NOW + timedelta(minutes=3),
    )
    submission = ApplicationSubmission(
        id="submission-1",
        job_case_id=case.id,
        decision_at_submission=Decision.TAILOR,
        artifact_id=artifact.id,
        submitted_at=NOW + timedelta(minutes=4),
    )
    outcome = OutcomeEvent(
        id="outcome-1",
        job_case_id=case.id,
        outcome=Outcome.INTERVIEWING,
        recorded_at=NOW + timedelta(minutes=5),
    )
    event = WorkflowEvent(
        id="event-1",
        event_type="application_submitted",
        occurred_at=NOW + timedelta(minutes=4),
        profile_id=profile.id,
        job_case_id=case.id,
        metadata={"artifact_id": artifact.id, "channel": "cli"},
    )

    with factory() as uow:
        uow.reviews.upsert_answer(answer)
        uow.resume_runs.add(run)
        uow.applications.add_submission(submission)
        uow.applications.add_outcome(outcome)
        uow.events.add(event)
        uow.commit()

    with factory() as uow:
        assert uow.profiles.get(profile.id) == profile
        assert uow.profiles.get_active() == profile
        assert uow.evidence.get(evidence.id) == evidence
        assert uow.evidence.list_for_profile(profile.id) == (evidence,)
        assert uow.jobs.get(job.id) == job
        assert uow.jobs.get_by_canonical_url(job.canonical_url) == job
        assert uow.cases.get(case.id) == case
        assert uow.cases.get_for_profile_job(profile.id, job.id) == case
        assert uow.reviews.get_latest(case.id) == review
        assert uow.reviews.list_answers(review.id) == (answer,)
        assert uow.resume_runs.get_latest(case.id) == run
        assert (
            uow.connection.execute(
                "SELECT COUNT(*) FROM review_findings WHERE review_version_id = ?",
                (review.id,),
            ).fetchone()[0]
            == 2
        )
        assert (
            uow.connection.execute(
                "SELECT COUNT(*) FROM resume_provenance WHERE resume_run_id = ?",
                (run.id,),
            ).fetchone()[0]
            == 2
        )
        assert (
            uow.connection.execute(
                "SELECT COUNT(*) FROM resume_draft_nodes WHERE resume_run_id = ?",
                (run.id,),
            ).fetchone()[0]
            > 10
        )
        assert uow.applications.get_submission(case.id) == submission
        assert uow.applications.list_outcomes(case.id) == (outcome,)
        assert uow.events.list_for_case(case.id) == (event,)


def test_unit_of_work_rolls_back_without_explicit_commit(tmp_path: Path) -> None:
    factory = _factory(tmp_path)
    profile = _profile("profile-1", active=True)

    with factory() as uow:
        uow.profiles.add(profile)

    with factory() as uow:
        assert uow.profiles.get(profile.id) is None


def test_profile_activation_is_atomic_and_only_one_profile_can_be_active(
    tmp_path: Path,
) -> None:
    factory = _factory(tmp_path)
    first = _profile("profile-1", active=True)
    second = _profile("profile-2", active=False)
    with factory() as uow:
        uow.profiles.add(first)
        uow.profiles.add(second)
        uow.commit()

    with factory() as uow:
        assert uow.profiles.set_active(second.id, at=NOW + timedelta(minutes=1))
        uow.commit()

    with factory() as uow:
        assert uow.profiles.get_active() is not None
        assert uow.profiles.get_active().id == second.id  # type: ignore[union-attr]
        assert not uow.profiles.get(first.id).is_active  # type: ignore[union-attr]

    with factory() as uow, pytest.raises(sqlite3.IntegrityError):
        uow.profiles.add(_profile("profile-3", active=True))


def test_optimistic_updates_reject_stale_revisions(tmp_path: Path) -> None:
    factory = _factory(tmp_path)
    profile = _profile("profile-1", active=True)
    with factory() as uow:
        uow.profiles.add(profile)
        uow.commit()

    updated = replace(profile, name="Updated", revision=2, updated_at=NOW + timedelta(minutes=1))
    with factory() as uow:
        assert not uow.profiles.update(updated, expected_revision=9)
        assert uow.profiles.update(updated, expected_revision=1)
        uow.commit()

    with factory() as uow:
        assert uow.profiles.get(profile.id) == updated


def test_database_prevents_concurrent_resume_runs_for_same_case(tmp_path: Path) -> None:
    factory = _factory(tmp_path)
    _, evidence, _, case, review = _seed_review(factory)
    first = _queued_run("run-1", case.id, review.id, evidence.id)
    second = _queued_run("run-2", case.id, review.id, evidence.id)

    with factory() as uow:
        uow.resume_runs.add(first)
        uow.commit()

    with factory() as uow, pytest.raises(sqlite3.IntegrityError):
        uow.resume_runs.add(second)

    completed = replace(first, stage=ResumeStage.FAILED, error_message="provider failed")
    with factory() as uow:
        uow.resume_runs.update(completed)
        uow.commit()
    with factory() as uow:
        uow.resume_runs.add(second)
        uow.commit()


def test_resume_update_replaces_normalized_draft_and_validation_rows(
    tmp_path: Path,
) -> None:
    factory = _factory(tmp_path)
    _, evidence, _, case, review = _seed_review(factory)
    queued = _queued_run("run-1", case.id, review.id, evidence.id)
    with factory() as uow:
        uow.resume_runs.add(queued)
        uow.commit()

    validating = replace(
        queued,
        stage=ResumeStage.VALIDATING,
        structured_draft={
            "summary": "Platform engineer",
            "sections": [{"bullets": ("One", "Two"), "selected": True}],
        },
        provenance=(ClaimProvenance("One", "resume:1"),),
        validation_findings=(ValidationFinding(ValidationSeverity.INFO, "Grounded", "summary"),),
    )
    with factory() as uow:
        uow.resume_runs.update(validating)
        uow.commit()
    with factory() as uow:
        assert uow.resume_runs.get(queued.id) == validating

    cleared = replace(
        validating,
        stage=ResumeStage.FAILED,
        structured_draft=None,
        provenance=(),
        validation_findings=(),
        error_message="retry requested",
    )
    with factory() as uow:
        uow.resume_runs.update(cleared)
        uow.commit()
    with factory() as uow:
        assert uow.resume_runs.get(queued.id) == cleared
        assert (
            uow.connection.execute(
                "SELECT COUNT(*) FROM resume_draft_nodes WHERE resume_run_id = ?",
                (queued.id,),
            ).fetchone()[0]
            == 0
        )


def test_workflow_event_rows_cannot_be_updated_or_deleted(tmp_path: Path) -> None:
    factory = _factory(tmp_path)
    profile, _, _, case, _ = _seed_review(factory)
    event = WorkflowEvent("event-1", "decision_changed", NOW, profile.id, case.id, {})
    with factory() as uow:
        uow.events.add(event)
        uow.commit()

    with factory() as uow, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        uow.connection.execute(
            "UPDATE workflow_events SET event_type = 'tampered' WHERE id = ?",
            (event.id,),
        )
    with factory() as uow, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        uow.connection.execute("DELETE FROM workflow_events WHERE id = ?", (event.id,))


def _factory(tmp_path: Path) -> SQLiteUnitOfWorkFactory:
    return SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3"))


def _profile(identifier: str, *, active: bool) -> SearchProfile:
    return SearchProfile(
        id=identifier,
        name=f"Profile {identifier}",
        target_roles=("Backend Engineer", "Platform Engineer"),
        locations=("Remote", "Quito"),
        remote_preference=RemotePreference.HYBRID,
        employment_types=("full-time",),
        seniority=("senior",),
        annual_salary_floor=100_000,
        salary_currency="USD",
        include_keywords=("python", "sqlite"),
        exclude_keywords=("clearance",),
        constraints="No relocation",
        is_active=active,
        created_at=NOW,
        updated_at=NOW,
    )


def _seed_review(
    factory: SQLiteUnitOfWorkFactory,
) -> tuple[SearchProfile, ResumeEvidenceVersion, Job, JobCase, ReviewVersion]:
    original_profile = _profile("profile-1", active=True)
    evidence = ResumeEvidenceVersion(
        id="evidence-1",
        profile_id=original_profile.id,
        source_kind=EvidenceSourceKind.PDF,
        source_name="resume.pdf",
        source_artifact=ArtifactRef(
            "source-1",
            "source-checksum",
            "managed/source-1.pdf",
            "application/pdf",
            1_024,
        ),
        extracted_text="Built reliable Python services.",
        created_at=NOW,
    )
    profile = replace(
        original_profile,
        active_evidence_version_id=evidence.id,
        revision=2,
        updated_at=NOW + timedelta(seconds=1),
    )
    job = Job(
        id="job-1",
        canonical_url="https://example.com/jobs/1",
        title="Platform Engineer",
        company="Example",
        location="Remote",
        description="Build reliable Python services.",
        source="manual",
        source_metadata={"source_url": "https://example.com/jobs/1", "rank": 1},
        created_at=NOW,
        updated_at=NOW,
    )
    case = JobCase(
        id="case-1",
        profile_id=profile.id,
        job_id=job.id,
        decision=Decision.TAILOR,
        application_status=ApplicationStatus.NOT_SUBMITTED,
        created_at=NOW,
        updated_at=NOW,
    )
    review = ReviewVersion(
        id="review-1",
        job_case_id=case.id,
        fingerprint="review-fingerprint",
        analyzer_version="analyzer-1",
        match_evidence=(Finding("Python", "Resume proves Python", "resume:1"),),
        skeptic_findings=(Finding("Scale", "Scale is not quantified", "job:2"),),
        questions=(
            ReviewQuestion(
                id="q-1",
                prompt="Are you authorized to work here?",
                category=QuestionCategory.ELIGIBILITY,
                required=True,
                qualifying_answer=Answer.YES,
            ),
        ),
        created_at=NOW,
    )
    with factory() as uow:
        uow.profiles.add(original_profile)
        uow.evidence.add(evidence)
        assert uow.profiles.update(profile, expected_revision=1)
        uow.jobs.add(job)
        uow.cases.add(case)
        uow.reviews.add(review)
        uow.commit()
    return profile, evidence, job, case, review


def _queued_run(
    identifier: str,
    case_id: str,
    review_id: str,
    evidence_id: str,
) -> ResumeRun:
    return ResumeRun(
        id=identifier,
        job_case_id=case_id,
        review_version_id=review_id,
        evidence_version_id=evidence_id,
        input_fingerprint=f"fingerprint-{identifier}",
        stage=ResumeStage.QUEUED,
        generator_version="generator-1",
        validator_version="validator-1",
        compiler_version="compiler-1",
        created_at=NOW,
        updated_at=NOW,
    )
