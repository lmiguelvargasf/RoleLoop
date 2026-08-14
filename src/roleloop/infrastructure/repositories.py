from __future__ import annotations

import json
import math
import sqlite3
from collections.abc import Mapping, Sequence
from datetime import datetime
from enum import Enum
from typing import Any

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


class SQLiteProfilesRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, profile: SearchProfile) -> None:
        self._connection.execute(
            """
            INSERT INTO profiles (
                id, name, remote_preference, annual_salary_floor, salary_currency,
                constraints_text, revision, is_active, active_evidence_version_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _profile_parameters(profile),
        )
        _replace_profile_values(self._connection, profile)

    def get(self, profile_id: str) -> SearchProfile | None:
        row = self._connection.execute(
            "SELECT * FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        return None if row is None else _profile_from_row(self._connection, row)

    def get_active(self) -> SearchProfile | None:
        row = self._connection.execute("SELECT * FROM profiles WHERE is_active = 1").fetchone()
        return None if row is None else _profile_from_row(self._connection, row)

    def list(self) -> Sequence[SearchProfile]:
        rows = self._connection.execute(
            "SELECT * FROM profiles ORDER BY lower(name), id"
        ).fetchall()
        return tuple(_profile_from_row(self._connection, row) for row in rows)

    def update(self, profile: SearchProfile, *, expected_revision: int) -> bool:
        cursor = self._connection.execute(
            """
            UPDATE profiles SET
                name = ?, remote_preference = ?, annual_salary_floor = ?,
                salary_currency = ?, constraints_text = ?, revision = ?, is_active = ?,
                active_evidence_version_id = ?, created_at = ?, updated_at = ?
            WHERE id = ? AND revision = ?
            """,
            (*_profile_parameters(profile)[1:], profile.id, expected_revision),
        )
        if cursor.rowcount != 1:
            return False
        _replace_profile_values(self._connection, profile)
        return True

    def set_active(self, profile_id: str, *, at: datetime) -> bool:
        exists = self._connection.execute(
            "SELECT 1 FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if exists is None:
            return False
        timestamp = _datetime_text(at)
        self._connection.execute(
            "UPDATE profiles SET is_active = 0, updated_at = ? WHERE is_active = 1 AND id <> ?",
            (timestamp, profile_id),
        )
        self._connection.execute(
            "UPDATE profiles SET is_active = 1, updated_at = ? WHERE id = ?",
            (timestamp, profile_id),
        )
        return True


class SQLiteEvidenceRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, evidence: ResumeEvidenceVersion) -> None:
        artifact = evidence.source_artifact
        self._connection.execute(
            """
            INSERT INTO evidence_versions (
                id, profile_id, source_kind, source_name, artifact_id,
                artifact_checksum, artifact_uri, artifact_media_type,
                artifact_size_bytes, extracted_text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                evidence.id,
                evidence.profile_id,
                evidence.source_kind.value,
                evidence.source_name,
                artifact.id,
                artifact.checksum,
                artifact.uri,
                artifact.media_type,
                artifact.size_bytes,
                evidence.extracted_text,
                _datetime_text(evidence.created_at),
            ),
        )

    def get(self, evidence_id: str) -> ResumeEvidenceVersion | None:
        row = self._connection.execute(
            "SELECT * FROM evidence_versions WHERE id = ?", (evidence_id,)
        ).fetchone()
        return None if row is None else _evidence_from_row(row)

    def list_for_profile(self, profile_id: str) -> Sequence[ResumeEvidenceVersion]:
        rows = self._connection.execute(
            """
            SELECT * FROM evidence_versions
            WHERE profile_id = ?
            ORDER BY created_at, id
            """,
            (profile_id,),
        ).fetchall()
        return tuple(_evidence_from_row(row) for row in rows)


class SQLiteJobsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, job: Job) -> None:
        self._connection.execute(
            """
            INSERT INTO jobs (
                id, canonical_url, title, company, location, description, source,
                source_metadata_json, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _job_parameters(job),
        )

    def get(self, job_id: str) -> Job | None:
        row = self._connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return None if row is None else _job_from_row(row)

    def get_by_canonical_url(self, canonical_url: str) -> Job | None:
        row = self._connection.execute(
            "SELECT * FROM jobs WHERE canonical_url = ?", (canonical_url,)
        ).fetchone()
        return None if row is None else _job_from_row(row)

    def update(self, job: Job, *, expected_revision: int) -> bool:
        cursor = self._connection.execute(
            """
            UPDATE jobs SET
                canonical_url = ?, title = ?, company = ?, location = ?,
                description = ?, source = ?, source_metadata_json = ?, revision = ?,
                created_at = ?, updated_at = ?
            WHERE id = ? AND revision = ?
            """,
            (*_job_parameters(job)[1:], job.id, expected_revision),
        )
        return cursor.rowcount == 1


class SQLiteJobCasesRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, case: JobCase) -> None:
        self._connection.execute(
            """
            INSERT INTO job_cases (
                id, profile_id, job_id, decision, application_status,
                current_outcome, submitted_at, submitted_artifact_id, revision,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _case_parameters(case),
        )

    def get(self, case_id: str) -> JobCase | None:
        row = self._connection.execute(
            "SELECT * FROM job_cases WHERE id = ?", (case_id,)
        ).fetchone()
        return None if row is None else _case_from_row(row)

    def get_for_profile_job(self, profile_id: str, job_id: str) -> JobCase | None:
        row = self._connection.execute(
            "SELECT * FROM job_cases WHERE profile_id = ? AND job_id = ?",
            (profile_id, job_id),
        ).fetchone()
        return None if row is None else _case_from_row(row)

    def list_for_profile(self, profile_id: str) -> Sequence[JobCase]:
        rows = self._connection.execute(
            """
            SELECT * FROM job_cases
            WHERE profile_id = ?
            ORDER BY updated_at DESC, id
            """,
            (profile_id,),
        ).fetchall()
        return tuple(_case_from_row(row) for row in rows)

    def update(self, case: JobCase, *, expected_revision: int) -> bool:
        cursor = self._connection.execute(
            """
            UPDATE job_cases SET
                profile_id = ?, job_id = ?, decision = ?, application_status = ?,
                current_outcome = ?, submitted_at = ?, submitted_artifact_id = ?,
                revision = ?, created_at = ?, updated_at = ?
            WHERE id = ? AND revision = ?
            """,
            (*_case_parameters(case)[1:], case.id, expected_revision),
        )
        return cursor.rowcount == 1


class SQLiteReviewsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, review: ReviewVersion) -> None:
        self._connection.execute(
            """
            INSERT INTO review_versions (
                id, job_case_id, fingerprint, analyzer_version, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            _review_parameters(review),
        )
        self._connection.executemany(
            """
            INSERT INTO review_findings (
                review_version_id, kind, position, summary, detail, source_anchor
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                (review.id, kind, position, item.summary, item.detail, item.source_anchor)
                for kind, findings in (
                    ("match", review.match_evidence),
                    ("skeptic", review.skeptic_findings),
                )
                for position, item in enumerate(findings)
            ),
        )
        self._connection.executemany(
            """
            INSERT INTO review_questions (
                review_version_id, id, position, prompt, category, required,
                qualifying_answer
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    review.id,
                    question.id,
                    position,
                    question.prompt,
                    question.category.value,
                    int(question.required),
                    question.qualifying_answer.value,
                )
                for position, question in enumerate(review.questions)
            ),
        )

    def get(self, review_id: str) -> ReviewVersion | None:
        row = self._connection.execute(
            "SELECT * FROM review_versions WHERE id = ?", (review_id,)
        ).fetchone()
        return None if row is None else _review_from_row(self._connection, row)

    def get_latest(self, case_id: str) -> ReviewVersion | None:
        row = self._connection.execute(
            """
            SELECT * FROM review_versions
            WHERE job_case_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            """,
            (case_id,),
        ).fetchone()
        return None if row is None else _review_from_row(self._connection, row)

    def list_for_case(self, case_id: str) -> Sequence[ReviewVersion]:
        rows = self._connection.execute(
            """
            SELECT * FROM review_versions
            WHERE job_case_id = ?
            ORDER BY created_at, rowid
            """,
            (case_id,),
        ).fetchall()
        return tuple(_review_from_row(self._connection, row) for row in rows)

    def upsert_answer(self, answer: VerificationAnswer) -> None:
        self._connection.execute(
            """
            INSERT INTO verification_answers (
                review_version_id, question_id, answer, answered_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT (review_version_id, question_id) DO UPDATE SET
                answer = excluded.answer,
                answered_at = excluded.answered_at
            """,
            (
                answer.review_version_id,
                answer.question_id,
                answer.answer.value,
                _datetime_text(answer.answered_at),
            ),
        )

    def list_answers(self, review_id: str) -> Sequence[VerificationAnswer]:
        rows = self._connection.execute(
            """
            SELECT * FROM verification_answers
            WHERE review_version_id = ?
            ORDER BY answered_at, question_id
            """,
            (review_id,),
        ).fetchall()
        return tuple(
            VerificationAnswer(
                review_version_id=row["review_version_id"],
                question_id=row["question_id"],
                answer=Answer(row["answer"]),
                answered_at=_required_datetime(row["answered_at"]),
            )
            for row in rows
        )


class SQLiteResumeRunsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, run: ResumeRun) -> None:
        self._connection.execute(
            """
            INSERT INTO resume_runs (
                id, job_case_id, review_version_id, evidence_version_id,
                input_fingerprint, stage, generator_version, validator_version,
                compiler_version, artifact_id, artifact_checksum, artifact_uri,
                artifact_media_type, artifact_size_bytes, error_message, created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _resume_run_parameters(run),
        )
        _replace_resume_children(self._connection, run)

    def get(self, run_id: str) -> ResumeRun | None:
        row = self._connection.execute(
            "SELECT * FROM resume_runs WHERE id = ?", (run_id,)
        ).fetchone()
        return None if row is None else _resume_run_from_row(self._connection, row)

    def get_latest(self, case_id: str) -> ResumeRun | None:
        row = self._connection.execute(
            """
            SELECT * FROM resume_runs
            WHERE job_case_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            """,
            (case_id,),
        ).fetchone()
        return None if row is None else _resume_run_from_row(self._connection, row)

    def list_for_case(self, case_id: str) -> Sequence[ResumeRun]:
        rows = self._connection.execute(
            """
            SELECT * FROM resume_runs
            WHERE job_case_id = ?
            ORDER BY created_at, rowid
            """,
            (case_id,),
        ).fetchall()
        return tuple(_resume_run_from_row(self._connection, row) for row in rows)

    def list_in_progress(self) -> Sequence[ResumeRun]:
        stages = tuple(stage.value for stage in ResumeStage if stage.is_in_progress)
        placeholders = ", ".join("?" for _ in stages)
        rows = self._connection.execute(
            f"SELECT * FROM resume_runs WHERE stage IN ({placeholders}) ORDER BY created_at, rowid",
            stages,
        ).fetchall()
        return tuple(_resume_run_from_row(self._connection, row) for row in rows)

    def update(self, run: ResumeRun) -> None:
        cursor = self._connection.execute(
            """
            UPDATE resume_runs SET
                job_case_id = ?, review_version_id = ?, evidence_version_id = ?,
                input_fingerprint = ?, stage = ?, generator_version = ?,
                validator_version = ?, compiler_version = ?, artifact_id = ?,
                artifact_checksum = ?, artifact_uri = ?, artifact_media_type = ?,
                artifact_size_bytes = ?, error_message = ?, created_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (*_resume_run_parameters(run)[1:], run.id),
        )
        if cursor.rowcount != 1:
            raise KeyError(f"Resume run does not exist: {run.id}")
        _replace_resume_children(self._connection, run)


class SQLiteApplicationsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add_submission(self, submission: ApplicationSubmission) -> None:
        self._connection.execute(
            """
            INSERT INTO application_submissions (
                id, job_case_id, decision_at_submission, artifact_id, submitted_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                submission.id,
                submission.job_case_id,
                submission.decision_at_submission.value,
                submission.artifact_id,
                _datetime_text(submission.submitted_at),
            ),
        )

    def get_submission(self, case_id: str) -> ApplicationSubmission | None:
        row = self._connection.execute(
            "SELECT * FROM application_submissions WHERE job_case_id = ?", (case_id,)
        ).fetchone()
        if row is None:
            return None
        return ApplicationSubmission(
            id=row["id"],
            job_case_id=row["job_case_id"],
            decision_at_submission=Decision(row["decision_at_submission"]),
            artifact_id=row["artifact_id"],
            submitted_at=_required_datetime(row["submitted_at"]),
        )

    def add_outcome(self, outcome: OutcomeEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO outcome_events (id, job_case_id, outcome, recorded_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                outcome.id,
                outcome.job_case_id,
                outcome.outcome.value,
                _datetime_text(outcome.recorded_at),
            ),
        )

    def list_outcomes(self, case_id: str) -> Sequence[OutcomeEvent]:
        rows = self._connection.execute(
            """
            SELECT * FROM outcome_events
            WHERE job_case_id = ?
            ORDER BY recorded_at, rowid
            """,
            (case_id,),
        ).fetchall()
        return tuple(
            OutcomeEvent(
                id=row["id"],
                job_case_id=row["job_case_id"],
                outcome=Outcome(row["outcome"]),
                recorded_at=_required_datetime(row["recorded_at"]),
            )
            for row in rows
        )


class SQLiteEventsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, event: WorkflowEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO workflow_events (
                id, event_type, occurred_at, profile_id, job_case_id, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.event_type,
                _datetime_text(event.occurred_at),
                event.profile_id,
                event.job_case_id,
                _json_dump(event.metadata),
            ),
        )

    def list_for_case(self, case_id: str) -> Sequence[WorkflowEvent]:
        rows = self._connection.execute(
            """
            SELECT * FROM workflow_events
            WHERE job_case_id = ?
            ORDER BY occurred_at, rowid
            """,
            (case_id,),
        ).fetchall()
        return tuple(
            WorkflowEvent(
                id=row["id"],
                event_type=row["event_type"],
                occurred_at=_required_datetime(row["occurred_at"]),
                profile_id=row["profile_id"],
                job_case_id=row["job_case_id"],
                metadata=_json_load(row["metadata_json"]),
            )
            for row in rows
        )


def _profile_parameters(profile: SearchProfile) -> tuple[object, ...]:
    return (
        profile.id,
        profile.name,
        profile.remote_preference.value,
        profile.annual_salary_floor,
        profile.salary_currency,
        profile.constraints,
        profile.revision,
        int(profile.is_active),
        profile.active_evidence_version_id,
        _datetime_text(profile.created_at),
        _datetime_text(profile.updated_at),
    )


def _profile_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> SearchProfile:
    return SearchProfile(
        id=row["id"],
        name=row["name"],
        target_roles=_profile_values(connection, "profile_target_roles", row["id"]),
        locations=_profile_values(connection, "profile_locations", row["id"]),
        remote_preference=RemotePreference(row["remote_preference"]),
        employment_types=_profile_values(connection, "profile_employment_types", row["id"]),
        seniority=_profile_values(connection, "profile_seniority", row["id"]),
        annual_salary_floor=row["annual_salary_floor"],
        salary_currency=row["salary_currency"],
        include_keywords=_profile_values(connection, "profile_include_keywords", row["id"]),
        exclude_keywords=_profile_values(connection, "profile_exclude_keywords", row["id"]),
        constraints=row["constraints_text"],
        revision=row["revision"],
        is_active=bool(row["is_active"]),
        active_evidence_version_id=row["active_evidence_version_id"],
        created_at=_datetime_value(row["created_at"]),
        updated_at=_datetime_value(row["updated_at"]),
    )


def _job_parameters(job: Job) -> tuple[object, ...]:
    return (
        job.id,
        job.canonical_url,
        job.title,
        job.company,
        job.location,
        job.description,
        job.source,
        _json_dump(job.source_metadata),
        job.revision,
        _datetime_text(job.created_at),
        _datetime_text(job.updated_at),
    )


def _job_from_row(row: sqlite3.Row) -> Job:
    return Job(
        id=row["id"],
        canonical_url=row["canonical_url"],
        title=row["title"],
        company=row["company"],
        location=row["location"],
        description=row["description"],
        source=row["source"],
        source_metadata=_json_load(row["source_metadata_json"]),
        revision=row["revision"],
        created_at=_datetime_value(row["created_at"]),
        updated_at=_datetime_value(row["updated_at"]),
    )


def _case_parameters(case: JobCase) -> tuple[object, ...]:
    return (
        case.id,
        case.profile_id,
        case.job_id,
        case.decision.value,
        case.application_status.value,
        None if case.current_outcome is None else case.current_outcome.value,
        _datetime_text(case.submitted_at),
        case.submitted_artifact_id,
        case.revision,
        _datetime_text(case.created_at),
        _datetime_text(case.updated_at),
    )


def _case_from_row(row: sqlite3.Row) -> JobCase:
    outcome = row["current_outcome"]
    return JobCase(
        id=row["id"],
        profile_id=row["profile_id"],
        job_id=row["job_id"],
        decision=Decision(row["decision"]),
        application_status=ApplicationStatus(row["application_status"]),
        current_outcome=None if outcome is None else Outcome(outcome),
        submitted_at=_datetime_value(row["submitted_at"]),
        submitted_artifact_id=row["submitted_artifact_id"],
        revision=row["revision"],
        created_at=_datetime_value(row["created_at"]),
        updated_at=_datetime_value(row["updated_at"]),
    )


def _evidence_from_row(row: sqlite3.Row) -> ResumeEvidenceVersion:
    return ResumeEvidenceVersion(
        id=row["id"],
        profile_id=row["profile_id"],
        source_kind=EvidenceSourceKind(row["source_kind"]),
        source_name=row["source_name"],
        source_artifact=ArtifactRef(
            id=row["artifact_id"],
            checksum=row["artifact_checksum"],
            uri=row["artifact_uri"],
            media_type=row["artifact_media_type"],
            size_bytes=row["artifact_size_bytes"],
        ),
        extracted_text=row["extracted_text"],
        created_at=_required_datetime(row["created_at"]),
    )


def _review_parameters(review: ReviewVersion) -> tuple[object, ...]:
    return (
        review.id,
        review.job_case_id,
        review.fingerprint,
        review.analyzer_version,
        _datetime_text(review.created_at),
    )


def _review_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> ReviewVersion:
    question_rows = connection.execute(
        """
        SELECT * FROM review_questions
        WHERE review_version_id = ?
        ORDER BY position
        """,
        (row["id"],),
    ).fetchall()
    finding_rows = connection.execute(
        """
        SELECT * FROM review_findings
        WHERE review_version_id = ?
        ORDER BY kind, position
        """,
        (row["id"],),
    ).fetchall()
    return ReviewVersion(
        id=row["id"],
        job_case_id=row["job_case_id"],
        fingerprint=row["fingerprint"],
        analyzer_version=row["analyzer_version"],
        match_evidence=tuple(
            _finding_from_row(item) for item in finding_rows if item["kind"] == "match"
        ),
        skeptic_findings=tuple(
            _finding_from_row(item) for item in finding_rows if item["kind"] == "skeptic"
        ),
        questions=tuple(
            ReviewQuestion(
                id=question["id"],
                prompt=question["prompt"],
                category=QuestionCategory(question["category"]),
                required=bool(question["required"]),
                qualifying_answer=Answer(question["qualifying_answer"]),
            )
            for question in question_rows
        ),
        created_at=_required_datetime(row["created_at"]),
    )


def _resume_run_parameters(run: ResumeRun) -> tuple[object, ...]:
    artifact = run.artifact
    return (
        run.id,
        run.job_case_id,
        run.review_version_id,
        run.evidence_version_id,
        run.input_fingerprint,
        run.stage.value,
        run.generator_version,
        run.validator_version,
        run.compiler_version,
        None if artifact is None else artifact.id,
        None if artifact is None else artifact.checksum,
        None if artifact is None else artifact.uri,
        None if artifact is None else artifact.media_type,
        None if artifact is None else artifact.size_bytes,
        run.error_message,
        _datetime_text(run.created_at),
        _datetime_text(run.updated_at),
    )


def _resume_run_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> ResumeRun:
    artifact_id = row["artifact_id"]
    provenance_rows = connection.execute(
        """
        SELECT * FROM resume_provenance
        WHERE resume_run_id = ?
        ORDER BY position
        """,
        (row["id"],),
    ).fetchall()
    finding_rows = connection.execute(
        """
        SELECT * FROM resume_validation_findings
        WHERE resume_run_id = ?
        ORDER BY position
        """,
        (row["id"],),
    ).fetchall()
    return ResumeRun(
        id=row["id"],
        job_case_id=row["job_case_id"],
        review_version_id=row["review_version_id"],
        evidence_version_id=row["evidence_version_id"],
        input_fingerprint=row["input_fingerprint"],
        stage=ResumeStage(row["stage"]),
        generator_version=row["generator_version"],
        validator_version=row["validator_version"],
        compiler_version=row["compiler_version"],
        structured_draft=_load_resume_draft(connection, row["id"]),
        provenance=tuple(
            ClaimProvenance(item["claim"], item["evidence_anchor"]) for item in provenance_rows
        ),
        validation_findings=tuple(
            ValidationFinding(
                severity=ValidationSeverity(item["severity"]),
                message=item["message"],
                location=item["location"],
            )
            for item in finding_rows
        ),
        artifact=(
            None
            if artifact_id is None
            else ArtifactRef(
                id=artifact_id,
                checksum=row["artifact_checksum"],
                uri=row["artifact_uri"],
                media_type=row["artifact_media_type"],
                size_bytes=row["artifact_size_bytes"],
            )
        ),
        error_message=row["error_message"],
        created_at=_datetime_value(row["created_at"]),
        updated_at=_datetime_value(row["updated_at"]),
    )


def _finding_from_row(row: sqlite3.Row) -> Finding:
    return Finding(
        summary=row["summary"],
        detail=row["detail"],
        source_anchor=row["source_anchor"],
    )


def _replace_resume_children(connection: sqlite3.Connection, run: ResumeRun) -> None:
    connection.execute("DELETE FROM resume_draft_nodes WHERE resume_run_id = ?", (run.id,))
    connection.execute("DELETE FROM resume_provenance WHERE resume_run_id = ?", (run.id,))
    connection.execute("DELETE FROM resume_validation_findings WHERE resume_run_id = ?", (run.id,))
    if run.structured_draft is not None:
        connection.executemany(
            """
            INSERT INTO resume_draft_nodes (
                resume_run_id, node_id, parent_node_id, position, map_key,
                node_type, text_value, integer_value, real_value
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _draft_node_rows(run.id, run.structured_draft),
        )
    connection.executemany(
        """
        INSERT INTO resume_provenance (
            resume_run_id, position, claim, evidence_anchor
        ) VALUES (?, ?, ?, ?)
        """,
        (
            (run.id, position, item.claim, item.evidence_anchor)
            for position, item in enumerate(run.provenance)
        ),
    )
    connection.executemany(
        """
        INSERT INTO resume_validation_findings (
            resume_run_id, position, severity, message, location
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            (run.id, position, item.severity.value, item.message, item.location)
            for position, item in enumerate(run.validation_findings)
        ),
    )


def _draft_node_rows(run_id: str, draft: Mapping[str, Any]) -> tuple[tuple[object, ...], ...]:
    rows: list[tuple[object, ...]] = []

    def visit(
        value: object,
        *,
        parent_node_id: int | None,
        position: int,
        map_key: str | None,
    ) -> None:
        node_id = len(rows)
        node_type, text_value, integer_value, real_value = _draft_node_value(value)
        rows.append(
            (
                run_id,
                node_id,
                parent_node_id,
                position,
                map_key,
                node_type,
                text_value,
                integer_value,
                real_value,
            )
        )
        if isinstance(value, Mapping):
            for child_position, (key, child) in enumerate(value.items()):
                if not isinstance(key, str):
                    raise TypeError("structured draft mapping keys must be strings")
                visit(
                    child,
                    parent_node_id=node_id,
                    position=child_position,
                    map_key=key,
                )
        elif isinstance(value, (list, tuple)):
            for child_position, child in enumerate(value):
                visit(
                    child,
                    parent_node_id=node_id,
                    position=child_position,
                    map_key=None,
                )

    visit(draft, parent_node_id=None, position=0, map_key=None)
    return tuple(rows)


def _draft_node_value(
    value: object,
) -> tuple[str, str | None, int | None, float | None]:
    if isinstance(value, Mapping):
        return "mapping", None, None, None
    if isinstance(value, list):
        return "list", None, None, None
    if isinstance(value, tuple):
        return "tuple", None, None, None
    if isinstance(value, str):
        return "string", value, None, None
    if isinstance(value, bool):
        return "boolean", None, int(value), None
    if isinstance(value, int):
        return "integer", None, value, None
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("structured draft real values must be finite")
        return "real", None, None, value
    if value is None:
        return "null", None, None, None
    raise TypeError(f"unsupported structured draft value: {type(value).__name__}")


def _load_resume_draft(connection: sqlite3.Connection, run_id: str) -> Mapping[str, Any] | None:
    rows = connection.execute(
        """
        SELECT * FROM resume_draft_nodes
        WHERE resume_run_id = ?
        ORDER BY node_id
        """,
        (run_id,),
    ).fetchall()
    if not rows:
        return None
    by_id = {row["node_id"]: row for row in rows}
    roots = [row for row in rows if row["parent_node_id"] is None]
    if len(roots) != 1:
        raise ValueError(f"resume draft for {run_id} must contain exactly one root")
    children: dict[int, list[sqlite3.Row]] = {}
    for row in rows:
        parent_id = row["parent_node_id"]
        if parent_id is not None:
            children.setdefault(parent_id, []).append(row)
    for child_rows in children.values():
        child_rows.sort(key=lambda item: item["position"])

    def build(node_id: int) -> Any:
        row = by_id[node_id]
        node_type = row["node_type"]
        child_rows = children.get(node_id, [])
        if node_type == "mapping":
            result: dict[str, Any] = {}
            for child in child_rows:
                key = child["map_key"]
                if key is None:
                    raise ValueError("mapping draft child is missing its key")
                result[key] = build(child["node_id"])
            return result
        if node_type in {"list", "tuple"}:
            values = [build(child["node_id"]) for child in child_rows]
            return tuple(values) if node_type == "tuple" else values
        if child_rows:
            raise ValueError("scalar draft node cannot have children")
        if node_type == "string":
            return row["text_value"]
        if node_type == "integer":
            return row["integer_value"]
        if node_type == "real":
            return row["real_value"]
        if node_type == "boolean":
            return bool(row["integer_value"])
        if node_type == "null":
            return None
        raise ValueError(f"unknown structured draft node type: {node_type}")

    root = build(roots[0]["node_id"])
    if not isinstance(root, Mapping):
        raise ValueError("structured resume draft root must be a mapping")
    return root


def _json_dump(value: object) -> str:
    return json.dumps(
        value,
        default=_json_default,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _json_default(value: object) -> object:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return _datetime_text(value)
    fields = getattr(value, "__dataclass_fields__", None)
    if fields is not None:
        return {name: getattr(value, name) for name in fields}
    raise TypeError(f"Object is not JSON serializable: {type(value).__name__}")


def _json_load(value: str) -> Any:
    return json.loads(value)


def _datetime_text(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _datetime_value(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def _required_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value)


_PROFILE_VALUE_FIELDS = (
    ("profile_target_roles", "target_roles"),
    ("profile_locations", "locations"),
    ("profile_employment_types", "employment_types"),
    ("profile_seniority", "seniority"),
    ("profile_include_keywords", "include_keywords"),
    ("profile_exclude_keywords", "exclude_keywords"),
)


def _replace_profile_values(connection: sqlite3.Connection, profile: SearchProfile) -> None:
    for table, attribute in _PROFILE_VALUE_FIELDS:
        connection.execute(f"DELETE FROM {table} WHERE profile_id = ?", (profile.id,))
        connection.executemany(
            f"INSERT INTO {table} (profile_id, position, value) VALUES (?, ?, ?)",
            (
                (profile.id, position, value)
                for position, value in enumerate(getattr(profile, attribute))
            ),
        )


def _profile_values(connection: sqlite3.Connection, table: str, profile_id: str) -> tuple[str, ...]:
    if table not in {item[0] for item in _PROFILE_VALUE_FIELDS}:
        raise ValueError(f"Unknown profile value table: {table}")
    rows = connection.execute(
        f"SELECT value FROM {table} WHERE profile_id = ? ORDER BY position",
        (profile_id,),
    ).fetchall()
    return tuple(row["value"] for row in rows)
