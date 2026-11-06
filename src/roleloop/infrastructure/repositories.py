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
    JobIdentityKey,
    JobIdentityKind,
    Outcome,
    OutcomeEvent,
    QuestionCategory,
    RemotePreference,
    ResumeEvidenceVersion,
    ResumeExperienceSelection,
    ResumeRun,
    ResumeSource,
    ResumeSourceKind,
    ResumeStage,
    ReviewQuestion,
    ReviewRequirement,
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
                created_at, updated_at, current_version_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                active_evidence_version_id = ?, created_at = ?, updated_at = ?,
                current_version_id = ?
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
        _catalog_artifact(self._connection, artifact)
        if evidence.canonical_evidence_artifact is not None:
            _catalog_artifact(self._connection, evidence.canonical_evidence_artifact)
        if evidence.source_bundle_artifact is not None:
            _catalog_artifact(self._connection, evidence.source_bundle_artifact)
        self._connection.execute(
            """
            INSERT INTO evidence_versions (
                id, profile_id, source_kind, source_name, artifact_id,
                artifact_checksum, artifact_uri, artifact_media_type,
                artifact_size_bytes, extracted_text, created_at, resume_source_id,
                source_revision, resume_source_kind, source_repository, source_ref,
                source_document_path, contract_schema_version,
                canonical_evidence_artifact_id, source_bundle_artifact_id,
                renderer_protocol_version, renderer_version, contract_checksum
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?)
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
                evidence.resume_source_id,
                evidence.source_revision,
                (
                    None
                    if evidence.resume_source_kind is None
                    else evidence.resume_source_kind.value
                ),
                evidence.source_repository,
                evidence.source_ref,
                evidence.source_document_path,
                evidence.contract_schema_version,
                (
                    None
                    if evidence.canonical_evidence_artifact is None
                    else evidence.canonical_evidence_artifact.id
                ),
                (
                    None
                    if evidence.source_bundle_artifact is None
                    else evidence.source_bundle_artifact.id
                ),
                evidence.renderer_protocol_version,
                evidence.renderer_version,
                evidence.contract_checksum,
            ),
        )

    def get(self, evidence_id: str) -> ResumeEvidenceVersion | None:
        row = self._connection.execute(
            "SELECT * FROM evidence_versions WHERE id = ?", (evidence_id,)
        ).fetchone()
        return None if row is None else _evidence_from_row(self._connection, row)

    def list_for_profile(self, profile_id: str) -> Sequence[ResumeEvidenceVersion]:
        rows = self._connection.execute(
            """
            SELECT * FROM evidence_versions
            WHERE profile_id = ?
            ORDER BY created_at, id
            """,
            (profile_id,),
        ).fetchall()
        return tuple(_evidence_from_row(self._connection, row) for row in rows)


class SQLiteResumeSourcesRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, source: ResumeSource) -> None:
        self._connection.execute(
            """
            INSERT INTO resume_sources (
                id, profile_id, kind, repository, ref, document_path,
                last_synced_revision, last_synced_checksum,
                last_synced_evidence_version_id, last_synced_at, revision,
                created_at, updated_at, trust_acknowledged_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _resume_source_parameters(source),
        )

    def get(self, source_id: str) -> ResumeSource | None:
        row = self._connection.execute(
            "SELECT * FROM resume_sources WHERE id = ?", (source_id,)
        ).fetchone()
        return None if row is None else _resume_source_from_row(row)

    def get_for_profile(self, profile_id: str) -> ResumeSource | None:
        row = self._connection.execute(
            "SELECT * FROM resume_sources WHERE profile_id = ?", (profile_id,)
        ).fetchone()
        return None if row is None else _resume_source_from_row(row)

    def update(self, source: ResumeSource, *, expected_revision: int) -> bool:
        cursor = self._connection.execute(
            """
            UPDATE resume_sources SET
                profile_id = ?, kind = ?, repository = ?, ref = ?, document_path = ?,
                last_synced_revision = ?, last_synced_checksum = ?,
                last_synced_evidence_version_id = ?, last_synced_at = ?, revision = ?,
                created_at = ?, updated_at = ?, trust_acknowledged_at = ?
            WHERE id = ? AND revision = ?
            """,
            (*_resume_source_parameters(source)[1:], source.id, expected_revision),
        )
        return cursor.rowcount == 1


class SQLiteJobsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, job: Job) -> None:
        self._connection.execute(
            """
            INSERT INTO jobs (
                id, canonical_url, title, company, location, description, source,
                source_metadata_json, revision, created_at, updated_at, current_version_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _job_parameters(job),
        )

    def get(self, job_id: str) -> Job | None:
        row = self._connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return None if row is None else _job_from_row(self._connection, row)

    def get_by_canonical_url(self, canonical_url: str) -> Job | None:
        row = self._connection.execute(
            "SELECT * FROM jobs WHERE canonical_url = ?", (canonical_url,)
        ).fetchone()
        return None if row is None else _job_from_row(self._connection, row)

    def get_by_identity_key(self, key: str) -> Job | None:
        row = self._connection.execute(
            """
            SELECT j.* FROM job_identity_keys i
            JOIN jobs j ON j.id = i.job_id
            WHERE i.key = ?
            """,
            (key,),
        ).fetchone()
        return None if row is None else _job_from_row(self._connection, row)

    def add_identity_key(self, identity: JobIdentityKey) -> bool:
        existing = self._connection.execute(
            "SELECT job_id FROM job_identity_keys WHERE key = ?", (identity.key,)
        ).fetchone()
        if existing is not None:
            return bool(existing["job_id"] == identity.job_id)
        self._connection.execute(
            """
            INSERT INTO job_identity_keys (key, job_id, key_kind, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                identity.key,
                identity.job_id,
                identity.kind.value,
                _datetime_text(identity.created_at),
            ),
        )
        return True

    def list_identity_keys(self, job_id: str) -> Sequence[JobIdentityKey]:
        rows = self._connection.execute(
            """
            SELECT * FROM job_identity_keys
            WHERE job_id = ? ORDER BY key_kind, key
            """,
            (job_id,),
        ).fetchall()
        return tuple(
            JobIdentityKey(
                key=row["key"],
                job_id=row["job_id"],
                kind=JobIdentityKind(row["key_kind"]),
                created_at=_datetime_value(row["created_at"]),
            )
            for row in rows
        )

    def update(self, job: Job, *, expected_revision: int) -> bool:
        cursor = self._connection.execute(
            """
            UPDATE jobs SET
                canonical_url = ?, title = ?, company = ?, location = ?,
                description = ?, source = ?, source_metadata_json = ?, revision = ?,
                created_at = ?, updated_at = ?, current_version_id = ?
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
                created_at, updated_at, current_decision_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                revision = ?, created_at = ?, updated_at = ?,
                current_decision_event_id = ?
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
                id, job_case_id, fingerprint, analyzer_version, created_at,
                agent_run_id, job_version_id, profile_version_id,
                evidence_version_id, answer_set_fingerprint,
                screen_set_fingerprint, recommended_decision,
                legacy_input_status, confidence, positioning, self_critique
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                qualifying_answer, source_anchor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
                    question.source_anchor,
                )
                for position, question in enumerate(review.questions)
            ),
        )
        self._connection.executemany(
            """
            INSERT INTO review_requirements (
                review_version_id, position, requirement_key, text_value,
                evidence, required, source_anchor
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    review.id,
                    position,
                    requirement.key,
                    requirement.text,
                    requirement.evidence,
                    int(requirement.required),
                    requirement.source_anchor,
                )
                for position, requirement in enumerate(review.requirements)
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
        _catalog_run_artifacts(self._connection, run)
        self._connection.execute(
            """
            INSERT INTO resume_runs (
                id, job_case_id, review_version_id, evidence_version_id,
                input_fingerprint, stage, generator_version, validator_version,
                compiler_version, artifact_id, artifact_checksum, artifact_uri,
                artifact_media_type, artifact_size_bytes, error_message, created_at,
                updated_at, agent_run_id, parent_resume_run_id,
                feedback_review_event_id, gate_decision_event_id, job_version_id,
                profile_version_id, answer_set_fingerprint, headline,
                selection_artifact_id, tailored_source_bundle_artifact_id,
                render_receipt_artifact_id,
                review_file_artifact_id, compile_log_artifact_id,
                ats_text_artifact_id, rendered_page_count, renderer_source_revision,
                render_tool_versions_json, render_output_checksums_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _resume_run_parameters(run),
        )
        _replace_resume_children(self._connection, run)
        _insert_resume_selection(self._connection, run)

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
        _catalog_run_artifacts(self._connection, run)
        cursor = self._connection.execute(
            """
            UPDATE resume_runs SET
                job_case_id = ?, review_version_id = ?, evidence_version_id = ?,
                input_fingerprint = ?, stage = ?, generator_version = ?,
                validator_version = ?, compiler_version = ?, artifact_id = ?,
                artifact_checksum = ?, artifact_uri = ?, artifact_media_type = ?,
                artifact_size_bytes = ?, error_message = ?, created_at = ?, updated_at = ?
                , agent_run_id = ?, parent_resume_run_id = ?,
                feedback_review_event_id = ?, gate_decision_event_id = ?,
                job_version_id = ?, profile_version_id = ?,
                answer_set_fingerprint = ?, headline = ?, selection_artifact_id = ?,
                tailored_source_bundle_artifact_id = ?,
                render_receipt_artifact_id = ?, review_file_artifact_id = ?,
                compile_log_artifact_id = ?, ats_text_artifact_id = ?,
                rendered_page_count = ?, renderer_source_revision = ?,
                render_tool_versions_json = ?, render_output_checksums_json = ?
            WHERE id = ?
            """,
            (*_resume_run_parameters(run)[1:], run.id),
        )
        if cursor.rowcount != 1:
            raise KeyError(f"Resume run does not exist: {run.id}")
        _replace_resume_children(self._connection, run)
        selection_count = self._connection.execute(
            """
            SELECT count(*) FROM resume_selected_experiences
            WHERE resume_run_id = ?
            """,
            (run.id,),
        ).fetchone()[0]
        if selection_count == 0 and run.selected_experiences:
            _insert_resume_selection(self._connection, run)


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
        profile.current_version_id,
    )


def _resume_source_parameters(source: ResumeSource) -> tuple[object, ...]:
    return (
        source.id,
        source.profile_id,
        source.kind.value,
        source.repository,
        source.ref,
        source.document_path,
        source.last_synced_revision,
        source.last_synced_checksum,
        source.last_synced_evidence_version_id,
        _datetime_text(source.last_synced_at),
        source.revision,
        _datetime_text(source.created_at),
        _datetime_text(source.updated_at),
        _datetime_text(source.trust_acknowledged_at),
    )


def _resume_source_from_row(row: sqlite3.Row) -> ResumeSource:
    return ResumeSource(
        id=row["id"],
        profile_id=row["profile_id"],
        kind=ResumeSourceKind(row["kind"]),
        repository=row["repository"],
        ref=row["ref"],
        document_path=row["document_path"],
        trust_acknowledged_at=_datetime_value(row["trust_acknowledged_at"]),
        last_synced_revision=row["last_synced_revision"],
        last_synced_checksum=row["last_synced_checksum"],
        last_synced_evidence_version_id=row["last_synced_evidence_version_id"],
        last_synced_at=_datetime_value(row["last_synced_at"]),
        revision=row["revision"],
        created_at=_datetime_value(row["created_at"]),
        updated_at=_datetime_value(row["updated_at"]),
    )


def _profile_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> SearchProfile:
    version = None
    if row["current_version_id"] is not None:
        from .authoritative_repositories import SQLiteProfileVersionsRepository

        version = SQLiteProfileVersionsRepository(connection).get(row["current_version_id"])
    return SearchProfile(
        id=row["id"],
        name=row["name"] if version is None else version.name,
        target_roles=(
            _profile_values(connection, "profile_target_roles", row["id"])
            if version is None
            else version.target_roles
        ),
        locations=(
            _profile_values(connection, "profile_locations", row["id"])
            if version is None
            else version.locations
        ),
        remote_preference=(
            RemotePreference(row["remote_preference"])
            if version is None
            else version.remote_preference
        ),
        employment_types=(
            _profile_values(connection, "profile_employment_types", row["id"])
            if version is None
            else version.employment_types
        ),
        seniority=(
            _profile_values(connection, "profile_seniority", row["id"])
            if version is None
            else version.seniority
        ),
        annual_salary_floor=(
            row["annual_salary_floor"] if version is None else version.annual_salary_floor
        ),
        salary_currency=row["salary_currency"] if version is None else version.salary_currency,
        include_keywords=(
            _profile_values(connection, "profile_include_keywords", row["id"])
            if version is None
            else version.include_keywords
        ),
        exclude_keywords=(
            _profile_values(connection, "profile_exclude_keywords", row["id"])
            if version is None
            else version.exclude_keywords
        ),
        constraints=row["constraints_text"] if version is None else version.constraints,
        revision=row["revision"],
        is_active=bool(row["is_active"]),
        active_evidence_version_id=row["active_evidence_version_id"],
        created_at=_datetime_value(row["created_at"]),
        updated_at=_datetime_value(row["updated_at"]),
        current_version_id=row["current_version_id"],
        residence_country=("Ecuador" if version is None else version.residence_country),
        timezone=("America/Guayaquil" if version is None else version.timezone),
        target_hq_countries=(() if version is None else version.target_hq_countries),
        startup_required=False if version is None else version.startup_required,
        accepted_remote_arrangements=(
            () if version is None else version.accepted_remote_arrangements
        ),
        accepted_hiring_arrangements=(
            () if version is None else version.accepted_hiring_arrangements
        ),
        search_queries=(() if version is None else version.search_queries),
        paper_size="a4paper" if version is None else version.paper_size,
        page_limit=2 if version is None else version.page_limit,
        agent_configurations=(() if version is None else version.agent_configurations),
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
        job.current_version_id,
    )


def _job_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> Job:
    version = None
    if row["current_version_id"] is not None:
        from .authoritative_repositories import SQLiteJobVersionsRepository

        version = SQLiteJobVersionsRepository(connection).get(row["current_version_id"])
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
        current_version_id=row["current_version_id"],
        listing_closed=None if version is None else version.listing_closed,
        hq_country=None if version is None else version.hq_country,
        startup=None if version is None else version.startup,
        work_authorization_required=(
            None if version is None else version.work_authorization_required
        ),
        us_only=None if version is None else version.us_only,
        remote_from_ecuador=None if version is None else version.remote_from_ecuador,
        remote_arrangement=None if version is None else version.remote_arrangement,
        hiring_arrangement=None if version is None else version.hiring_arrangement,
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
        case.current_decision_event_id,
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
        current_decision_event_id=row["current_decision_event_id"],
    )


def _evidence_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> ResumeEvidenceVersion:
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
        resume_source_id=row["resume_source_id"],
        source_revision=row["source_revision"],
        resume_source_kind=(
            None
            if row["resume_source_kind"] is None
            else ResumeSourceKind(row["resume_source_kind"])
        ),
        source_repository=row["source_repository"],
        source_ref=row["source_ref"],
        source_document_path=row["source_document_path"],
        contract_schema_version=row["contract_schema_version"],
        canonical_evidence_artifact=_cataloged_artifact(
            connection, row["canonical_evidence_artifact_id"]
        ),
        source_bundle_artifact=_cataloged_artifact(connection, row["source_bundle_artifact_id"]),
        renderer_protocol_version=row["renderer_protocol_version"],
        renderer_version=row["renderer_version"],
        contract_checksum=row["contract_checksum"],
    )


def _review_parameters(review: ReviewVersion) -> tuple[object, ...]:
    return (
        review.id,
        review.job_case_id,
        review.fingerprint,
        review.analyzer_version,
        _datetime_text(review.created_at),
        review.agent_run_id,
        review.job_version_id,
        review.profile_version_id,
        review.evidence_version_id,
        review.answer_set_fingerprint,
        review.screen_set_fingerprint,
        review.recommended_decision.value,
        review.legacy_input_status,
        review.confidence,
        review.positioning,
        review.self_critique,
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
    requirement_rows = connection.execute(
        """
        SELECT * FROM review_requirements
        WHERE review_version_id = ? ORDER BY position
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
                source_anchor=question["source_anchor"],
            )
            for question in question_rows
        ),
        created_at=_required_datetime(row["created_at"]),
        agent_run_id=row["agent_run_id"],
        job_version_id=row["job_version_id"],
        profile_version_id=row["profile_version_id"],
        evidence_version_id=row["evidence_version_id"],
        answer_set_fingerprint=row["answer_set_fingerprint"],
        screen_set_fingerprint=row["screen_set_fingerprint"],
        recommended_decision=Decision(row["recommended_decision"]),
        legacy_input_status=row["legacy_input_status"],
        requirements=tuple(
            ReviewRequirement(
                key=item["requirement_key"],
                text=item["text_value"],
                evidence=item["evidence"],
                required=bool(item["required"]),
                source_anchor=item["source_anchor"],
            )
            for item in requirement_rows
        ),
        confidence=row["confidence"],
        positioning=row["positioning"],
        self_critique=row["self_critique"],
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
        run.agent_run_id,
        run.parent_resume_run_id,
        run.feedback_review_event_id,
        run.gate_decision_event_id,
        run.job_version_id,
        run.profile_version_id,
        run.answer_set_fingerprint,
        run.headline,
        None if run.selection_artifact is None else run.selection_artifact.id,
        (
            None
            if run.tailored_source_bundle_artifact is None
            else run.tailored_source_bundle_artifact.id
        ),
        None if run.render_receipt_artifact is None else run.render_receipt_artifact.id,
        None if run.review_file_artifact is None else run.review_file_artifact.id,
        None if run.compile_log_artifact is None else run.compile_log_artifact.id,
        None if run.ats_text_artifact is None else run.ats_text_artifact.id,
        run.rendered_page_count,
        run.renderer_source_revision,
        _json_dump(run.render_tool_versions),
        _json_dump(run.render_output_checksums),
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
    experience_rows = connection.execute(
        """
        SELECT * FROM resume_selected_experiences
        WHERE resume_run_id = ? ORDER BY position
        """,
        (row["id"],),
    ).fetchall()
    selected_experiences = tuple(
        ResumeExperienceSelection(
            experience_id=item["experience_id"],
            bullet_ids=tuple(
                bullet["bullet_id"]
                for bullet in connection.execute(
                    """
                    SELECT bullet_id FROM resume_selected_bullets
                    WHERE resume_run_id = ? AND experience_position = ?
                    ORDER BY position
                    """,
                    (row["id"], item["position"]),
                ).fetchall()
            ),
        )
        for item in experience_rows
    )
    skill_rows = connection.execute(
        """
        SELECT skill_id FROM resume_selected_skills
        WHERE resume_run_id = ? ORDER BY position
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
        agent_run_id=row["agent_run_id"],
        parent_resume_run_id=row["parent_resume_run_id"],
        feedback_review_event_id=row["feedback_review_event_id"],
        gate_decision_event_id=row["gate_decision_event_id"],
        job_version_id=row["job_version_id"],
        profile_version_id=row["profile_version_id"],
        answer_set_fingerprint=row["answer_set_fingerprint"],
        headline=row["headline"],
        selected_bullet_ids=tuple(
            bullet_id for experience in selected_experiences for bullet_id in experience.bullet_ids
        ),
        selected_skill_ids=tuple(item["skill_id"] for item in skill_rows),
        selection_artifact=_cataloged_artifact(connection, row["selection_artifact_id"]),
        tailored_source_bundle_artifact=_cataloged_artifact(
            connection, row["tailored_source_bundle_artifact_id"]
        ),
        render_receipt_artifact=_cataloged_artifact(connection, row["render_receipt_artifact_id"]),
        selected_experiences=selected_experiences,
        review_file_artifact=_cataloged_artifact(connection, row["review_file_artifact_id"]),
        compile_log_artifact=_cataloged_artifact(connection, row["compile_log_artifact_id"]),
        ats_text_artifact=_cataloged_artifact(connection, row["ats_text_artifact_id"]),
        rendered_page_count=row["rendered_page_count"],
        renderer_source_revision=row["renderer_source_revision"],
        render_tool_versions=_json_load(row["render_tool_versions_json"]),
        render_output_checksums=_json_load(row["render_output_checksums_json"]),
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


def _insert_resume_selection(connection: sqlite3.Connection, run: ResumeRun) -> None:
    connection.executemany(
        """
        INSERT INTO resume_selected_experiences (
            resume_run_id, position, experience_id
        ) VALUES (?, ?, ?)
        """,
        (
            (run.id, position, item.experience_id)
            for position, item in enumerate(run.selected_experiences)
        ),
    )
    connection.executemany(
        """
        INSERT INTO resume_selected_bullets (
            resume_run_id, experience_position, position, bullet_id
        ) VALUES (?, ?, ?, ?)
        """,
        (
            (run.id, experience_position, bullet_position, bullet_id)
            for experience_position, experience in enumerate(run.selected_experiences)
            for bullet_position, bullet_id in enumerate(experience.bullet_ids)
        ),
    )
    connection.executemany(
        """
        INSERT INTO resume_selected_skills (resume_run_id, position, skill_id)
        VALUES (?, ?, ?)
        """,
        ((run.id, position, skill_id) for position, skill_id in enumerate(run.selected_skill_ids)),
    )


def _catalog_run_artifacts(connection: sqlite3.Connection, run: ResumeRun) -> None:
    for artifact in (
        run.artifact,
        run.selection_artifact,
        run.tailored_source_bundle_artifact,
        run.render_receipt_artifact,
        run.review_file_artifact,
        run.compile_log_artifact,
        run.ats_text_artifact,
    ):
        if artifact is not None:
            _catalog_artifact(connection, artifact)


def _catalog_artifact(connection: sqlite3.Connection, artifact: ArtifactRef) -> None:
    connection.execute(
        """
        INSERT INTO artifacts (
            id, checksum, uri, media_type, size_bytes, created_at, legacy
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT (id) DO NOTHING
        """,
        (
            artifact.id,
            artifact.checksum,
            artifact.uri,
            artifact.media_type,
            artifact.size_bytes,
            int(len(artifact.checksum) != 64),
        ),
    )
    stored = connection.execute(
        "SELECT checksum, uri, media_type, size_bytes FROM artifacts WHERE id = ?",
        (artifact.id,),
    ).fetchone()
    if stored is None or (
        stored["checksum"],
        stored["uri"],
        stored["media_type"],
        stored["size_bytes"],
    ) != (
        artifact.checksum,
        artifact.uri,
        artifact.media_type,
        artifact.size_bytes,
    ):
        raise ValueError(
            f"artifact ID {artifact.id!r} was reused with different immutable metadata"
        )


def _cataloged_artifact(
    connection: sqlite3.Connection, artifact_id: str | None
) -> ArtifactRef | None:
    if artifact_id is None:
        return None
    row = connection.execute("SELECT * FROM artifacts WHERE id = ?", (artifact_id,)).fetchone()
    if row is None:
        raise ValueError(f"cataloged artifact is missing: {artifact_id}")
    return ArtifactRef(
        id=row["id"],
        checksum=row["checksum"],
        uri=row["uri"],
        media_type=row["media_type"],
        size_bytes=row["size_bytes"],
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
