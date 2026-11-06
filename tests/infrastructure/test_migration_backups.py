from __future__ import annotations

import sqlite3
from importlib.resources import files
from pathlib import Path

from roleloop.domain import ResumeApprovalStatus, resume_approval_status
from roleloop.infrastructure import SQLiteDatabase, SQLiteUnitOfWorkFactory


def _version_two_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        for filename in ("001_initial.sql", "002_resume_sources.sql"):
            script = (
                files("roleloop.infrastructure.migrations")
                .joinpath(filename)
                .read_text(encoding="utf-8")
            )
            connection.executescript(script)
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.executemany(
            "INSERT INTO schema_migrations (version) VALUES (?)",
            ((1,), (2,)),
        )
        connection.execute(
            """
            INSERT INTO profiles (
                id, name, remote_preference, salary_currency, constraints_text,
                revision, is_active
            ) VALUES ('profile-before-upgrade', 'Before upgrade', 'any', 'USD', '', 1, 1)
            """
        )
        connection.commit()
    finally:
        connection.close()


def _seed_version_two_history(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        connection.execute(
            """
            INSERT INTO evidence_versions (
                id, profile_id, source_kind, source_name, artifact_id,
                artifact_checksum, artifact_uri, artifact_media_type,
                artifact_size_bytes, extracted_text, created_at
            ) VALUES (
                'legacy-evidence', 'profile-before-upgrade', 'text_file',
                'resume.md', 'legacy-source-artifact', 'legacy-source-checksum',
                'managed/legacy-source', 'text/markdown', 12, 'Legacy resume',
                '2026-08-01T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            UPDATE profiles SET active_evidence_version_id = 'legacy-evidence', revision = 2
            WHERE id = 'profile-before-upgrade'
            """
        )
        connection.execute(
            """
            INSERT INTO jobs (
                id, canonical_url, title, company, location, description, source,
                source_metadata_json, revision, created_at, updated_at
            ) VALUES (
                'legacy-job', 'https://example.test/legacy-job', 'Platform Engineer',
                'Example', 'Remote', 'Build services', 'manual', '{}', 1,
                '2026-08-01T12:00:00+00:00', '2026-08-01T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO job_cases (
                id, profile_id, job_id, decision, application_status,
                current_outcome, submitted_at, submitted_artifact_id, revision,
                created_at, updated_at
            ) VALUES (
                'legacy-case', 'profile-before-upgrade', 'legacy-job', 'tailor',
                'submitted', 'rejected', '2026-08-03T12:00:00+00:00',
                'legacy-pdf', 3, '2026-08-01T12:00:00+00:00',
                '2026-08-04T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO review_versions (
                id, job_case_id, fingerprint, analyzer_version, created_at
            ) VALUES (
                'legacy-review', 'legacy-case', 'legacy-review-fingerprint',
                'reviewer-v0', '2026-08-02T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO resume_runs (
                id, job_case_id, review_version_id, evidence_version_id,
                input_fingerprint, stage, generator_version, validator_version,
                compiler_version, artifact_id, artifact_checksum, artifact_uri,
                artifact_media_type, artifact_size_bytes, created_at, updated_at
            ) VALUES (
                'legacy-run', 'legacy-case', 'legacy-review', 'legacy-evidence',
                'legacy-resume-fingerprint', 'ready', 'generator-v0', 'validator-v0',
                'compiler-v0', 'legacy-pdf', 'legacy-pdf-checksum',
                'managed/legacy.pdf', 'application/pdf', 42,
                '2026-08-02T13:00:00+00:00', '2026-08-02T13:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO application_submissions (
                id, job_case_id, decision_at_submission, artifact_id, submitted_at
            ) VALUES (
                'legacy-submission', 'legacy-case', 'tailor', 'legacy-pdf',
                '2026-08-03T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO outcome_events (id, job_case_id, outcome, recorded_at)
            VALUES (
                'legacy-outcome', 'legacy-case', 'rejected',
                '2026-08-04T12:00:00+00:00'
            )
            """
        )
        connection.commit()
    finally:
        connection.close()


def _seed_version_two_outcome_history(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        connection.execute(
            """
            INSERT INTO jobs (
                id, canonical_url, title, company, location, description, source,
                source_metadata_json, revision, created_at, updated_at
            ) VALUES (
                'outcome-job', 'https://example.test/outcome-job', 'Systems Engineer',
                'Example', 'Remote', 'Build systems', 'manual', '{}', 1,
                '2026-07-01T12:00:00+00:00', '2026-07-01T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO job_cases (
                id, profile_id, job_id, decision, application_status,
                current_outcome, submitted_at, revision, created_at, updated_at
            ) VALUES (
                'outcome-case', 'profile-before-upgrade', 'outcome-job', 'tailor',
                'submitted', 'no_response', '2026-07-02T12:00:00+00:00', 2,
                '2026-07-01T12:00:00+00:00', '2026-07-06T12:00:00+00:00'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO application_submissions (
                id, job_case_id, decision_at_submission, submitted_at
            ) VALUES (
                'outcome-submission', 'outcome-case', 'tailor',
                '2026-07-02T12:00:00+00:00'
            )
            """
        )
        connection.executemany(
            """
            INSERT INTO outcome_events (id, job_case_id, outcome, recorded_at)
            VALUES (?, 'outcome-case', ?, ?)
            """,
            (
                (
                    "outcome-interviewing",
                    "interviewing",
                    "2026-07-03T12:00:00+00:00",
                ),
                ("outcome-offer", "offer", "2026-07-04T12:00:00+00:00"),
                ("outcome-rejected", "rejected", "2026-07-04T12:00:00+00:00"),
                ("outcome-withdrawn", "withdrawn", "2026-07-05T12:00:00+00:00"),
                ("outcome-no-response", "no_response", "2026-07-06T12:00:00+00:00"),
            ),
        )
        connection.commit()
    finally:
        connection.close()


def test_structural_upgrade_creates_a_timestamped_consistent_backup(tmp_path: Path) -> None:
    database_path = tmp_path / "roleloop.sqlite3"
    _version_two_database(database_path)

    upgraded = SQLiteDatabase(database_path).connect()
    assert [row[0] for row in upgraded.execute("SELECT version FROM schema_migrations")] == list(
        range(1, 8)
    )
    upgraded.close()

    backups = list(tmp_path.glob("roleloop.sqlite3.backup-*Z"))
    assert len(backups) == 1
    backup = sqlite3.connect(backups[0])
    try:
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert [row[0] for row in backup.execute("SELECT version FROM schema_migrations")] == [
            1,
            2,
        ]
        assert (
            backup.execute(
                "SELECT name FROM profiles WHERE id = 'profile-before-upgrade'"
            ).fetchone()[0]
            == "Before upgrade"
        )
        assert (
            backup.execute(
                "SELECT count(*) FROM sqlite_master WHERE name = 'search_profile_versions'"
            ).fetchone()[0]
            == 0
        )
    finally:
        backup.close()


def test_upgrade_marks_pre_v1_workflow_history_without_granting_v1_authority(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "roleloop.sqlite3"
    _version_two_database(database_path)
    _seed_version_two_history(database_path)

    upgraded = SQLiteDatabase(database_path).connect()
    try:
        review = upgraded.execute(
            """
            SELECT legacy_input_status, agent_run_id, job_version_id,
                   profile_version_id, evidence_version_id
            FROM review_versions WHERE id = 'legacy-review'
            """
        ).fetchone()
        assert tuple(review) == ("legacy_unreproducible", None, None, None, None)

        decision = upgraded.execute(
            """
            SELECT reason, review_version_id, job_version_id, profile_version_id,
                   evidence_version_id
            FROM case_decision_events WHERE id = 'legacy-decision:legacy-case'
            """
        ).fetchone()
        assert tuple(decision) == ("legacy_unpinned", None, None, None, None)

        run = upgraded.execute(
            """
            SELECT agent_run_id, gate_decision_event_id, job_version_id,
                   profile_version_id
            FROM resume_runs WHERE id = 'legacy-run'
            """
        ).fetchone()
        assert tuple(run) == (None, None, None, None)
        assert (
            upgraded.execute(
                "SELECT count(*) FROM resume_review_events WHERE resume_run_id = 'legacy-run'"
            ).fetchone()[0]
            == 0
        )

        application = upgraded.execute(
            """
            SELECT current_stage, legacy, approved_resume_review_event_id,
                   resume_run_id, pdf_artifact_id, pdf_checksum,
                   gate_decision_event_id
            FROM tracked_applications WHERE id = 'legacy-application:legacy-submission'
            """
        ).fetchone()
        assert tuple(application) == ("rejected", 1, None, None, None, None, None)
        stages = upgraded.execute(
            """
            SELECT stage, occurred_at, recorded_at
            FROM application_stage_events
            WHERE application_id = 'legacy-application:legacy-submission'
            ORDER BY occurred_at, rowid
            """
        ).fetchall()
        assert [tuple(stage) for stage in stages] == [
            (
                "submitted",
                "2026-08-03T12:00:00+00:00",
                "2026-08-03T12:00:00+00:00",
            ),
            (
                "rejected",
                "2026-08-04T12:00:00+00:00",
                "2026-08-04T12:00:00+00:00",
            ),
        ]
    finally:
        upgraded.close()

    with SQLiteUnitOfWorkFactory(SQLiteDatabase(database_path))() as uow:
        migrated_run = uow.resume_runs.get("legacy-run")
        assert migrated_run is not None
        assert (
            resume_approval_status(migrated_run, None, is_current=False)
            is ResumeApprovalStatus.NEEDS_REVIEW
        )


def test_upgrade_backfills_every_legacy_outcome_with_original_order_and_time(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "roleloop.sqlite3"
    _version_two_database(database_path)
    _seed_version_two_outcome_history(database_path)

    upgraded = SQLiteDatabase(database_path).connect()
    try:
        application = upgraded.execute(
            """
            SELECT current_stage, updated_at
            FROM tracked_applications
            WHERE id = 'legacy-application:outcome-submission'
            """
        ).fetchone()
        assert tuple(application) == (
            "no_response",
            "2026-07-06T12:00:00+00:00",
        )
        rows = upgraded.execute(
            """
            SELECT id, stage, occurred_at, recorded_at
            FROM application_stage_events
            WHERE application_id = 'legacy-application:outcome-submission'
            ORDER BY occurred_at, rowid
            """
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            (
                "legacy-stage:legacy-application:outcome-submission",
                "submitted",
                "2026-07-02T12:00:00+00:00",
                "2026-07-02T12:00:00+00:00",
            ),
            (
                "legacy-outcome-stage:outcome-interviewing",
                "technical_interview",
                "2026-07-03T12:00:00+00:00",
                "2026-07-03T12:00:00+00:00",
            ),
            (
                "legacy-outcome-stage:outcome-offer",
                "offer",
                "2026-07-04T12:00:00+00:00",
                "2026-07-04T12:00:00+00:00",
            ),
            (
                "legacy-outcome-stage:outcome-rejected",
                "rejected",
                "2026-07-04T12:00:00+00:00",
                "2026-07-04T12:00:00+00:00",
            ),
            (
                "legacy-outcome-stage:outcome-withdrawn",
                "withdrawn",
                "2026-07-05T12:00:00+00:00",
                "2026-07-05T12:00:00+00:00",
            ),
            (
                "legacy-outcome-stage:outcome-no-response",
                "no_response",
                "2026-07-06T12:00:00+00:00",
                "2026-07-06T12:00:00+00:00",
            ),
        ]
        receipt_ids = {
            row[0]
            for row in upgraded.execute(
                """
                SELECT result_id FROM command_receipts
                WHERE command_type = 'legacy.application_stage'
                  AND result_id LIKE 'legacy-outcome-stage:%'
                """
            )
        }
        assert receipt_ids == {
            "legacy-outcome-stage:outcome-interviewing",
            "legacy-outcome-stage:outcome-offer",
            "legacy-outcome-stage:outcome-rejected",
            "legacy-outcome-stage:outcome-withdrawn",
            "legacy-outcome-stage:outcome-no-response",
        }
    finally:
        upgraded.close()


def test_fresh_database_does_not_create_a_pointless_backup(tmp_path: Path) -> None:
    database_path = tmp_path / "roleloop.sqlite3"

    connection = SQLiteDatabase(database_path).connect()
    connection.close()

    assert list(tmp_path.glob("roleloop.sqlite3.backup-*")) == []
