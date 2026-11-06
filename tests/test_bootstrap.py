from __future__ import annotations

import pytest

from roleloop.application import ConcurrentInstanceError, ProfileDraft, RoleLoopService
from roleloop.bootstrap import build_service
from roleloop.domain import AgentProvider
from roleloop.infrastructure import (
    RoleLoopPaths,
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
    SystemClock,
    UUID4Generator,
)


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
        "discovery": True,
        "review": True,
        "resume_generation": True,
        "resume_validation": True,
        "pdf_compilation": True,
        "evidence_extraction": True,
        "artifact_storage": True,
        "resume_source_sync": True,
        "agent_registry": True,
        "master_resume_renderer": True,
        "pdf_inspection": True,
        "artifact_read": True,
        "artifact_export": True,
        "runtime_doctor": True,
    }
    service.close()


def test_resume_source_sync_capability_requires_snapshot_storage(tmp_path) -> None:
    class Synchronizer:
        async def sync(self, source, *, progress):  # type: ignore[no-untyped-def]
            raise AssertionError("capability checks must not synchronize")

    service = RoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3")),
        SystemClock(),
        UUID4Generator(),
        resume_source_synchronizer=Synchronizer(),
    )

    assert service.provider_capabilities["resume_source_sync"] is False


def test_bootstrapped_service_persists_explicit_demo_profile_across_restart(tmp_path) -> None:
    paths = RoleLoopPaths(
        data_dir=tmp_path / "data",
        database_path=tmp_path / "data" / "roleloop.sqlite3",
        artifacts_dir=tmp_path / "data" / "artifacts",
    )
    service = build_service(paths)
    profile = service.create_profile(
        ProfileDraft(
            "Primary",
            target_roles=("Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )

    with pytest.raises(ConcurrentInstanceError, match="already using"):
        build_service(paths)

    service.close()
    restarted = build_service(paths)
    summary = restarted.get_active_profile_summary()
    assert summary is not None
    assert summary.profile.id == profile.id
    assert summary.profile.current_version_id is not None
    assert summary.profile.agent_configurations
    assert {configuration.provider for configuration in summary.profile.agent_configurations} == {
        AgentProvider.DEMO
    }
    restarted.close()


def test_services_with_different_data_directories_contend_for_the_same_database(tmp_path) -> None:
    database_path = tmp_path / "shared" / "authoritative.sqlite3"
    first_paths = RoleLoopPaths(
        data_dir=tmp_path / "first-data",
        database_path=database_path,
        artifacts_dir=tmp_path / "first-data" / "artifacts",
    )
    second_paths = RoleLoopPaths(
        data_dir=tmp_path / "second-data",
        database_path=database_path,
        artifacts_dir=tmp_path / "second-data" / "artifacts",
    )

    assert first_paths.process_lock_path == second_paths.process_lock_path
    first = build_service(first_paths)
    try:
        with pytest.raises(ConcurrentInstanceError, match="already using"):
            build_service(second_paths)
    finally:
        first.close()
