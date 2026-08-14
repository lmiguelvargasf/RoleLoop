from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from roleloop.domain import (
    ArtifactRef,
    EvidenceSourceKind,
    ResumeEvidenceVersion,
    ResumeSource,
    ResumeSourceKind,
    SearchProfile,
)
from roleloop.infrastructure import SQLiteDatabase, SQLiteUnitOfWorkFactory

NOW = datetime(2026, 8, 14, tzinfo=UTC)
CHECKSUM = "a" * 64


def test_resume_source_and_evidence_provenance_round_trip(tmp_path: Path) -> None:
    factory = SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3"))
    profile = SearchProfile(
        id="profile-1",
        name="Primary",
        target_roles=("Engineer",),
        is_active=True,
        created_at=NOW,
        updated_at=NOW,
    )
    source = ResumeSource(
        id="source-1",
        profile_id=profile.id,
        kind=ResumeSourceKind.REMOTE_GIT,
        repository="https://example.com/resume.git",
        ref="main",
        document_path="resume.md",
        created_at=NOW,
        updated_at=NOW,
    )
    evidence = ResumeEvidenceVersion(
        id="evidence-1",
        profile_id=profile.id,
        source_kind=EvidenceSourceKind.TEXT_FILE,
        source_name="resume.md",
        source_artifact=ArtifactRef("artifact-1", CHECKSUM, "managed/resume", "text/markdown", 6),
        extracted_text="Resume",
        created_at=NOW,
        resume_source_id=source.id,
        source_revision="commit-1",
        resume_source_kind=source.kind,
        source_repository=source.repository,
        source_ref=source.ref,
        source_document_path=source.document_path,
    )
    synced = replace(
        source,
        last_synced_revision="commit-1",
        last_synced_checksum=CHECKSUM,
        last_synced_evidence_version_id=evidence.id,
        last_synced_at=NOW,
        revision=2,
    )

    with factory() as uow:
        uow.profiles.add(profile)
        uow.resume_sources.add(source)
        uow.evidence.add(evidence)
        assert uow.resume_sources.update(synced, expected_revision=1)
        uow.commit()

    with factory() as uow:
        assert uow.resume_sources.get(source.id) == synced
        assert uow.resume_sources.get_for_profile(profile.id) == synced
        assert uow.evidence.get(evidence.id) == evidence

    reconfigured = replace(
        synced,
        repository="https://example.com/replacement.git",
        ref="stable",
        document_path="cv/current.md",
        last_synced_revision=None,
        last_synced_checksum=None,
        last_synced_evidence_version_id=None,
        last_synced_at=None,
        revision=3,
    )
    with factory() as uow:
        assert uow.resume_sources.update(reconfigured, expected_revision=2)
        uow.commit()

    with factory() as uow:
        historical_evidence = uow.evidence.get(evidence.id)
        assert historical_evidence == evidence
        assert historical_evidence is not None
        assert historical_evidence.source_repository == "https://example.com/resume.git"
        assert historical_evidence.source_ref == "main"
        assert historical_evidence.source_document_path == "resume.md"


def test_resume_source_is_unique_per_profile_and_provenance_is_complete(
    tmp_path: Path,
) -> None:
    factory = SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3"))
    profile = SearchProfile(id="profile-1", name="Primary")
    source = ResumeSource(
        id="source-1",
        profile_id=profile.id,
        kind=ResumeSourceKind.LOCAL_GIT,
        repository="/tmp/resume",
        ref="HEAD",
        document_path="resume.md",
    )
    with factory() as uow:
        uow.profiles.add(profile)
        uow.resume_sources.add(source)
        uow.commit()

    with factory() as uow, pytest.raises(sqlite3.IntegrityError):
        uow.resume_sources.add(replace(source, id="source-2"))

    incomplete = ResumeEvidenceVersion(
        id="evidence-1",
        profile_id=profile.id,
        source_kind=EvidenceSourceKind.TEXT_FILE,
        source_name="resume.md",
        source_artifact=ArtifactRef("artifact-1", CHECKSUM, "managed/resume", "text/markdown", 6),
        extracted_text="Resume",
        created_at=NOW,
        resume_source_id=source.id,
    )
    with factory() as uow, pytest.raises(sqlite3.IntegrityError, match="provenance"):
        uow.evidence.add(incomplete)
