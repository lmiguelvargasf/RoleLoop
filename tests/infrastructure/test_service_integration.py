from __future__ import annotations

from pathlib import Path

import pytest

from roleloop.application import EvidenceImport, ProfileDraft, ProviderUnavailableError
from roleloop.application.services import RoleLoopService
from roleloop.domain import EvidenceSourceKind
from roleloop.infrastructure import (
    FileSystemArtifactStore,
    LocalEvidenceExtractor,
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
    SystemClock,
    UnavailableDiscoveryProvider,
    UnavailablePdfCompiler,
    UnavailableResumeGenerator,
    UnavailableResumeValidator,
    UnavailableReviewAnalyzer,
    UUID4Generator,
)


@pytest.mark.asyncio
async def test_service_uses_sqlite_and_local_adapters_end_to_end(tmp_path: Path) -> None:
    artifacts = FileSystemArtifactStore(tmp_path / "artifacts")
    service = RoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3")),
        SystemClock(),
        UUID4Generator(),
        discovery=UnavailableDiscoveryProvider(),
        analyzer=UnavailableReviewAnalyzer(),
        generator=UnavailableResumeGenerator(),
        validator=UnavailableResumeValidator(),
        compiler=UnavailablePdfCompiler(),
        evidence_extractor=LocalEvidenceExtractor(),
        artifact_store=artifacts,
    )

    profile = service.create_profile(ProfileDraft(name="Main", target_roles=("Platform Engineer",)))
    case = service.add_job_url(profile.id, "https://example.com/jobs/1?utm_source=test")
    evidence = await service.import_evidence(
        profile.id,
        EvidenceImport(
            source_kind=EvidenceSourceKind.PASTED_TEXT,
            text="Built resilient Python services.",
        ),
    )

    summary = service.get_active_profile_summary()
    assert summary is not None
    assert summary.profile.active_evidence_version_id == evidence.id
    assert summary.provider_capabilities["review"] is False
    assert summary.provider_capabilities["evidence_extraction"] is True
    assert artifacts.exists(evidence.source_artifact.uri)
    assert service.list_inbox(profile.id)[0].case_id == case.id

    with pytest.raises(ProviderUnavailableError):
        await service.discover_jobs(profile.id, limit=1)
    assert len(service.list_inbox(profile.id)) == 1
