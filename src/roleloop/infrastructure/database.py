from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from .migration_runner import apply_migrations


class SQLiteDatabase:
    """Connection factory with RoleLoop's required SQLite safety pragmas."""

    def __init__(self, path: Path, *, busy_timeout_ms: int = 5_000) -> None:
        if busy_timeout_ms < 0:
            raise ValueError("busy_timeout_ms cannot be negative")
        self.path = path.resolve(strict=False)
        self.busy_timeout_ms = busy_timeout_ms
        self._migration_lock = threading.Lock()
        self._initialized = False

    def connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            self.path,
            timeout=self.busy_timeout_ms / 1_000,
            isolation_level=None,
        )
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms}")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            self._initialize(connection)
        except BaseException:
            connection.close()
            raise
        return connection

    def _initialize(self, connection: sqlite3.Connection) -> None:
        if self._initialized:
            return
        with self._migration_lock:
            if not self._initialized:
                apply_migrations(connection)
                self._initialized = True
