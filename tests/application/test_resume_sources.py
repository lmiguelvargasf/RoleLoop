from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

import pytest

from roleloop.application import (
    ArtifactError,
    InvalidTransitionError,
    ProfileDraft,
    ResumeSourceDraft,
    ResumeSourceSnapshot,
    RevisionConflictError,
    RoleLoopService,
    ValidationError,
)
from roleloop.domain import ArtifactRef, ResumeSourceKind

from .fakes import AdvancingClock, MemoryUnitOfWorkFactory, SequentialIds


class SnapshotSynchronizer:
    def __init__(self, snapshot: ResumeSourceSnapshot) -> None:
        self.snapshot = snapshot
        self.calls = 0

    async def sync(self, source, *, progress) -> ResumeSourceSnapshot:
        del source, progress
        self.calls += 1
        return self.snapshot


class MemoryArtifactStore:
    def __init__(self) -> None:
        self.calls = 0

    async def put_bytes(self, data: bytes, *, media_type: str, extension: str) -> ArtifactRef:
        del extension
        self.calls += 1
        checksum = hashlib.sha256(data).hexdigest()
        return ArtifactRef(
            id=f"artifact-{self.calls}",
            checksum=checksum,
            uri=f"managed/{checksum}",
            media_type=media_type,
            size_bytes=len(data),
        )


def _snapshot(
    *, revision: str = "commit-1", content: bytes = b"Master resume"
) -> ResumeSourceSnapshot:
    return ResumeSourceSnapshot(
        source_bytes=content,
        extracted_text=content.decode(),
        source_name="resume.md",
        media_type="text/markdown",
        extension=".md",
        source_revision=revision,
        content_checksum=hashlib.sha256(content).hexdigest(),
    )


def _service(
    *, synchronizer: SnapshotSynchronizer | None = None
) -> tuple[RoleLoopService, MemoryUnitOfWorkFactory, MemoryArtifactStore]:
    factory = MemoryUnitOfWorkFactory()
    store = MemoryArtifactStore()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        resume_source_synchronizer=synchronizer,
        artifact_store=store,
    )
    return service, factory, store


def test_configure_source_applies_kind_specific_defaults_and_optimistic_updates(
    tmp_path: Path,
) -> None:
    service, _, _ = _service()
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))

    source = service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository=str(tmp_path),
            kind=ResumeSourceKind.LOCAL_GIT,
            document_path="resume/master.md",
        ),
    )

    assert source.ref == "HEAD"
    assert source.repository == str(tmp_path.resolve())
    assert service.get_resume_source(profile.id) == source
    assert service.get_active_profile_summary().resume_source == source  # type: ignore[union-attr]

    with pytest.raises(RevisionConflictError):
        service.configure_resume_source(
            profile.id,
            ResumeSourceDraft(
                repository="https://example.com/resume.git",
                kind=ResumeSourceKind.REMOTE_GIT,
                document_path="resume.md",
            ),
            expected_revision=99,
        )

    updated = service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository="https://example.com/resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            document_path="resume.md",
        ),
        expected_revision=source.revision,
    )
    assert updated.ref == "main"
    assert updated.revision == source.revision + 1


@pytest.mark.parametrize(
    ("repository", "kind", "document_path"),
    (
        ("relative/repository", ResumeSourceKind.LOCAL_GIT, "resume.md"),
        ("ftp://example.com/resume.git", ResumeSourceKind.REMOTE_GIT, "resume.md"),
        ("https://user@example.com/resume.git", ResumeSourceKind.REMOTE_GIT, "resume.md"),
        (
            "https://example.com/resume.git?token=secret",
            ResumeSourceKind.REMOTE_GIT,
            "resume.md",
        ),
        ("http://[", ResumeSourceKind.REMOTE_GIT, "resume.md"),
        ("https://example.com/resume.git", ResumeSourceKind.REMOTE_GIT, "../resume.md"),
        ("https://example.com/resume.git", ResumeSourceKind.REMOTE_GIT, "/resume.md"),
        ("https://example.com/resume.git", ResumeSourceKind.REMOTE_GIT, "resume\n.md"),
    ),
)
def test_configure_source_rejects_unsafe_locations(
    repository: str,
    kind: ResumeSourceKind,
    document_path: str,
) -> None:
    service, _, _ = _service()
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))

    with pytest.raises(ValidationError):
        service.configure_resume_source(
            profile.id,
            ResumeSourceDraft(repository, kind, document_path),
        )


async def test_sync_creates_pinned_evidence_and_is_idempotent_for_same_snapshot() -> None:
    synchronizer = SnapshotSynchronizer(_snapshot())
    service, factory, store = _service(synchronizer=synchronizer)
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))
    source = service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            "https://example.com/resume.git",
            ResumeSourceKind.REMOTE_GIT,
            "resume.md",
        ),
    )

    evidence = await service.sync_resume_source(profile.id)
    again = await service.sync_resume_source(profile.id)

    assert again == evidence
    assert evidence.resume_source_id == source.id
    assert evidence.source_revision == "commit-1"
    assert evidence.resume_source_kind is ResumeSourceKind.REMOTE_GIT
    assert evidence.source_repository == "https://example.com/resume.git"
    assert evidence.source_ref == "main"
    assert evidence.source_document_path == "resume.md"
    assert evidence.source_artifact.checksum == synchronizer.snapshot.content_checksum
    assert store.calls == 1
    with factory() as uow:
        synced = uow.resume_sources.get_for_profile(profile.id)
        active_profile = uow.profiles.get(profile.id)
        assert synced is not None
        assert synced.last_synced_revision == "commit-1"
        assert synced.last_synced_checksum == synchronizer.snapshot.content_checksum
        assert synced.last_synced_evidence_version_id == evidence.id
        assert active_profile is not None
        assert active_profile.active_evidence_version_id == evidence.id


async def test_reconfiguring_source_does_not_reinterpret_existing_evidence() -> None:
    synchronizer = SnapshotSynchronizer(_snapshot())
    service, factory, _ = _service(synchronizer=synchronizer)
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))
    original_source = service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            "https://example.com/original.git",
            ResumeSourceKind.REMOTE_GIT,
            "resume/master.md",
            ref="main",
        ),
    )
    original_evidence = await service.sync_resume_source(profile.id)

    reconfigured = service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            "https://example.com/replacement.git",
            ResumeSourceKind.REMOTE_GIT,
            "cv/current.md",
            ref="stable",
        ),
        expected_revision=original_source.revision + 1,
    )

    assert reconfigured.repository == "https://example.com/replacement.git"
    assert reconfigured.ref == "stable"
    assert reconfigured.document_path == "cv/current.md"
    with factory() as uow:
        persisted = uow.evidence.get(original_evidence.id)
        assert persisted is not None
        assert persisted.resume_source_kind is ResumeSourceKind.REMOTE_GIT
        assert persisted.source_repository == "https://example.com/original.git"
        assert persisted.source_ref == "main"
        assert persisted.source_document_path == "resume/master.md"


async def test_new_revision_creates_new_evidence_even_when_document_bytes_match() -> None:
    synchronizer = SnapshotSynchronizer(_snapshot())
    service, factory, store = _service(synchronizer=synchronizer)
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            "https://example.com/resume.git",
            ResumeSourceKind.REMOTE_GIT,
            "resume.md",
        ),
    )
    first = await service.sync_resume_source(profile.id)

    synchronizer.snapshot = replace(synchronizer.snapshot, source_revision="commit-2")
    second = await service.sync_resume_source(profile.id)

    assert second.id != first.id
    assert second.source_revision == "commit-2"
    assert store.calls == 2
    with factory() as uow:
        assert uow.evidence.list_for_profile(profile.id) == (first, second)


async def test_sync_requires_configuration_and_verifies_provider_checksum() -> None:
    synchronizer = SnapshotSynchronizer(replace(_snapshot(), content_checksum="0" * 64))
    service, _, _ = _service(synchronizer=synchronizer)
    profile = service.create_profile(ProfileDraft("Primary", target_roles=("Engineer",)))

    with pytest.raises(InvalidTransitionError):
        await service.sync_resume_source(profile.id)

    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            "https://example.com/resume.git",
            ResumeSourceKind.REMOTE_GIT,
            "resume.md",
        ),
    )
    with pytest.raises(ArtifactError, match="checksum"):
        await service.sync_resume_source(profile.id)
