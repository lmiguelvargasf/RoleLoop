from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path
from urllib.parse import quote

_MIGRATION_FILES = (
    (1, "001_initial.sql"),
    (2, "002_resume_sources.sql"),
    (3, "003_authoritative_versions.sql"),
    (4, "004_agent_workflow.sql"),
    (5, "005_resume_lineage.sql"),
    (6, "006_applications_followups.sql"),
    (7, "007_legacy_integrity.sql"),
)
_KNOWN_VERSIONS = tuple(version for version, _ in _MIGRATION_FILES)
_STRUCTURAL_UPGRADE_VERSION = 3


class UnsupportedSchemaVersionError(RuntimeError):
    pass


def apply_migrations(connection: sqlite3.Connection) -> None:
    """Apply packaged, numbered SQL migrations atomically and in order."""

    connection.execute("BEGIN IMMEDIATE")
    try:
        existing_tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        has_migration_table = "schema_migrations" in existing_tables
        applied = (
            {int(row[0]) for row in connection.execute("SELECT version FROM schema_migrations")}
            if has_migration_table
            else set()
        )
        unsupported = applied.difference(_KNOWN_VERSIONS)
        if unsupported:
            newest = max(unsupported)
            supported = max(_KNOWN_VERSIONS)
            if newest > supported:
                raise UnsupportedSchemaVersionError(
                    f"database schema version {newest} is newer than supported version {supported}"
                )
            raise UnsupportedSchemaVersionError(
                f"database contains unknown schema version {newest}"
            )

        pending = tuple(version for version in _KNOWN_VERSIONS if version not in applied)
        if existing_tables and any(version >= _STRUCTURAL_UPGRADE_VERSION for version in pending):
            _create_timestamped_backup(connection)

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        migration_root = files("roleloop.infrastructure.migrations")
        for version, filename in _MIGRATION_FILES:
            if version in applied:
                continue
            script = migration_root.joinpath(filename).read_text(encoding="utf-8")
            for statement in _sql_statements(script):
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations (version) VALUES (?)",
                (version,),
            )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def _create_timestamped_backup(connection: sqlite3.Connection) -> Path | None:
    """Create a consistent sibling backup before v1's structural upgrade.

    The caller already owns SQLite's writer slot. A separate read-only source
    connection lets SQLite include committed WAL content without copying live
    database files directly. In-memory and temporary databases have no durable
    path and therefore need no backup.
    """

    database_row = next(
        (row for row in connection.execute("PRAGMA database_list") if str(row[1]) == "main"),
        None,
    )
    if database_row is None or not str(database_row[2]):
        return None
    database_path = Path(str(database_row[2])).resolve(strict=False)
    if not database_path.is_file():
        return None

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    backup_path = database_path.with_name(f"{database_path.name}.backup-{timestamp}")
    sequence = 1
    while backup_path.exists():
        backup_path = database_path.with_name(f"{database_path.name}.backup-{timestamp}-{sequence}")
        sequence += 1

    source_uri = f"file:{quote(str(database_path), safe='/')}?mode=ro"
    source = sqlite3.connect(source_uri, uri=True)
    destination = sqlite3.connect(backup_path)
    try:
        source.backup(destination)
        result = destination.execute("PRAGMA integrity_check").fetchone()
        if result is None or str(result[0]).lower() != "ok":
            raise sqlite3.DatabaseError("pre-upgrade backup failed its integrity check")
    except BaseException:
        destination.close()
        source.close()
        backup_path.unlink(missing_ok=True)
        raise
    destination.close()
    source.close()
    return backup_path


def _sql_statements(script: str) -> tuple[str, ...]:
    statements: list[str] = []
    buffer = ""
    for line in script.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement:
                statements.append(statement)
            buffer = ""
    if buffer.strip():
        raise ValueError("Incomplete SQL statement in packaged migration")
    return tuple(statements)
