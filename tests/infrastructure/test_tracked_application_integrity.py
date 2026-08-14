from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from roleloop.application import ProfileDraft, RoleLoopService
from roleloop.domain import (
    ActorKind,
    AgentProvider,
    ApplicationStage,
    ApplicationStageEvent,
    TrackedApplication,
)
from roleloop.infrastructure import (
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
    SystemClock,
    UUID4Generator,
)


def _native_application_fixture(
    tmp_path,
) -> tuple[SQLiteDatabase, SQLiteUnitOfWorkFactory, TrackedApplication]:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    service = RoleLoopService(factory, SystemClock(), UUID4Generator())
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    case = service.add_job_url(profile.id, "https://example.test/native-application")
    now = datetime(2026, 8, 14, 12, tzinfo=UTC)
    timestamp = now.isoformat()
    primary_checksum = "a" * 64
    alternate_checksum = "b" * 64

    with database.connect() as connection:
        profile_version_id = connection.execute(
            "SELECT current_version_id FROM profiles WHERE id = ?", (profile.id,)
        ).fetchone()[0]
        job_version_id = connection.execute(
            "SELECT current_version_id FROM jobs WHERE id = ?", (case.job_id,)
        ).fetchone()[0]
        connection.execute(
            """
            INSERT INTO search_profile_versions (
                id, profile_id, version_number, name, target_roles_json,
                locations_json, remote_preference, employment_types_json,
                seniority_json, annual_salary_floor, salary_currency,
                include_keywords_json, exclude_keywords_json, constraints_text,
                agent_provider, residence_country, timezone,
                target_hq_countries_json, startup_required,
                accepted_remote_arrangements_json,
                accepted_hiring_arrangements_json, search_queries_json,
                paper_size, page_limit, legacy_input_status, created_at
            )
            SELECT
                'profile-version-alternate', profile_id, version_number + 1,
                name || ' alternate', target_roles_json, locations_json,
                remote_preference, employment_types_json, seniority_json,
                annual_salary_floor, salary_currency, include_keywords_json,
                exclude_keywords_json, constraints_text, agent_provider,
                residence_country, timezone, target_hq_countries_json,
                startup_required, accepted_remote_arrangements_json,
                accepted_hiring_arrangements_json, search_queries_json,
                paper_size, page_limit, legacy_input_status, created_at
            FROM search_profile_versions WHERE id = ?
            """,
            (profile_version_id,),
        )
        connection.execute(
            """
            INSERT INTO job_versions (
                id, job_id, version_number, content_fingerprint, canonical_url,
                title, company, location, description, source, employment_type,
                seniority, salary_min, salary_max, salary_currency,
                external_requisition_id, listing_closed, hq_country, startup,
                work_authorization_required, us_only, remote_from_ecuador,
                remote_arrangement, hiring_arrangement, legacy_input_status,
                observed_at
            )
            SELECT
                'job-version-alternate', job_id, version_number + 1, ?,
                canonical_url, title || ' alternate', company, location,
                description, source, employment_type, seniority, salary_min,
                salary_max, salary_currency, external_requisition_id,
                listing_closed, hq_country, startup, work_authorization_required,
                us_only, remote_from_ecuador, remote_arrangement,
                hiring_arrangement, legacy_input_status, observed_at
            FROM job_versions WHERE id = ?
            """,
            ("c" * 64, job_version_id),
        )
        connection.executemany(
            """
            INSERT INTO artifacts (
                id, checksum, uri, media_type, size_bytes, created_at, legacy
            ) VALUES (?, ?, ?, 'application/pdf', 9, ?, 0)
            """,
            (
                ("pdf-primary", primary_checksum, "managed/pdf-primary", timestamp),
                ("pdf-alternate", alternate_checksum, "managed/pdf-alternate", timestamp),
            ),
        )
        connection.executemany(
            """
            INSERT INTO evidence_versions (
                id, profile_id, source_kind, source_name, artifact_id,
                artifact_checksum, artifact_uri, artifact_media_type,
                artifact_size_bytes, extracted_text, created_at
            ) VALUES (
                ?, ?, 'text_file', ?, ?, ?, ?, 'text/plain', 8, 'evidence', ?
            )
            """,
            (
                (
                    "evidence-primary",
                    profile.id,
                    "primary.txt",
                    "evidence-artifact-primary",
                    "d" * 64,
                    "managed/evidence-primary",
                    timestamp,
                ),
                (
                    "evidence-alternate",
                    profile.id,
                    "alternate.txt",
                    "evidence-artifact-alternate",
                    "e" * 64,
                    "managed/evidence-alternate",
                    timestamp,
                ),
            ),
        )
        connection.executemany(
            """
            INSERT INTO review_versions (
                id, job_case_id, fingerprint, analyzer_version, created_at,
                job_version_id, profile_version_id, evidence_version_id,
                answer_set_fingerprint, screen_set_fingerprint,
                recommended_decision, legacy_input_status, confidence,
                positioning, self_critique
            ) VALUES (?, ?, ?, 'reviewer-v1', ?, ?, ?, ?, ?, ?, 'tailor',
                      'native', 0.8, 'positioning', 'critique')
            """,
            (
                (
                    "review-primary",
                    case.id,
                    "review-fingerprint-primary",
                    timestamp,
                    job_version_id,
                    profile_version_id,
                    "evidence-primary",
                    "answer-primary",
                    "screen-primary",
                ),
                (
                    "review-alternate",
                    case.id,
                    "review-fingerprint-alternate",
                    timestamp,
                    "job-version-alternate",
                    "profile-version-alternate",
                    "evidence-alternate",
                    "answer-alternate",
                    "screen-alternate",
                ),
            ),
        )
        connection.executemany(
            """
            INSERT INTO case_decision_events (
                id, command_id, job_case_id, decision, reason, actor,
                review_version_id, job_version_id, profile_version_id,
                evidence_version_id, answer_set_fingerprint, rationale, decided_at
            ) VALUES (?, ?, ?, 'tailor', 'human_choice', 'human', ?, ?, ?, ?, ?, '', ?)
            """,
            (
                (
                    "gate-primary",
                    "gate-command-primary",
                    case.id,
                    "review-primary",
                    job_version_id,
                    profile_version_id,
                    "evidence-primary",
                    "answer-primary",
                    timestamp,
                ),
                (
                    "gate-alternate",
                    "gate-command-alternate",
                    case.id,
                    "review-alternate",
                    "job-version-alternate",
                    "profile-version-alternate",
                    "evidence-alternate",
                    "answer-alternate",
                    timestamp,
                ),
            ),
        )
        connection.executemany(
            """
            INSERT INTO resume_runs (
                id, job_case_id, review_version_id, evidence_version_id,
                input_fingerprint, stage, generator_version, validator_version,
                compiler_version, artifact_id, artifact_checksum, artifact_uri,
                artifact_media_type, artifact_size_bytes, created_at, updated_at,
                gate_decision_event_id, job_version_id, profile_version_id
            ) VALUES (?, ?, ?, ?, ?, 'ready', 'resume-v1', 'validator-v1',
                      'renderer-v1', ?, ?, ?, 'application/pdf', 9, ?, ?, ?, ?, ?)
            """,
            (
                (
                    "resume-primary",
                    case.id,
                    "review-primary",
                    "evidence-primary",
                    "input-primary",
                    "pdf-primary",
                    primary_checksum,
                    "managed/pdf-primary",
                    timestamp,
                    timestamp,
                    "gate-primary",
                    job_version_id,
                    profile_version_id,
                ),
                (
                    "resume-alternate",
                    case.id,
                    "review-alternate",
                    "evidence-alternate",
                    "input-alternate",
                    "pdf-alternate",
                    alternate_checksum,
                    "managed/pdf-alternate",
                    timestamp,
                    timestamp,
                    "gate-alternate",
                    "job-version-alternate",
                    "profile-version-alternate",
                ),
            ),
        )
        connection.executemany(
            """
            INSERT INTO resume_review_events (
                id, command_id, resume_run_id, decision, actor, feedback,
                pdf_artifact_id, pdf_checksum, created_at
            ) VALUES (?, ?, ?, 'approved', 'human', '', ?, ?, ?)
            """,
            (
                (
                    "approval-primary",
                    "approval-command-primary",
                    "resume-primary",
                    "pdf-primary",
                    primary_checksum,
                    timestamp,
                ),
                (
                    "approval-alternate",
                    "approval-command-alternate",
                    "resume-alternate",
                    "pdf-alternate",
                    alternate_checksum,
                    timestamp,
                ),
            ),
        )

    application = TrackedApplication(
        id="application",
        command_id="application-command",
        job_id=case.job_id,
        job_case_id=case.id,
        current_stage=ApplicationStage.SUBMITTED,
        approved_resume_review_event_id="approval-primary",
        resume_run_id="resume-primary",
        pdf_artifact_id="pdf-primary",
        pdf_checksum=primary_checksum,
        job_version_id=str(job_version_id),
        profile_version_id=str(profile_version_id),
        evidence_version_id="evidence-primary",
        review_version_id="review-primary",
        gate_decision_event_id="gate-primary",
        submitted_at=now,
        revision=1,
        created_at=now,
        updated_at=now,
    )
    with factory() as uow:
        uow.tracked_applications.add(application)
        uow.tracked_applications.add_stage(
            ApplicationStageEvent(
                id="stage-submitted",
                command_id="stage-command-submitted",
                application_id=application.id,
                stage=ApplicationStage.SUBMITTED,
                actor=ActorKind.HUMAN,
                occurred_at=now,
                recorded_at=now,
            )
        )
        uow.commit()
    return database, factory, application


def test_sqlite_rejects_valid_wholesale_application_provenance_replacement(tmp_path) -> None:
    database, _, application = _native_application_fixture(tmp_path)

    with database.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match="provenance is immutable"):
            connection.execute(
                """
                UPDATE tracked_applications SET
                    approved_resume_review_event_id = 'approval-alternate',
                    resume_run_id = 'resume-alternate',
                    pdf_artifact_id = 'pdf-alternate', pdf_checksum = ?,
                    job_version_id = 'job-version-alternate',
                    profile_version_id = 'profile-version-alternate',
                    evidence_version_id = 'evidence-alternate',
                    review_version_id = 'review-alternate',
                    gate_decision_event_id = 'gate-alternate',
                    revision = revision + 1, updated_at = ?
                WHERE id = ?
                """,
                ("b" * 64, datetime(2026, 8, 15, tzinfo=UTC).isoformat(), application.id),
            )
        stored = connection.execute(
            """
            SELECT approved_resume_review_event_id, resume_run_id, pdf_artifact_id,
                   pdf_checksum, job_version_id, profile_version_id,
                   evidence_version_id, review_version_id, gate_decision_event_id,
                   revision
            FROM tracked_applications WHERE id = ?
            """,
            (application.id,),
        ).fetchone()
        assert tuple(stored) == (
            "approval-primary",
            "resume-primary",
            "pdf-primary",
            "a" * 64,
            application.job_version_id,
            application.profile_version_id,
            "evidence-primary",
            "review-primary",
            "gate-primary",
            1,
        )


def test_repository_stage_update_cannot_rewrite_pinned_application_inputs(tmp_path) -> None:
    _, factory, application = _native_application_fixture(tmp_path)
    now = datetime(2026, 8, 15, tzinfo=UTC)

    with factory() as uow:
        uow.tracked_applications.add_stage(
            ApplicationStageEvent(
                id="stage-acknowledged",
                command_id="stage-command-acknowledged",
                application_id=application.id,
                stage=ApplicationStage.ACKNOWLEDGED,
                actor=ActorKind.HUMAN,
                occurred_at=now,
                recorded_at=now,
            )
        )
        caller_supplied = replace(
            application,
            current_stage=ApplicationStage.ACKNOWLEDGED,
            approved_resume_review_event_id="approval-alternate",
            resume_run_id="resume-alternate",
            pdf_artifact_id="pdf-alternate",
            pdf_checksum="b" * 64,
            job_version_id="job-version-alternate",
            profile_version_id="profile-version-alternate",
            evidence_version_id="evidence-alternate",
            review_version_id="review-alternate",
            gate_decision_event_id="gate-alternate",
            revision=2,
            updated_at=now,
        )
        assert uow.tracked_applications.update(caller_supplied, expected_revision=1)
        uow.commit()

    with factory() as uow:
        stored = uow.tracked_applications.get(application.id)
        assert stored is not None
        assert stored.current_stage is ApplicationStage.ACKNOWLEDGED
        assert stored.revision == 2
        assert stored.updated_at == now
        assert stored.approved_resume_review_event_id == "approval-primary"
        assert stored.resume_run_id == "resume-primary"
        assert stored.pdf_artifact_id == "pdf-primary"
        assert stored.pdf_checksum == "a" * 64
        assert stored.job_version_id == application.job_version_id
        assert stored.profile_version_id == application.profile_version_id
        assert stored.evidence_version_id == "evidence-primary"
        assert stored.review_version_id == "review-primary"
        assert stored.gate_decision_event_id == "gate-primary"
