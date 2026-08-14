from __future__ import annotations

import sqlite3
from importlib.resources import files

_MIGRATION_FILES = ((1, "001_initial.sql"),)
_KNOWN_VERSIONS = tuple(version for version, _ in _MIGRATION_FILES)


class UnsupportedSchemaVersionError(RuntimeError):
    pass


def apply_migrations(connection: sqlite3.Connection) -> None:
    """Apply packaged, numbered SQL migrations atomically and in order."""

    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        applied = {
            int(row[0]) for row in connection.execute("SELECT version FROM schema_migrations")
        }
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
