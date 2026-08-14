"""SQLite repositories for the versioned, append-only RoleLoop workflow."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from datetime import datetime

from roleloop.domain import (
    ActorKind,
    AgentConfiguration,
    AgentKind,
    AgentProvider,
    AgentRun,
    AgentRunStatus,
    Answer,
    ApplicationFollowUp,
    ApplicationStage,
    ApplicationStageEvent,
    ArtifactRef,
    CaseDecisionEvent,
    CommandReceipt,
    Decision,
    DecisionReason,
    FollowUpResolution,
    FollowUpResolutionKind,
    HardBlockerKind,
    HardBlockerRule,
    JobSourceKind,
    JobVersion,
    LegacyImportBatch,
    LegacyImportItem,
    LegacyImportSource,
    RemotePreference,
    ResumeReviewDecision,
    ResumeReviewEvent,
    RuleOperator,
    ScoutCandidate,
    ScoutMode,
    ScoutRun,
    ScreenEvaluation,
    ScreenResult,
    SearchProfileVersion,
    TrackedApplication,
    VerificationAnswerEvent,
    WebSourceSnapshot,
)


class SQLiteArtifactsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, artifact: ArtifactRef) -> None:
        self._connection.execute(
            """
            INSERT INTO artifacts (
                id, checksum, uri, media_type, size_bytes, created_at, legacy
            ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                artifact.id,
                artifact.checksum,
                artifact.uri,
                artifact.media_type,
                artifact.size_bytes,
            ),
        )
        stored = self._connection.execute(
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

    def get(self, artifact_id: str) -> ArtifactRef | None:
        row = self._connection.execute(
            "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
        ).fetchone()
        return None if row is None else _artifact(row)


class SQLiteCommandReceiptsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, receipt: CommandReceipt) -> None:
        self._connection.execute(
            """
            INSERT INTO command_receipts (
                command_id, command_type, result_type, result_id, created_at,
                request_fingerprint
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                receipt.command_id,
                receipt.command_type,
                receipt.result_type,
                receipt.result_id,
                _dt(receipt.created_at),
                receipt.request_fingerprint,
            ),
        )

    def get(self, command_id: str) -> CommandReceipt | None:
        row = self._connection.execute(
            "SELECT * FROM command_receipts WHERE command_id = ?", (command_id,)
        ).fetchone()
        if row is None:
            return None
        return CommandReceipt(
            command_id=row["command_id"],
            command_type=row["command_type"],
            result_type=row["result_type"],
            result_id=row["result_id"],
            created_at=_required_dt(row["created_at"]),
            request_fingerprint=row["request_fingerprint"],
        )


class SQLiteProfileVersionsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(
        self,
        version: SearchProfileVersion,
        rules: Sequence[HardBlockerRule] = (),
    ) -> None:
        self._connection.execute(
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                version.id,
                version.profile_id,
                version.version_number,
                version.name,
                _json(version.target_roles),
                _json(version.locations),
                version.remote_preference.value,
                _json(version.employment_types),
                _json(version.seniority),
                version.annual_salary_floor,
                version.salary_currency,
                _json(version.include_keywords),
                _json(version.exclude_keywords),
                version.constraints,
                version.agent_provider.value,
                version.residence_country,
                version.timezone,
                _json(version.target_hq_countries),
                int(version.startup_required),
                _json(version.accepted_remote_arrangements),
                _json(version.accepted_hiring_arrangements),
                _json(version.search_queries),
                version.paper_size,
                version.page_limit,
                version.legacy_input_status,
                _dt(version.created_at),
            ),
        )
        self._connection.executemany(
            """
            INSERT INTO profile_agent_configurations (
                profile_version_id, agent_kind, provider, model, reasoning_effort
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                (
                    version.id,
                    item.kind.value,
                    item.provider.value,
                    item.model,
                    item.reasoning_effort,
                )
                for item in version.agent_configurations
            ),
        )
        self._connection.executemany(
            """
            INSERT INTO hard_blocker_rules (
                id, profile_version_id, rule_key, kind, operator,
                text_value, integer_value, boolean_value, position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    rule.id,
                    version.id,
                    rule.rule_key,
                    rule.kind.value,
                    rule.operator.value,
                    rule.text_value,
                    rule.integer_value,
                    None if rule.boolean_value is None else int(rule.boolean_value),
                    rule.position,
                )
                for rule in rules
            ),
        )
        self._connection.execute(
            "UPDATE profiles SET current_version_id = ? WHERE id = ?",
            (version.id, version.profile_id),
        )

    def get(self, version_id: str) -> SearchProfileVersion | None:
        row = self._connection.execute(
            "SELECT * FROM search_profile_versions WHERE id = ?", (version_id,)
        ).fetchone()
        return None if row is None else self._from_row(row)

    def get_current(self, profile_id: str) -> SearchProfileVersion | None:
        row = self._connection.execute(
            """
            SELECT v.* FROM profiles p
            JOIN search_profile_versions v ON v.id = p.current_version_id
            WHERE p.id = ?
            """,
            (profile_id,),
        ).fetchone()
        return None if row is None else self._from_row(row)

    def list_for_profile(self, profile_id: str) -> Sequence[SearchProfileVersion]:
        rows = self._connection.execute(
            """
            SELECT * FROM search_profile_versions
            WHERE profile_id = ? ORDER BY version_number, id
            """,
            (profile_id,),
        ).fetchall()
        return tuple(self._from_row(row) for row in rows)

    def list_rules(self, version_id: str) -> Sequence[HardBlockerRule]:
        rows = self._connection.execute(
            """
            SELECT * FROM hard_blocker_rules
            WHERE profile_version_id = ? ORDER BY position, id
            """,
            (version_id,),
        ).fetchall()
        return tuple(
            HardBlockerRule(
                id=row["id"],
                profile_version_id=row["profile_version_id"],
                rule_key=row["rule_key"],
                kind=HardBlockerKind(row["kind"]),
                operator=RuleOperator(row["operator"]),
                text_value=row["text_value"],
                integer_value=row["integer_value"],
                boolean_value=(
                    None if row["boolean_value"] is None else bool(row["boolean_value"])
                ),
                position=row["position"],
            )
            for row in rows
        )

    def _from_row(self, row: sqlite3.Row) -> SearchProfileVersion:
        config_rows = self._connection.execute(
            """
            SELECT * FROM profile_agent_configurations
            WHERE profile_version_id = ? ORDER BY agent_kind
            """,
            (row["id"],),
        ).fetchall()
        return SearchProfileVersion(
            id=row["id"],
            profile_id=row["profile_id"],
            version_number=row["version_number"],
            name=row["name"],
            target_roles=_strings(row["target_roles_json"]),
            locations=_strings(row["locations_json"]),
            remote_preference=RemotePreference(row["remote_preference"]),
            employment_types=_strings(row["employment_types_json"]),
            seniority=_strings(row["seniority_json"]),
            annual_salary_floor=row["annual_salary_floor"],
            salary_currency=row["salary_currency"],
            include_keywords=_strings(row["include_keywords_json"]),
            exclude_keywords=_strings(row["exclude_keywords_json"]),
            constraints=row["constraints_text"],
            agent_provider=AgentProvider(row["agent_provider"]),
            residence_country=row["residence_country"],
            timezone=row["timezone"],
            target_hq_countries=_strings(row["target_hq_countries_json"]),
            startup_required=bool(row["startup_required"]),
            accepted_remote_arrangements=_strings(row["accepted_remote_arrangements_json"]),
            accepted_hiring_arrangements=_strings(row["accepted_hiring_arrangements_json"]),
            search_queries=_strings(row["search_queries_json"]),
            paper_size=row["paper_size"],
            page_limit=row["page_limit"],
            agent_configurations=tuple(
                AgentConfiguration(
                    kind=AgentKind(item["agent_kind"]),
                    provider=AgentProvider(item["provider"]),
                    model=item["model"],
                    reasoning_effort=item["reasoning_effort"],
                )
                for item in config_rows
            ),
            legacy_input_status=row["legacy_input_status"],
            created_at=_optional_dt(row["created_at"]),
        )


class SQLiteJobVersionsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(
        self,
        version: JobVersion,
        sources: Sequence[WebSourceSnapshot] = (),
    ) -> None:
        self._connection.execute(
            """
            INSERT INTO job_versions (
                id, job_id, version_number, content_fingerprint, canonical_url,
                title, company, location, description, source, employment_type,
                seniority, salary_min, salary_max, salary_currency,
                external_requisition_id, listing_closed, hq_country, startup,
                work_authorization_required, us_only, remote_from_ecuador,
                remote_arrangement, hiring_arrangement, legacy_input_status, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                version.id,
                version.job_id,
                version.version_number,
                version.content_fingerprint,
                version.canonical_url,
                version.title,
                version.company,
                version.location,
                version.description,
                version.source,
                version.employment_type,
                version.seniority,
                version.salary_min,
                version.salary_max,
                version.salary_currency,
                version.external_requisition_id,
                _optional_bool(version.listing_closed),
                version.hq_country,
                _optional_bool(version.startup),
                _optional_bool(version.work_authorization_required),
                _optional_bool(version.us_only),
                _optional_bool(version.remote_from_ecuador),
                version.remote_arrangement,
                version.hiring_arrangement,
                version.legacy_input_status,
                _dt(version.observed_at),
            ),
        )
        for position, source in enumerate(sources):
            self._connection.execute(
                """
                INSERT INTO web_source_snapshots (
                    id, canonical_url, source_kind, title, publisher, retrieved_at,
                    content_checksum, quoted_evidence, content_artifact_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (canonical_url, content_checksum) DO NOTHING
                """,
                (
                    source.id,
                    source.canonical_url,
                    source.source_kind.value,
                    source.title,
                    source.publisher,
                    _dt(source.retrieved_at),
                    source.content_checksum,
                    source.quoted_evidence,
                    source.content_artifact_id,
                ),
            )
            resolved = self._connection.execute(
                """
                SELECT id FROM web_source_snapshots
                WHERE canonical_url = ? AND content_checksum = ?
                """,
                (source.canonical_url, source.content_checksum),
            ).fetchone()
            assert resolved is not None
            self._connection.execute(
                """
                INSERT INTO job_version_sources (
                    job_version_id, source_snapshot_id, position
                ) VALUES (?, ?, ?)
                """,
                (version.id, resolved["id"], position),
            )
        self._connection.execute(
            "UPDATE jobs SET current_version_id = ? WHERE id = ?",
            (version.id, version.job_id),
        )

    def get(self, version_id: str) -> JobVersion | None:
        row = self._connection.execute(
            "SELECT * FROM job_versions WHERE id = ?", (version_id,)
        ).fetchone()
        return None if row is None else _job_version(row)

    def get_current(self, job_id: str) -> JobVersion | None:
        row = self._connection.execute(
            """
            SELECT v.* FROM jobs j JOIN job_versions v ON v.id = j.current_version_id
            WHERE j.id = ?
            """,
            (job_id,),
        ).fetchone()
        return None if row is None else _job_version(row)

    def get_by_fingerprint(self, job_id: str, fingerprint: str) -> JobVersion | None:
        row = self._connection.execute(
            """
            SELECT * FROM job_versions WHERE job_id = ? AND content_fingerprint = ?
            """,
            (job_id, fingerprint),
        ).fetchone()
        return None if row is None else _job_version(row)

    def list_for_job(self, job_id: str) -> Sequence[JobVersion]:
        rows = self._connection.execute(
            """
            SELECT * FROM job_versions WHERE job_id = ? ORDER BY version_number, id
            """,
            (job_id,),
        ).fetchall()
        return tuple(_job_version(row) for row in rows)

    def list_sources(self, version_id: str) -> Sequence[WebSourceSnapshot]:
        rows = self._connection.execute(
            """
            SELECT s.* FROM job_version_sources j
            JOIN web_source_snapshots s ON s.id = j.source_snapshot_id
            WHERE j.job_version_id = ? ORDER BY j.position
            """,
            (version_id,),
        ).fetchall()
        return tuple(_web_source(row) for row in rows)


class SQLiteAgentRunsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, run: AgentRun) -> None:
        self._connection.execute(
            """
            INSERT INTO agent_runs (
                id, command_id, kind, provider, model, prompt_version,
                output_schema_version, profile_id, job_case_id, input_fingerprint,
                prompt_hash, output_schema_hash, provider_response_id, response_model,
                input_tokens, output_tokens, total_tokens, status_detail, status,
                request_artifact_id, response_artifact_id, error_code,
                error_message, started_at, finished_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?)
            """,
            _agent_values(run),
        )
        self._replace_source_urls(run)

    def get(self, run_id: str) -> AgentRun | None:
        row = self._connection.execute(
            "SELECT * FROM agent_runs WHERE id = ?", (run_id,)
        ).fetchone()
        return None if row is None else _agent_run(self._connection, row)

    def get_by_command_id(self, command_id: str) -> AgentRun | None:
        row = self._connection.execute(
            "SELECT * FROM agent_runs WHERE command_id = ?", (command_id,)
        ).fetchone()
        return None if row is None else _agent_run(self._connection, row)

    def update(self, run: AgentRun) -> None:
        cursor = self._connection.execute(
            """
            UPDATE agent_runs SET
                command_id = ?, kind = ?, provider = ?, model = ?, prompt_version = ?,
                output_schema_version = ?, profile_id = ?, job_case_id = ?,
                input_fingerprint = ?, prompt_hash = ?, output_schema_hash = ?,
                provider_response_id = ?, response_model = ?, input_tokens = ?,
                output_tokens = ?, total_tokens = ?, status_detail = ?, status = ?,
                request_artifact_id = ?, response_artifact_id = ?, error_code = ?,
                error_message = ?, started_at = ?, finished_at = ?, created_at = ?
            WHERE id = ?
            """,
            (*_agent_values(run)[1:], run.id),
        )
        if cursor.rowcount != 1:
            raise KeyError(run.id)
        self._replace_source_urls(run)

    def list_for_case(self, case_id: str) -> Sequence[AgentRun]:
        rows = self._connection.execute(
            """
            SELECT * FROM agent_runs WHERE job_case_id = ? ORDER BY created_at, id
            """,
            (case_id,),
        ).fetchall()
        return tuple(_agent_run(self._connection, row) for row in rows)

    def list_in_progress(self) -> Sequence[AgentRun]:
        rows = self._connection.execute(
            """
            SELECT * FROM agent_runs
            WHERE status IN ('queued', 'running') ORDER BY created_at, id
            """
        ).fetchall()
        return tuple(_agent_run(self._connection, row) for row in rows)

    def add_scout_run(
        self,
        run: ScoutRun,
        candidates: Sequence[ScoutCandidate],
    ) -> None:
        self._connection.execute(
            """
            INSERT INTO scout_runs (
                id, agent_run_id, profile_version_id, mode, requested_url,
                result_limit, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run.id,
                run.agent_run_id,
                run.profile_version_id,
                run.mode.value,
                run.requested_url,
                run.result_limit,
                _dt(run.created_at),
            ),
        )
        self._connection.executemany(
            """
            INSERT INTO scout_candidates (
                scout_run_id, position, job_id, job_version_id, dedupe_key
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                (
                    item.scout_run_id,
                    item.position,
                    item.job_id,
                    item.job_version_id,
                    item.dedupe_key,
                )
                for item in candidates
            ),
        )

    def get_scout_run(self, scout_run_id: str) -> ScoutRun | None:
        row = self._connection.execute(
            "SELECT * FROM scout_runs WHERE id = ?", (scout_run_id,)
        ).fetchone()
        if row is None:
            return None
        return ScoutRun(
            id=row["id"],
            agent_run_id=row["agent_run_id"],
            profile_version_id=row["profile_version_id"],
            mode=ScoutMode(row["mode"]),
            requested_url=row["requested_url"],
            result_limit=row["result_limit"],
            created_at=_optional_dt(row["created_at"]),
        )

    def list_scout_candidates(self, scout_run_id: str) -> Sequence[ScoutCandidate]:
        rows = self._connection.execute(
            """
            SELECT * FROM scout_candidates
            WHERE scout_run_id = ? ORDER BY position
            """,
            (scout_run_id,),
        ).fetchall()
        return tuple(
            ScoutCandidate(
                scout_run_id=row["scout_run_id"],
                position=row["position"],
                job_id=row["job_id"],
                job_version_id=row["job_version_id"],
                dedupe_key=row["dedupe_key"],
            )
            for row in rows
        )

    def _replace_source_urls(self, run: AgentRun) -> None:
        self._connection.execute(
            "DELETE FROM agent_run_source_urls WHERE agent_run_id = ?", (run.id,)
        )
        self._connection.executemany(
            """
            INSERT INTO agent_run_source_urls (agent_run_id, position, canonical_url)
            VALUES (?, ?, ?)
            """,
            ((run.id, position, url) for position, url in enumerate(run.source_urls)),
        )


class SQLiteScreenEvaluationsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add_all(self, evaluations: Sequence[ScreenEvaluation]) -> None:
        self._connection.executemany(
            """
            INSERT INTO screen_evaluations (
                id, job_case_id, job_version_id, profile_version_id, rule_id,
                result, detail, source_snapshot_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    item.id,
                    item.job_case_id,
                    item.job_version_id,
                    item.profile_version_id,
                    item.rule_id,
                    item.result.value,
                    item.detail,
                    item.source_snapshot_id,
                    _dt(item.created_at),
                )
                for item in evaluations
            ),
        )

    def list_current(
        self,
        case_id: str,
        job_version_id: str,
        profile_version_id: str,
    ) -> Sequence[ScreenEvaluation]:
        rows = self._connection.execute(
            """
            SELECT * FROM screen_evaluations
            WHERE job_case_id = ? AND job_version_id = ? AND profile_version_id = ?
            ORDER BY rule_id, id
            """,
            (case_id, job_version_id, profile_version_id),
        ).fetchall()
        return tuple(_screen(row) for row in rows)


class SQLiteAnswerEventsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, event: VerificationAnswerEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO verification_answer_events (
                id, command_id, job_case_id, question_key,
                asked_by_review_version_id, answer, actor,
                supersedes_answer_event_id, legacy, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.command_id,
                event.job_case_id,
                event.question_key,
                event.asked_by_review_version_id,
                event.answer.value,
                event.actor.value,
                event.supersedes_answer_event_id,
                int(event.legacy),
                _dt(event.recorded_at),
            ),
        )

    def get(self, event_id: str) -> VerificationAnswerEvent | None:
        row = self._connection.execute(
            "SELECT * FROM verification_answer_events WHERE id = ?", (event_id,)
        ).fetchone()
        return None if row is None else _answer_event(row)

    def list_for_case(self, case_id: str) -> Sequence[VerificationAnswerEvent]:
        rows = self._connection.execute(
            """
            SELECT * FROM verification_answer_events
            WHERE job_case_id = ? ORDER BY recorded_at, rowid
            """,
            (case_id,),
        ).fetchall()
        return tuple(_answer_event(row) for row in rows)


class SQLiteDecisionEventsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, event: CaseDecisionEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO case_decision_events (
                id, command_id, job_case_id, decision, reason, actor,
                review_version_id, job_version_id, profile_version_id,
                evidence_version_id, answer_set_fingerprint,
                screen_evaluation_id, supersedes_decision_event_id, rationale,
                decided_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.command_id,
                event.job_case_id,
                event.decision.value,
                event.reason.value,
                event.actor.value,
                event.review_version_id,
                event.job_version_id,
                event.profile_version_id,
                event.evidence_version_id,
                event.answer_set_fingerprint,
                event.screen_evaluation_id,
                event.supersedes_decision_event_id,
                event.rationale,
                _dt(event.decided_at),
            ),
        )

    def get(self, event_id: str) -> CaseDecisionEvent | None:
        row = self._connection.execute(
            "SELECT * FROM case_decision_events WHERE id = ?", (event_id,)
        ).fetchone()
        return None if row is None else _decision_event(row)

    def list_for_case(self, case_id: str) -> Sequence[CaseDecisionEvent]:
        rows = self._connection.execute(
            """
            SELECT * FROM case_decision_events
            WHERE job_case_id = ? ORDER BY decided_at, rowid
            """,
            (case_id,),
        ).fetchall()
        return tuple(_decision_event(row) for row in rows)


class SQLiteResumeReviewsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, event: ResumeReviewEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO resume_review_events (
                id, command_id, resume_run_id, decision, actor, feedback,
                pdf_artifact_id, pdf_checksum, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.command_id,
                event.resume_run_id,
                event.decision.value,
                event.actor.value,
                event.feedback,
                event.pdf_artifact_id,
                event.pdf_checksum,
                _dt(event.created_at),
            ),
        )

    def get(self, event_id: str) -> ResumeReviewEvent | None:
        row = self._connection.execute(
            "SELECT * FROM resume_review_events WHERE id = ?", (event_id,)
        ).fetchone()
        return None if row is None else _resume_review(row)

    def get_latest(self, resume_run_id: str) -> ResumeReviewEvent | None:
        row = self._connection.execute(
            """
            SELECT * FROM resume_review_events WHERE resume_run_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (resume_run_id,),
        ).fetchone()
        return None if row is None else _resume_review(row)

    def list_for_run(self, resume_run_id: str) -> Sequence[ResumeReviewEvent]:
        rows = self._connection.execute(
            """
            SELECT * FROM resume_review_events WHERE resume_run_id = ?
            ORDER BY created_at, rowid
            """,
            (resume_run_id,),
        ).fetchall()
        return tuple(_resume_review(row) for row in rows)


class SQLiteTrackedApplicationsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, application: TrackedApplication) -> None:
        self._connection.execute(
            """
            INSERT INTO tracked_applications (
                id, command_id, job_id, job_case_id, current_stage,
                approved_resume_review_event_id, resume_run_id, pdf_artifact_id,
                pdf_checksum, job_version_id, profile_version_id,
                evidence_version_id, review_version_id, gate_decision_event_id,
                submitted_at, legacy, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _application_values(application),
        )

    def get(self, application_id: str) -> TrackedApplication | None:
        row = self._connection.execute(
            "SELECT * FROM tracked_applications WHERE id = ?", (application_id,)
        ).fetchone()
        return None if row is None else _application(row)

    def get_for_job(self, job_id: str) -> TrackedApplication | None:
        row = self._connection.execute(
            "SELECT * FROM tracked_applications WHERE job_id = ?", (job_id,)
        ).fetchone()
        return None if row is None else _application(row)

    def get_for_case(self, case_id: str) -> TrackedApplication | None:
        row = self._connection.execute(
            """
            SELECT a.* FROM tracked_applications a
            LEFT JOIN legacy_application_aliases l ON l.application_id = a.id
            WHERE a.job_case_id = ? OR l.legacy_job_case_id = ? LIMIT 1
            """,
            (case_id, case_id),
        ).fetchone()
        return None if row is None else _application(row)

    def update(self, application: TrackedApplication, *, expected_revision: int) -> bool:
        cursor = self._connection.execute(
            """
            UPDATE tracked_applications SET
                current_stage = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ?
            """,
            (
                application.current_stage.value,
                application.revision,
                _dt(application.updated_at),
                application.id,
                expected_revision,
            ),
        )
        return cursor.rowcount == 1

    def add_stage(self, event: ApplicationStageEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO application_stage_events (
                id, command_id, application_id, stage, actor, occurred_at,
                recorded_at, note
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.command_id,
                event.application_id,
                event.stage.value,
                event.actor.value,
                _dt(event.occurred_at),
                _dt(event.recorded_at),
                event.note,
            ),
        )

    def list_stages(self, application_id: str) -> Sequence[ApplicationStageEvent]:
        rows = self._connection.execute(
            """
            SELECT * FROM application_stage_events
            WHERE application_id = ? ORDER BY occurred_at, rowid
            """,
            (application_id,),
        ).fetchall()
        return tuple(_stage(row) for row in rows)


class SQLiteFollowUpsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, follow_up: ApplicationFollowUp) -> None:
        self._connection.execute(
            """
            INSERT INTO application_follow_ups (
                id, command_id, application_id, due_at, note,
                trigger_stage_event_id, supersedes_follow_up_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                follow_up.id,
                follow_up.command_id,
                follow_up.application_id,
                _dt(follow_up.due_at),
                follow_up.note,
                follow_up.trigger_stage_event_id,
                follow_up.supersedes_follow_up_id,
                _dt(follow_up.created_at),
            ),
        )

    def get(self, follow_up_id: str) -> ApplicationFollowUp | None:
        row = self._connection.execute(
            "SELECT * FROM application_follow_ups WHERE id = ?", (follow_up_id,)
        ).fetchone()
        return None if row is None else _follow_up(row)

    def get_open_for_application(self, application_id: str) -> ApplicationFollowUp | None:
        row = self._connection.execute(
            """
            SELECT f.* FROM application_follow_ups f
            LEFT JOIN follow_up_resolutions r ON r.follow_up_id = f.id
            WHERE f.application_id = ? AND r.id IS NULL
            ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1
            """,
            (application_id,),
        ).fetchone()
        return None if row is None else _follow_up(row)

    def list_for_application(self, application_id: str) -> Sequence[ApplicationFollowUp]:
        rows = self._connection.execute(
            """
            SELECT * FROM application_follow_ups
            WHERE application_id = ? ORDER BY created_at, rowid
            """,
            (application_id,),
        ).fetchall()
        return tuple(_follow_up(row) for row in rows)

    def list_due(
        self,
        *,
        at: datetime,
        profile_id: str | None = None,
    ) -> Sequence[ApplicationFollowUp]:
        clauses = ["f.due_at <= ?", "r.id IS NULL"]
        values: list[object] = [_dt(at)]
        if profile_id is not None:
            clauses.append("c.profile_id = ?")
            values.append(profile_id)
        rows = self._connection.execute(
            f"""
            SELECT f.* FROM application_follow_ups f
            JOIN tracked_applications a ON a.id = f.application_id
            JOIN job_cases c ON c.id = a.job_case_id
            LEFT JOIN follow_up_resolutions r ON r.follow_up_id = f.id
            WHERE {" AND ".join(clauses)}
            ORDER BY f.due_at, f.id
            """,
            values,
        ).fetchall()
        return tuple(_follow_up(row) for row in rows)

    def add_resolution(self, resolution: FollowUpResolution) -> None:
        self._connection.execute(
            """
            INSERT INTO follow_up_resolutions (
                id, command_id, follow_up_id, disposition,
                replacement_follow_up_id, note, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resolution.id,
                resolution.command_id,
                resolution.follow_up_id,
                resolution.disposition.value,
                resolution.replacement_follow_up_id,
                resolution.note,
                _dt(resolution.resolved_at),
            ),
        )

    def list_resolutions(self, follow_up_id: str) -> Sequence[FollowUpResolution]:
        rows = self._connection.execute(
            """
            SELECT * FROM follow_up_resolutions
            WHERE follow_up_id = ? ORDER BY resolved_at, rowid
            """,
            (follow_up_id,),
        ).fetchall()
        return tuple(_resolution(row) for row in rows)


class SQLiteLegacyImportsRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def add(self, batch: LegacyImportBatch) -> None:
        self._connection.execute(
            """
            INSERT INTO legacy_import_batches (
                id, command_id, profile_id, source_checksum, imported_jobs,
                imported_events, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                batch.id,
                batch.command_id,
                batch.profile_id,
                batch.source_checksum,
                batch.imported_jobs,
                batch.imported_events,
                _dt(batch.created_at),
            ),
        )
        self._connection.executemany(
            """
            INSERT INTO legacy_import_sources (
                batch_id, position, database_name, source_checksum, size_bytes,
                job_count, event_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    source.batch_id,
                    source.position,
                    source.database_name,
                    source.source_checksum,
                    source.size_bytes,
                    source.job_count,
                    source.event_count,
                )
                for source in batch.sources
            ),
        )

    def add_item(self, item: LegacyImportItem) -> None:
        self._connection.execute(
            """
            INSERT INTO legacy_import_items (
                batch_id, legacy_key, entity_type, entity_id
            ) VALUES (?, ?, ?, ?)
            """,
            (item.batch_id, item.legacy_key, item.entity_type, item.entity_id),
        )

    def list_items(self, batch_id: str) -> Sequence[LegacyImportItem]:
        rows = self._connection.execute(
            """
            SELECT * FROM legacy_import_items
            WHERE batch_id = ? ORDER BY legacy_key, entity_type
            """,
            (batch_id,),
        ).fetchall()
        return tuple(
            LegacyImportItem(
                batch_id=row["batch_id"],
                legacy_key=row["legacy_key"],
                entity_type=row["entity_type"],
                entity_id=row["entity_id"],
            )
            for row in rows
        )

    def list_sources(self, batch_id: str) -> Sequence[LegacyImportSource]:
        rows = self._connection.execute(
            """
            SELECT * FROM legacy_import_sources
            WHERE batch_id = ? ORDER BY position
            """,
            (batch_id,),
        ).fetchall()
        return tuple(
            LegacyImportSource(
                batch_id=row["batch_id"],
                position=row["position"],
                database_name=row["database_name"],
                source_checksum=row["source_checksum"],
                size_bytes=row["size_bytes"],
                job_count=row["job_count"],
                event_count=row["event_count"],
            )
            for row in rows
        )

    def get_by_checksum(self, profile_id: str, source_checksum: str) -> LegacyImportBatch | None:
        row = self._connection.execute(
            """
            SELECT * FROM legacy_import_batches
            WHERE profile_id = ? AND source_checksum = ?
            """,
            (profile_id, source_checksum),
        ).fetchone()
        if row is None:
            return None
        return LegacyImportBatch(
            id=row["id"],
            command_id=row["command_id"],
            profile_id=row["profile_id"],
            source_checksum=row["source_checksum"],
            imported_jobs=row["imported_jobs"],
            imported_events=row["imported_events"],
            created_at=_required_dt(row["created_at"]),
            sources=tuple(self.list_sources(row["id"])),
        )


def _artifact(row: sqlite3.Row) -> ArtifactRef:
    return ArtifactRef(
        id=row["id"],
        checksum=row["checksum"],
        uri=row["uri"],
        media_type=row["media_type"],
        size_bytes=row["size_bytes"],
    )


def _job_version(row: sqlite3.Row) -> JobVersion:
    return JobVersion(
        id=row["id"],
        job_id=row["job_id"],
        version_number=row["version_number"],
        content_fingerprint=row["content_fingerprint"],
        canonical_url=row["canonical_url"],
        title=row["title"],
        company=row["company"],
        location=row["location"],
        description=row["description"],
        source=row["source"],
        employment_type=row["employment_type"],
        seniority=row["seniority"],
        salary_min=row["salary_min"],
        salary_max=row["salary_max"],
        salary_currency=row["salary_currency"],
        external_requisition_id=row["external_requisition_id"],
        listing_closed=_nullable_bool(row["listing_closed"]),
        hq_country=row["hq_country"],
        startup=_nullable_bool(row["startup"]),
        work_authorization_required=_nullable_bool(row["work_authorization_required"]),
        us_only=_nullable_bool(row["us_only"]),
        remote_from_ecuador=_nullable_bool(row["remote_from_ecuador"]),
        remote_arrangement=row["remote_arrangement"],
        hiring_arrangement=row["hiring_arrangement"],
        legacy_input_status=row["legacy_input_status"],
        observed_at=_optional_dt(row["observed_at"]),
    )


def _web_source(row: sqlite3.Row) -> WebSourceSnapshot:
    return WebSourceSnapshot(
        id=row["id"],
        canonical_url=row["canonical_url"],
        source_kind=JobSourceKind(row["source_kind"]),
        title=row["title"],
        publisher=row["publisher"],
        retrieved_at=_required_dt(row["retrieved_at"]),
        content_checksum=row["content_checksum"],
        quoted_evidence=row["quoted_evidence"],
        content_artifact_id=row["content_artifact_id"],
    )


def _agent_values(run: AgentRun) -> tuple[object, ...]:
    return (
        run.id,
        run.command_id,
        run.kind.value,
        run.provider.value,
        run.model,
        run.prompt_version,
        run.output_schema_version,
        run.profile_id,
        run.job_case_id,
        run.input_fingerprint,
        run.prompt_hash,
        run.output_schema_hash,
        run.provider_response_id,
        run.response_model,
        run.input_tokens,
        run.output_tokens,
        run.total_tokens,
        run.status_detail,
        run.status.value,
        run.request_artifact_id,
        run.response_artifact_id,
        run.error_code,
        run.error_message,
        _dt(run.started_at),
        _dt(run.finished_at),
        _dt(run.created_at),
    )


def _agent_run(connection: sqlite3.Connection, row: sqlite3.Row) -> AgentRun:
    source_rows = connection.execute(
        """
        SELECT canonical_url FROM agent_run_source_urls
        WHERE agent_run_id = ? ORDER BY position
        """,
        (row["id"],),
    ).fetchall()
    return AgentRun(
        id=row["id"],
        command_id=row["command_id"],
        kind=AgentKind(row["kind"]),
        provider=AgentProvider(row["provider"]),
        model=row["model"],
        prompt_version=row["prompt_version"],
        output_schema_version=row["output_schema_version"],
        profile_id=row["profile_id"],
        job_case_id=row["job_case_id"],
        input_fingerprint=row["input_fingerprint"],
        status=AgentRunStatus(row["status"]),
        prompt_hash=row["prompt_hash"],
        output_schema_hash=row["output_schema_hash"],
        provider_response_id=row["provider_response_id"],
        response_model=row["response_model"],
        input_tokens=row["input_tokens"],
        output_tokens=row["output_tokens"],
        total_tokens=row["total_tokens"],
        source_urls=tuple(item["canonical_url"] for item in source_rows),
        status_detail=row["status_detail"],
        request_artifact_id=row["request_artifact_id"],
        response_artifact_id=row["response_artifact_id"],
        error_code=row["error_code"],
        error_message=row["error_message"],
        started_at=_optional_dt(row["started_at"]),
        finished_at=_optional_dt(row["finished_at"]),
        created_at=_optional_dt(row["created_at"]),
    )


def _screen(row: sqlite3.Row) -> ScreenEvaluation:
    return ScreenEvaluation(
        id=row["id"],
        job_case_id=row["job_case_id"],
        job_version_id=row["job_version_id"],
        profile_version_id=row["profile_version_id"],
        rule_id=row["rule_id"],
        result=ScreenResult(row["result"]),
        detail=row["detail"],
        source_snapshot_id=row["source_snapshot_id"],
        created_at=_optional_dt(row["created_at"]),
    )


def _answer_event(row: sqlite3.Row) -> VerificationAnswerEvent:
    return VerificationAnswerEvent(
        id=row["id"],
        command_id=row["command_id"],
        job_case_id=row["job_case_id"],
        question_key=row["question_key"],
        asked_by_review_version_id=row["asked_by_review_version_id"],
        answer=Answer(row["answer"]),
        actor=ActorKind(row["actor"]),
        supersedes_answer_event_id=row["supersedes_answer_event_id"],
        legacy=bool(row["legacy"]),
        recorded_at=_optional_dt(row["recorded_at"]),
    )


def _decision_event(row: sqlite3.Row) -> CaseDecisionEvent:
    return CaseDecisionEvent(
        id=row["id"],
        command_id=row["command_id"],
        job_case_id=row["job_case_id"],
        decision=Decision(row["decision"]),
        reason=DecisionReason(row["reason"]),
        actor=ActorKind(row["actor"]),
        review_version_id=row["review_version_id"],
        job_version_id=row["job_version_id"],
        profile_version_id=row["profile_version_id"],
        evidence_version_id=row["evidence_version_id"],
        answer_set_fingerprint=row["answer_set_fingerprint"],
        screen_evaluation_id=row["screen_evaluation_id"],
        supersedes_decision_event_id=row["supersedes_decision_event_id"],
        rationale=row["rationale"],
        decided_at=_optional_dt(row["decided_at"]),
    )


def _resume_review(row: sqlite3.Row) -> ResumeReviewEvent:
    return ResumeReviewEvent(
        id=row["id"],
        command_id=row["command_id"],
        resume_run_id=row["resume_run_id"],
        decision=ResumeReviewDecision(row["decision"]),
        actor=ActorKind(row["actor"]),
        feedback=row["feedback"],
        pdf_artifact_id=row["pdf_artifact_id"],
        pdf_checksum=row["pdf_checksum"],
        created_at=_optional_dt(row["created_at"]),
    )


def _application_values(application: TrackedApplication) -> tuple[object, ...]:
    return (
        application.id,
        application.command_id,
        application.job_id,
        application.job_case_id,
        application.current_stage.value,
        application.approved_resume_review_event_id,
        application.resume_run_id,
        application.pdf_artifact_id,
        application.pdf_checksum,
        application.job_version_id,
        application.profile_version_id,
        application.evidence_version_id,
        application.review_version_id,
        application.gate_decision_event_id,
        _dt(application.submitted_at),
        int(application.legacy),
        application.revision,
        _dt(application.created_at),
        _dt(application.updated_at),
    )


def _application(row: sqlite3.Row) -> TrackedApplication:
    return TrackedApplication(
        id=row["id"],
        command_id=row["command_id"],
        job_id=row["job_id"],
        job_case_id=row["job_case_id"],
        current_stage=ApplicationStage(row["current_stage"]),
        approved_resume_review_event_id=row["approved_resume_review_event_id"],
        resume_run_id=row["resume_run_id"],
        pdf_artifact_id=row["pdf_artifact_id"],
        pdf_checksum=row["pdf_checksum"],
        job_version_id=row["job_version_id"],
        profile_version_id=row["profile_version_id"],
        evidence_version_id=row["evidence_version_id"],
        review_version_id=row["review_version_id"],
        gate_decision_event_id=row["gate_decision_event_id"],
        submitted_at=_required_dt(row["submitted_at"]),
        legacy=bool(row["legacy"]),
        revision=row["revision"],
        created_at=_optional_dt(row["created_at"]),
        updated_at=_optional_dt(row["updated_at"]),
    )


def _stage(row: sqlite3.Row) -> ApplicationStageEvent:
    return ApplicationStageEvent(
        id=row["id"],
        command_id=row["command_id"],
        application_id=row["application_id"],
        stage=ApplicationStage(row["stage"]),
        actor=ActorKind(row["actor"]),
        occurred_at=_required_dt(row["occurred_at"]),
        recorded_at=_required_dt(row["recorded_at"]),
        note=row["note"],
    )


def _follow_up(row: sqlite3.Row) -> ApplicationFollowUp:
    return ApplicationFollowUp(
        id=row["id"],
        command_id=row["command_id"],
        application_id=row["application_id"],
        due_at=_required_dt(row["due_at"]),
        note=row["note"],
        trigger_stage_event_id=row["trigger_stage_event_id"],
        supersedes_follow_up_id=row["supersedes_follow_up_id"],
        created_at=_optional_dt(row["created_at"]),
    )


def _resolution(row: sqlite3.Row) -> FollowUpResolution:
    return FollowUpResolution(
        id=row["id"],
        command_id=row["command_id"],
        follow_up_id=row["follow_up_id"],
        disposition=FollowUpResolutionKind(row["disposition"]),
        replacement_follow_up_id=row["replacement_follow_up_id"],
        note=row["note"],
        resolved_at=_optional_dt(row["resolved_at"]),
    )


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _strings(value: str) -> tuple[str, ...]:
    loaded = json.loads(value)
    return tuple(str(item) for item in loaded)


def _dt(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _optional_dt(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def _required_dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _optional_bool(value: bool | None) -> int | None:
    return None if value is None else int(value)


def _nullable_bool(value: int | None) -> bool | None:
    return None if value is None else bool(value)
