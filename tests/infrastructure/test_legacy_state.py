from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from roleloop.domain import Decision
from roleloop.infrastructure.legacy import LegacyMasterStateReader, LegacyStateError


def _create_database(path: Path, *, v2: bool, url: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = "jobs" if v2 else "job_runs"
    state_column = "status" if v2 else "stage"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            f"""
            CREATE TABLE {table} (
                job_id TEXT PRIMARY KEY,
                canonical_url TEXT NOT NULL UNIQUE,
                company TEXT NOT NULL,
                title TEXT NOT NULL,
                {state_column} TEXT NOT NULL,
                revision INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                node TEXT NOT NULL,
                event_type TEXT NOT NULL,
                detail_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            f"""INSERT INTO {table}
                (job_id, canonical_url, company, title, {state_column}, revision,
                 state_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "legacy-1",
                url,
                "Example Co",
                "AI Engineer",
                "review",
                2,
                json.dumps({"job": {"url": url}}),
                "2026-01-01T00:00:00+00:00",
                "2026-01-02T00:00:00+00:00",
            ),
        )
        connection.execute(
            """INSERT INTO events
               (job_id, occurred_at, node, event_type, detail_json)
               VALUES (?, ?, ?, ?, ?)""",
            (
                "legacy-1",
                "2026-01-02T00:00:00+00:00",
                "match_agent",
                "job_assessed",
                json.dumps({"priority": "high"}),
            ),
        )


def test_reader_previews_both_databases_without_modifying_them(tmp_path: Path) -> None:
    state_dir = tmp_path / ".job-agent"
    first = state_dir / "state.sqlite3"
    second = state_dir / "state-v2.sqlite3"
    shared_url = "https://jobs.example.test/123"
    _create_database(first, v2=False, url=shared_url)
    _create_database(second, v2=True, url=shared_url)
    before = {
        path: (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
        for path in (first, second)
    }

    bundle = LegacyMasterStateReader().read(tmp_path)

    assert [item.name for item in bundle.databases] == [
        "state.sqlite3",
        "state-v2.sqlite3",
    ]
    assert len(bundle.jobs) == 2
    assert len(bundle.events) == 2
    assert bundle.duplicate_urls == (shared_url,)
    assert bundle.jobs[0].state["job"]["url"] == shared_url
    assert bundle.events[0].detail == {"priority": "high"}
    after = {
        path: (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
        for path in (first, second)
    }
    assert after == before

    draft = LegacyMasterStateReader().to_import_draft(tmp_path)
    assert [(item.name, item.checksum) for item in bundle.databases] == [
        (item.database_name, item.source_checksum) for item in draft.sources
    ]
    assert [item.job_count for item in draft.sources] == [1, 1]
    assert [item.event_count for item in draft.sources] == [1, 1]
    assert draft.source_job_count == 2
    assert draft.source_event_count == 2
    assert draft.duplicate_urls == (shared_url,)
    # A prototype workflow stage is not interpreted as a v1 human decision,
    # résumé approval, or application submission.
    assert {item.decision for item in draft.jobs} == {Decision.UNDECIDED}
    assert {item.stage for item in draft.jobs} == {None}
    assert all(item.details.source.startswith("legacy:") for item in draft.jobs)
    assert all("legacy_database" in item.details.source_metadata for item in draft.jobs)


def test_reader_returns_empty_bundle_when_no_legacy_state_exists(tmp_path: Path) -> None:
    bundle = LegacyMasterStateReader().read(tmp_path)

    assert bundle.databases == ()
    assert bundle.jobs == ()
    assert bundle.events == ()
    assert bundle.duplicate_urls == ()


def test_reader_rejects_an_unexpected_schema(tmp_path: Path) -> None:
    path = tmp_path / ".job-agent" / "state-v2.sqlite3"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE jobs (job_id TEXT PRIMARY KEY)")
        connection.execute("CREATE TABLE events (id INTEGER PRIMARY KEY)")

    with pytest.raises(LegacyStateError, match="missing columns"):
        LegacyMasterStateReader().read(tmp_path)
