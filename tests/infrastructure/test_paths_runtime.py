from __future__ import annotations

from datetime import UTC
from pathlib import Path
from uuid import UUID

from roleloop.infrastructure import RoleLoopPaths, SystemClock, UUID4Generator


def test_data_directory_override_controls_managed_paths(tmp_path: Path) -> None:
    paths = RoleLoopPaths.from_environment({"ROLELOOP_DATA_DIR": str(tmp_path)})

    assert paths.data_dir == tmp_path
    assert paths.database_path == tmp_path / "roleloop.sqlite3"
    assert paths.artifacts_dir == tmp_path / "artifacts"

    paths.ensure_directories()
    assert paths.artifacts_dir.is_dir()


def test_database_override_uses_its_parent_for_other_managed_data(tmp_path: Path) -> None:
    database_path = tmp_path / "custom" / "state.db"
    paths = RoleLoopPaths.from_environment({"ROLELOOP_DB_PATH": str(database_path)})

    assert paths.database_path == database_path
    assert paths.data_dir == database_path.parent
    assert paths.artifacts_dir == database_path.parent / "artifacts"


def test_system_clock_and_uuid_generator_produce_port_values() -> None:
    now = SystemClock().now()
    identifier = UUID4Generator().new()

    assert now.tzinfo is UTC
    assert str(UUID(identifier)) == identifier
