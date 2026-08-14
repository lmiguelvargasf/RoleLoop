from __future__ import annotations

import subprocess

from roleloop.application import ProfileDraft, ResumeSourceDraft, RoleLoopService
from roleloop.bootstrap import build_service
from roleloop.domain import ResumeSourceKind
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
        "discovery": False,
        "review": False,
        "resume_generation": False,
        "resume_validation": False,
        "pdf_compilation": False,
        "evidence_extraction": True,
        "artifact_storage": True,
        "resume_source_sync": True,
    }


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


async def test_bootstrapped_service_syncs_a_committed_local_resume(tmp_path) -> None:
    repository = tmp_path / "master-resume"
    repository.mkdir()
    subprocess.run(
        ["git", "init", "-b", "main", str(repository)],
        check=True,
        capture_output=True,
    )
    for key, value in (
        ("user.email", "roleloop@example.test"),
        ("user.name", "RoleLoop Tests"),
    ):
        subprocess.run(
            ["git", "-C", str(repository), "config", key, value],
            check=True,
            capture_output=True,
        )
    (repository / "resume.md").write_text("# Experience\n\nBuilt RoleLoop\n", encoding="utf-8")
    subprocess.run(
        ["git", "-C", str(repository), "add", "--", "resume.md"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(repository), "commit", "-m", "Add master resume"],
        check=True,
        capture_output=True,
    )
    revision = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    paths = RoleLoopPaths(
        data_dir=tmp_path / "data",
        database_path=tmp_path / "data" / "roleloop.sqlite3",
        artifacts_dir=tmp_path / "data" / "artifacts",
    )
    service = build_service(paths)
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository=str(repository),
            kind=ResumeSourceKind.LOCAL_GIT,
            document_path="resume.md",
        ),
    )

    evidence = await service.sync_resume_source(profile.id)

    assert evidence.source_revision == revision
    assert evidence.source_repository == str(repository)
    assert evidence.extracted_text == "# Experience\n\nBuilt RoleLoop\n"
    assert (paths.artifacts_dir / evidence.source_artifact.uri).is_file()
    summary = service.get_active_profile_summary()
    assert summary is not None
    assert summary.profile.active_evidence_version_id == evidence.id
    assert summary.resume_source is not None
    assert summary.resume_source.last_synced_evidence_version_id == evidence.id
