from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path

DATA_DIR_ENV = "ROLELOOP_DATA_DIR"
DATABASE_PATH_ENV = "ROLELOOP_DB_PATH"


@dataclass(frozen=True, slots=True)
class RoleLoopPaths:
    """Resolved locations for local, managed RoleLoop state."""

    data_dir: Path
    database_path: Path
    artifacts_dir: Path

    @property
    def resume_sources_dir(self) -> Path:
        """Managed clone cache used only during explicit résumé synchronization."""

        return self.data_dir / "resume-sources"

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> RoleLoopPaths:
        values = os.environ if environment is None else environment
        data_override = values.get(DATA_DIR_ENV)
        database_override = values.get(DATABASE_PATH_ENV)

        if data_override:
            data_dir = _absolute_path(data_override)
        elif database_override:
            data_dir = _absolute_path(database_override).parent
        else:
            data_dir = user_data_path("RoleLoop", appauthor=False, ensure_exists=False)

        database_path = (
            _absolute_path(database_override)
            if database_override
            else data_dir / "roleloop.sqlite3"
        )
        return cls(
            data_dir=data_dir,
            database_path=database_path,
            artifacts_dir=data_dir / "artifacts",
        )

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.resume_sources_dir.mkdir(parents=True, exist_ok=True)


def _absolute_path(value: str) -> Path:
    return Path(value).expanduser().resolve(strict=False)
