from __future__ import annotations

from roleloop.bootstrap import build_service
from roleloop.infrastructure.paths import RoleLoopPaths


def test_build_service_bootstraps_sqlite_and_local_capabilities(tmp_path) -> None:
    paths = RoleLoopPaths(
        data_dir=tmp_path,
        database_path=tmp_path / "roleloop.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
    )

    service = build_service(paths)

    assert service.get_active_profile_summary() is None
    assert paths.database_path.is_file()
    assert service.provider_capabilities == {
        "discovery": False,
        "review": False,
        "resume_generation": False,
        "resume_validation": False,
        "pdf_compilation": False,
        "evidence_extraction": True,
        "artifact_storage": True,
    }
