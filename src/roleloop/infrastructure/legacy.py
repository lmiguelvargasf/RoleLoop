"""Read-only access to the prototype master-resume job-agent databases.

The importer deliberately separates inspection from mutation.  This module can
only open the legacy SQLite files in immutable read-only mode and returns typed
snapshots for the application service to preview or import transactionally into
RoleLoop's own database.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from roleloop.application.dto import (
    JobDetails,
    LegacyEventDraft,
    LegacyImportDraft,
    LegacyJobDraft,
    LegacySourceManifest,
)
from roleloop.domain import ApplicationStage, Decision


class LegacyStateError(ValueError):
    """Raised when a prototype database is missing its expected safe shape."""


@dataclass(frozen=True, slots=True)
class LegacyDatabaseSummary:
    name: str
    path: Path
    checksum: str
    size_bytes: int
    job_count: int
    event_count: int


@dataclass(frozen=True, slots=True)
class LegacyJobSnapshot:
    source_database: str
    source_checksum: str
    legacy_job_id: str
    canonical_url: str
    company: str
    title: str
    status: str
    revision: int
    state: Mapping[str, Any]
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class LegacyEventSnapshot:
    source_database: str
    source_checksum: str
    legacy_event_id: int
    legacy_job_id: str
    occurred_at: str
    node: str
    event_type: str
    detail: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class LegacyStateBundle:
    databases: tuple[LegacyDatabaseSummary, ...]
    jobs: tuple[LegacyJobSnapshot, ...]
    events: tuple[LegacyEventSnapshot, ...]
    duplicate_urls: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _DatabaseSpec:
    filename: str
    jobs_table: str


_DATABASES = (
    _DatabaseSpec("state.sqlite3", "job_runs"),
    _DatabaseSpec("state-v2.sqlite3", "jobs"),
)
_MAX_DATABASE_BYTES = 100 * 1024 * 1024


class LegacyMasterStateReader:
    """Inspect the known prototype databases without changing either file."""

    def read(self, repository: Path) -> LegacyStateBundle:
        root = repository.expanduser().resolve()
        state_root = root / ".job-agent"
        summaries: list[LegacyDatabaseSummary] = []
        jobs: list[LegacyJobSnapshot] = []
        events: list[LegacyEventSnapshot] = []

        for spec in _DATABASES:
            path = state_root / spec.filename
            if not path.exists():
                continue
            if not path.is_file() or path.is_symlink():
                raise LegacyStateError(f"legacy state is not a regular file: {path}")
            size = path.stat().st_size
            if size > _MAX_DATABASE_BYTES:
                raise LegacyStateError(f"legacy state exceeds {_MAX_DATABASE_BYTES} bytes: {path}")
            checksum = _sha256(path)
            database_jobs, database_events = self._read_database(path, spec, checksum)
            jobs.extend(database_jobs)
            events.extend(database_events)
            summaries.append(
                LegacyDatabaseSummary(
                    name=spec.filename,
                    path=path,
                    checksum=checksum,
                    size_bytes=size,
                    job_count=len(database_jobs),
                    event_count=len(database_events),
                )
            )

        counts: dict[str, int] = {}
        for job in jobs:
            counts[job.canonical_url] = counts.get(job.canonical_url, 0) + 1
        duplicates = tuple(sorted(url for url, count in counts.items() if count > 1))
        return LegacyStateBundle(
            databases=tuple(summaries),
            jobs=tuple(jobs),
            events=tuple(events),
            duplicate_urls=duplicates,
        )

    def to_import_draft(self, repository: Path) -> LegacyImportDraft:
        """Translate an immutable read into the application import contract.

        Only job facts, conservative human decisions, application outcomes, and
        chronological events cross this boundary. Legacy résumé packages and
        approvals are intentionally ignored because they cannot satisfy v1's
        pinned evidence and exact-PDF approval rules.
        """

        bundle = self.read(repository)
        return LegacyImportDraft(
            source_checksum="",
            source_job_count=len(bundle.jobs),
            source_event_count=len(bundle.events),
            sources=tuple(
                LegacySourceManifest(
                    database_name=item.name,
                    source_checksum=item.checksum,
                    size_bytes=item.size_bytes,
                    job_count=item.job_count,
                    event_count=item.event_count,
                )
                for item in bundle.databases
            ),
            jobs=tuple(_job_draft(item) for item in bundle.jobs),
            events=tuple(_event_draft(item) for item in bundle.events),
            duplicate_urls=bundle.duplicate_urls,
        )

    def _read_database(
        self,
        path: Path,
        spec: _DatabaseSpec,
        checksum: str,
    ) -> tuple[list[LegacyJobSnapshot], list[LegacyEventSnapshot]]:
        encoded = quote(str(path), safe="/")
        connection = sqlite3.connect(
            f"file:{encoded}?mode=ro&immutable=1",
            uri=True,
        )
        connection.row_factory = sqlite3.Row
        try:
            _require_columns(
                connection,
                spec.jobs_table,
                {
                    "job_id",
                    "canonical_url",
                    "company",
                    "title",
                    "revision",
                    "state_json",
                    "created_at",
                    "updated_at",
                    "stage" if spec.jobs_table == "job_runs" else "status",
                },
            )
            _require_columns(
                connection,
                "events",
                {"id", "job_id", "occurred_at", "node", "event_type", "detail_json"},
            )
            state_column = "stage" if spec.jobs_table == "job_runs" else "status"
            job_rows = connection.execute(
                f"""SELECT job_id, canonical_url, company, title, {state_column} AS status,
                           revision, state_json, created_at, updated_at
                    FROM {spec.jobs_table}
                    ORDER BY job_id"""
            ).fetchall()
            event_rows = connection.execute(
                """SELECT id, job_id, occurred_at, node, event_type, detail_json
                   FROM events ORDER BY id"""
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise LegacyStateError(f"could not read legacy state {path}: {error}") from error
        finally:
            connection.close()

        jobs = [
            LegacyJobSnapshot(
                source_database=spec.filename,
                source_checksum=checksum,
                legacy_job_id=str(row["job_id"]),
                canonical_url=str(row["canonical_url"]),
                company=str(row["company"]),
                title=str(row["title"]),
                status=str(row["status"]),
                revision=int(row["revision"]),
                state=_json_object(row["state_json"], path=path, field="state_json"),
                created_at=str(row["created_at"]),
                updated_at=str(row["updated_at"]),
            )
            for row in job_rows
        ]
        events = [
            LegacyEventSnapshot(
                source_database=spec.filename,
                source_checksum=checksum,
                legacy_event_id=int(row["id"]),
                legacy_job_id=str(row["job_id"]),
                occurred_at=str(row["occurred_at"]),
                node=str(row["node"]),
                event_type=str(row["event_type"]),
                detail=_json_object(row["detail_json"], path=path, field="detail_json"),
            )
            for row in event_rows
        ]
        return jobs, events


def _require_columns(
    connection: sqlite3.Connection,
    table: str,
    required: set[str],
) -> None:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    columns = {str(row[1]) for row in rows}
    missing = sorted(required - columns)
    if missing:
        raise LegacyStateError(f"legacy table {table} is missing columns: {missing}")


def _json_object(value: object, *, path: Path, field: str) -> Mapping[str, Any]:
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError) as error:
        raise LegacyStateError(f"invalid {field} JSON in {path}") from error
    if not isinstance(parsed, dict):
        raise LegacyStateError(f"{field} in {path} must contain a JSON object")
    return parsed


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _job_draft(snapshot: LegacyJobSnapshot) -> LegacyJobDraft:
    job = snapshot.state.get("job")
    facts = job if isinstance(job, Mapping) else {}
    remote_scope = _optional_text(facts.get("remote_scope"))
    is_open = facts.get("is_open")
    listing_closed = None if not isinstance(is_open, bool) else not is_open
    return LegacyJobDraft(
        legacy_key=f"{snapshot.source_database}:{snapshot.legacy_job_id}",
        url=snapshot.canonical_url,
        details=JobDetails(
            title=_text(facts.get("title"), snapshot.title),
            company=_text(facts.get("company"), snapshot.company),
            location=remote_scope or "",
            description=_text(facts.get("description")),
            source=f"legacy:{snapshot.source_database}",
            source_metadata={
                "legacy_database": snapshot.source_database,
                "legacy_job_id": snapshot.legacy_job_id,
                "legacy_revision": snapshot.revision,
                "legacy_status": snapshot.status,
            },
            salary_min=_optional_int(facts.get("annual_base_min_usd")),
            salary_max=_optional_int(facts.get("annual_base_max_usd")),
            salary_currency="USD"
            if facts.get("annual_base_min_usd") is not None
            or facts.get("annual_base_max_usd") is not None
            else None,
            listing_closed=listing_closed,
            hq_country=_optional_text(facts.get("company_hq_country")),
            startup=_optional_bool(facts.get("is_startup")),
            work_authorization_required=_optional_bool(facts.get("requires_us_work_authorization")),
            us_only=_legacy_us_only(remote_scope),
            remote_from_ecuador=_legacy_remote_from_ecuador(remote_scope),
            remote_arrangement=remote_scope,
            hiring_arrangement=_optional_text(facts.get("work_arrangement")),
        ),
        decision=_legacy_decision(snapshot.state),
        stage=_legacy_application_stage(snapshot.state),
        event_at=_timestamp(snapshot.updated_at, source=snapshot.source_database),
    )


def _event_draft(snapshot: LegacyEventSnapshot) -> LegacyEventDraft:
    return LegacyEventDraft(
        source_key=(f"{snapshot.source_database}:event:{snapshot.legacy_event_id}"),
        job_key=(
            f"{snapshot.source_database}:{snapshot.legacy_job_id}"
            if snapshot.legacy_job_id
            else None
        ),
        occurred_at=_timestamp(snapshot.occurred_at, source=snapshot.source_database),
        node=snapshot.node,
        event_type=snapshot.event_type,
        detail=json.dumps(snapshot.detail, sort_keys=True, separators=(",", ":")),
    )


def _legacy_decision(state: Mapping[str, Any]) -> Decision:
    value = state.get("decision", state.get("human_decision"))
    normalized = str(value or "").strip().lower()
    return {
        "apply": Decision.TAILOR,
        "tailor": Decision.TAILOR,
        "watch": Decision.WATCH,
        "skip": Decision.SKIP,
    }.get(normalized, Decision.UNDECIDED)


def _legacy_application_stage(state: Mapping[str, Any]) -> ApplicationStage | None:
    outcomes = state.get("outcomes")
    if isinstance(outcomes, list):
        for outcome in reversed(outcomes):
            if not isinstance(outcome, Mapping):
                continue
            value = outcome.get("stage", outcome.get("outcome", outcome.get("status")))
            mapped = _application_stage(value)
            if mapped is not None:
                return mapped
    if state.get("submission") is not None:
        return ApplicationStage.SUBMITTED
    return None


def _application_stage(value: object) -> ApplicationStage | None:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "interviewing": ApplicationStage.TECHNICAL_INTERVIEW,
        "interview": ApplicationStage.TECHNICAL_INTERVIEW,
        "onsite": ApplicationStage.FINAL_OR_ONSITE,
        "final": ApplicationStage.FINAL_OR_ONSITE,
    }
    if normalized in aliases:
        return aliases[normalized]
    try:
        return ApplicationStage(normalized)
    except ValueError:
        return None


def _timestamp(value: str, *, source: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise LegacyStateError(f"invalid timestamp in {source}") from error
    if parsed.tzinfo is None:
        raise LegacyStateError(f"legacy timestamp in {source} must include a timezone")
    return parsed


def _text(value: object, fallback: str = "") -> str:
    return str(value).strip() if value is not None else fallback.strip()


def _optional_text(value: object) -> str | None:
    text = _text(value)
    return text or None


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if not isinstance(value, (int, float, str)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _legacy_us_only(remote_scope: str | None) -> bool | None:
    if remote_scope is None:
        return None
    normalized = remote_scope.lower().replace("-", "_").replace(" ", "_")
    if normalized in {"us", "usa", "united_states", "us_only"}:
        return True
    if normalized in {"global", "worldwide", "latam", "latin_america", "ecuador"}:
        return False
    return None


def _legacy_remote_from_ecuador(remote_scope: str | None) -> bool | None:
    us_only = _legacy_us_only(remote_scope)
    if us_only is not None:
        return not us_only
    return None


__all__ = [
    "LegacyDatabaseSummary",
    "LegacyEventSnapshot",
    "LegacyJobSnapshot",
    "LegacyMasterStateReader",
    "LegacyStateBundle",
    "LegacyStateError",
]
