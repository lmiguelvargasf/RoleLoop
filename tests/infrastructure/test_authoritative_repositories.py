from __future__ import annotations

import hashlib
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from roleloop.application import (
    AgentAudit,
    AgentDescriptor,
    DiscoveredJob,
    JobDetails,
    LegacyEventDraft,
    LegacyImportDraft,
    LegacyJobDraft,
    LegacySourceManifest,
    ProfileDraft,
    RoleLoopService,
    ScoutReport,
    WebSourceDraft,
)
from roleloop.domain import (
    AgentKind,
    AgentProvider,
    AgentRun,
    AgentRunStatus,
    ArtifactRef,
    Decision,
    DecisionReason,
    EvidenceSourceKind,
    JobSourceKind,
    ResumeEvidenceVersion,
    ResumeRun,
    ResumeStage,
    ReviewVersion,
)
from roleloop.infrastructure import (
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
    SystemClock,
    UUID4Generator,
)


class _Discovery:
    version = "test-v1"

    async def discover(self, profile, *, limit, progress):
        del profile, limit, progress
        details = JobDetails(
            title="Platform Engineer",
            company="Example, Inc.",
            external_requisition_id="REQ-123",
        )
        return (
            DiscoveredJob("https://company.example/jobs/req-123", details),
            DiscoveredJob("https://ats.example/openings/987", details),
        )


class _UnusedAgentRegistry:
    def scout(self, profile_version):
        del profile_version
        raise AssertionError("Scout must not run in this persistence test")

    def reviewer(self, profile_version):
        del profile_version
        raise AssertionError("Reviewer must not run in this persistence test")

    def resume(self, profile_version):
        del profile_version
        raise AssertionError("Resume must not run in this persistence test")


class _SameRequisitionScout:
    descriptor = AgentDescriptor(
        provider=AgentProvider.DEMO,
        model="gpt-5.6-terra",
        prompt_version="test-v1",
        output_schema_version="test-v1",
        prompt_hash="1" * 64,
        output_schema_hash="2" * 64,
    )

    def __init__(self) -> None:
        self.calls = 0

    async def discover(self, context, *, progress):
        del context, progress
        self.calls += 1
        details = JobDetails(
            title="Platform Engineer",
            company="Example, Inc.",
            external_requisition_id="REQ-123",
        )
        ats_url = "https://ats.example/openings/987"
        company_url = "https://company.example/jobs/req-123"
        if self.calls == 1:
            candidates = (
                DiscoveredJob(
                    ats_url,
                    details,
                    (
                        WebSourceDraft(
                            ats_url,
                            JobSourceKind.ATS,
                            quoted_evidence="ATS listing",
                        ),
                    ),
                ),
                DiscoveredJob(
                    company_url,
                    replace(
                        details,
                        company="example inc",
                        external_requisition_id="req 123",
                    ),
                    (
                        WebSourceDraft(
                            company_url,
                            JobSourceKind.COMPANY,
                            quoted_evidence="Company listing",
                        ),
                    ),
                ),
            )
            source_urls = (ats_url, company_url)
        else:
            candidates = (
                DiscoveredJob(
                    ats_url,
                    JobDetails(title="Platform Engineer", company="Example, Inc."),
                    (
                        WebSourceDraft(
                            ats_url,
                            JobSourceKind.ATS,
                            quoted_evidence="Refreshed ATS listing",
                        ),
                    ),
                ),
            )
            source_urls = (ats_url,)
        return ScoutReport(
            candidates,
            AgentAudit(
                source_urls=source_urls,
                prompt_hash=self.descriptor.prompt_hash,
                output_schema_hash=self.descriptor.output_schema_hash,
            ),
        )


class _SameRequisitionRegistry:
    def __init__(self) -> None:
        self.scout_agent = _SameRequisitionScout()

    def scout(self, profile_version):
        del profile_version
        return self.scout_agent

    def reviewer(self, profile_version):
        del profile_version
        raise AssertionError("Reviewer must not run in this Scout test")

    def resume(self, profile_version):
        del profile_version
        raise AssertionError("Resume must not run in this Scout test")


class _DirectSourceAliasScout:
    descriptor = _SameRequisitionScout.descriptor

    def __init__(self) -> None:
        self.calls = 0

    async def discover(self, context, *, progress):
        del context, progress
        self.calls += 1
        aggregator_url = "https://aggregator.example/listings/platform-456"
        company_url = "https://company.example/jobs/platform-456"
        ats_url = "https://ats.example/openings/456"
        search_url = "https://search.example/results/platform-456"
        details = JobDetails(title="Platform Engineer", company="Example Inc")
        if self.calls == 1:
            candidates = (
                DiscoveredJob(
                    aggregator_url,
                    details,
                    (
                        WebSourceDraft(aggregator_url, JobSourceKind.AGGREGATOR),
                        WebSourceDraft(company_url, JobSourceKind.COMPANY),
                        WebSourceDraft(ats_url, JobSourceKind.ATS),
                        WebSourceDraft(search_url, JobSourceKind.SEARCH),
                    ),
                ),
            )
            source_urls = (aggregator_url, company_url, ats_url, search_url)
        else:
            candidates = (
                DiscoveredJob(
                    ats_url,
                    details,
                    (WebSourceDraft(ats_url, JobSourceKind.ATS),),
                ),
            )
            source_urls = (ats_url,)
        return ScoutReport(
            candidates,
            AgentAudit(
                source_urls=source_urls,
                prompt_hash=self.descriptor.prompt_hash,
                output_schema_hash=self.descriptor.output_schema_hash,
            ),
        )


class _DirectSourceAliasRegistry(_SameRequisitionRegistry):
    def __init__(self) -> None:
        self.scout_agent = _DirectSourceAliasScout()


def _profile_draft() -> ProfileDraft:
    return ProfileDraft(
        name="Primary",
        target_roles=("Platform Engineer",),
        agent_provider=AgentProvider.DEMO,
    )


def _artifact(identifier: str, payload: bytes) -> ArtifactRef:
    return ArtifactRef(
        id=identifier,
        checksum=hashlib.sha256(payload).hexdigest(),
        uri=f"managed/{identifier}",
        media_type="application/octet-stream",
        size_bytes=len(payload),
    )


@pytest.mark.asyncio
async def test_requisition_identity_dedupes_company_and_ats_urls(tmp_path) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    service = RoleLoopService(
        factory,
        SystemClock(),
        UUID4Generator(),
        discovery=_Discovery(),
    )
    profile = service.create_profile(_profile_draft())

    cases = await service.discover_jobs(profile.id)

    assert len(cases) == 2
    assert cases[0].job_id == cases[1].job_id
    with factory() as uow:
        persisted_profile = uow.profiles.get(profile.id)
        assert persisted_profile is not None
        assert persisted_profile.current_version_id is not None
        assert uow.profile_versions.get_current(profile.id) is not None
        identities = uow.jobs.list_identity_keys(cases[0].job_id)
        assert {item.kind.value for item in identities} == {
            "canonical_url",
            "requisition",
        }
        assert len(identities) == 3
        assert len(tuple(uow.job_versions.list_for_job(cases[0].job_id))) == 2
        agent_run = AgentRun(
            id="agent-run",
            command_id="agent-command",
            kind=AgentKind.SCOUT,
            provider=AgentProvider.DEMO,
            model="gpt-5.6-terra",
            prompt_version="v1",
            output_schema_version="v1",
            profile_id=profile.id,
            job_case_id=cases[0].id,
            input_fingerprint="0" * 64,
            status=AgentRunStatus.SUCCEEDED,
            prompt_hash="1" * 64,
            output_schema_hash="2" * 64,
            source_urls=("https://company.example/jobs/req-123",),
            created_at=datetime(2026, 8, 14, tzinfo=UTC),
        )
        uow.agent_runs.add(agent_run)
        assert uow.agent_runs.get(agent_run.id) == agent_run
        uow.commit()


@pytest.mark.asyncio
async def test_authoritative_scout_coalesces_same_report_and_retains_url_aliases(
    tmp_path,
) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    registry = _SameRequisitionRegistry()
    service = RoleLoopService(
        factory,
        SystemClock(),
        UUID4Generator(),
        agent_registry=registry,
    )
    profile = service.create_profile(_profile_draft())
    aggregator_url = "https://aggregator.example/listings/platform-123"
    company_url = "https://company.example/jobs/req-123"
    ats_url = "https://ats.example/openings/987"
    existing_case = service.add_job_url(profile.id, aggregator_url)
    with factory() as uow:
        existing_job = uow.jobs.get(existing_case.job_id)
        assert existing_job is not None
    service.update_job_details(
        profile.id,
        existing_case.job_id,
        JobDetails(
            title="Platform Engineer",
            company="Example Inc",
            external_requisition_id="req-123",
        ),
        expected_revision=existing_job.revision,
    )

    (first_case,) = await service.discover_jobs(
        profile.id,
        limit=1,
        command_id="same-report-scout",
    )
    assert first_case.id == existing_case.id

    with factory() as uow:
        receipt = uow.commands.get("same-report-scout")
        assert receipt is not None
        scout_run = uow.agent_runs.get_scout_run(receipt.result_id)
        assert scout_run is not None
        agent_run = uow.agent_runs.get(scout_run.agent_run_id)
        assert agent_run is not None
        assert agent_run.status is AgentRunStatus.SUCCEEDED
        candidates = tuple(uow.agent_runs.list_scout_candidates(scout_run.id))
        assert len(candidates) == 1
        assert candidates[0].job_id == first_case.job_id
        job = uow.jobs.get(first_case.job_id)
        assert job is not None
        assert job.canonical_url == aggregator_url
        assert {identity.key for identity in uow.jobs.list_identity_keys(first_case.job_id)} == {
            f"url:{aggregator_url}",
            f"url:{company_url}",
            f"url:{ats_url}",
            "requisition:example-inc:req-123",
        }
        assert {
            source.canonical_url
            for source in uow.job_versions.list_sources(candidates[0].job_version_id)
        } == {company_url, ats_url}

    review_view = service.get_job_case(profile.id, first_case.job_id)
    assert review_view.job.canonical_url == company_url
    (inbox_item,) = service.list_inbox(profile.id)
    assert inbox_item.canonical_url == company_url

    (second_case,) = await service.discover_jobs(
        profile.id,
        limit=1,
        command_id="alias-only-scout",
    )

    assert second_case.job_id == first_case.job_id
    with factory() as uow:
        receipt = uow.commands.get("alias-only-scout")
        assert receipt is not None
        scout_run = uow.agent_runs.get_scout_run(receipt.result_id)
        assert scout_run is not None
        agent_run = uow.agent_runs.get(scout_run.agent_run_id)
        assert agent_run is not None
        assert agent_run.status is AgentRunStatus.SUCCEEDED
        candidates = tuple(uow.agent_runs.list_scout_candidates(scout_run.id))
        assert len(candidates) == 1
        assert candidates[0].job_id == first_case.job_id

    with database.connect() as connection:
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM job_cases").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_authoritative_scout_persists_reported_and_direct_source_aliases(
    tmp_path,
) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    service = RoleLoopService(
        factory,
        SystemClock(),
        UUID4Generator(),
        agent_registry=_DirectSourceAliasRegistry(),
    )
    profile = service.create_profile(_profile_draft())
    aggregator_url = "https://aggregator.example/listings/platform-456"
    company_url = "https://company.example/jobs/platform-456"
    ats_url = "https://ats.example/openings/456"
    search_url = "https://search.example/results/platform-456"

    (first_case,) = await service.discover_jobs(
        profile.id,
        command_id="direct-alias-scout",
    )

    with factory() as uow:
        receipt = uow.commands.get("direct-alias-scout")
        assert receipt is not None
        scout_run = uow.agent_runs.get_scout_run(receipt.result_id)
        assert scout_run is not None
        agent_run = uow.agent_runs.get(scout_run.agent_run_id)
        assert agent_run is not None and agent_run.status is AgentRunStatus.SUCCEEDED
        (candidate,) = uow.agent_runs.list_scout_candidates(scout_run.id)
        job = uow.jobs.get(first_case.job_id)
        assert job is not None and job.canonical_url == company_url
        assert {item.key for item in uow.jobs.list_identity_keys(job.id)} == {
            f"url:{aggregator_url}",
            f"url:{company_url}",
            f"url:{ats_url}",
        }
        assert {
            source.canonical_url
            for source in uow.job_versions.list_sources(candidate.job_version_id)
        } == {aggregator_url, company_url, ats_url, search_url}

    (second_case,) = await service.discover_jobs(
        profile.id,
        command_id="ats-alias-only-scout",
    )

    assert second_case.job_id == first_case.job_id
    with factory() as uow:
        receipt = uow.commands.get("ats-alias-only-scout")
        assert receipt is not None
        scout_run = uow.agent_runs.get_scout_run(receipt.result_id)
        assert scout_run is not None
        agent_run = uow.agent_runs.get(scout_run.agent_run_id)
        assert agent_run is not None and agent_run.status is AgentRunStatus.SUCCEEDED
        (candidate,) = uow.agent_runs.list_scout_candidates(scout_run.id)
        assert candidate.job_id == first_case.job_id

    with database.connect() as connection:
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1


def test_resume_run_roundtrips_exact_render_artifacts(tmp_path) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    service = RoleLoopService(factory, SystemClock(), UUID4Generator())
    profile = service.create_profile(_profile_draft())
    case = service.add_job_url(profile.id, "https://company.example/jobs/req-1")
    now = datetime(2026, 8, 14, tzinfo=UTC)
    source_artifact = _artifact("source", b"source")
    evidence = ResumeEvidenceVersion(
        id="evidence",
        profile_id=profile.id,
        source_kind=EvidenceSourceKind.TEXT_FILE,
        source_name="resume.json",
        source_artifact=source_artifact,
        extracted_text="resume",
        created_at=now,
    )
    review = ReviewVersion(
        id="review",
        job_case_id=case.id,
        fingerprint="review-fingerprint",
        analyzer_version="test",
        match_evidence=(),
        skeptic_findings=(),
        questions=(),
        created_at=now,
    )
    pdf = _artifact("pdf", b"%PDF-test")
    selection = _artifact("selection", b"{}")
    tailored_source = _artifact("tailored-source", b"tar")
    receipt = _artifact("receipt", b"{}")
    review_file = _artifact("review-file", b"review")
    compile_log = _artifact("compile-log", b"ok")
    ats_text = _artifact("ats-text", b"resume")
    run = ResumeRun(
        id="run",
        job_case_id=case.id,
        review_version_id=review.id,
        evidence_version_id=evidence.id,
        input_fingerprint="input",
        stage=ResumeStage.READY,
        generator_version="test",
        validator_version="v1",
        compiler_version="v1",
        artifact=pdf,
        selection_artifact=selection,
        tailored_source_bundle_artifact=tailored_source,
        render_receipt_artifact=receipt,
        review_file_artifact=review_file,
        compile_log_artifact=compile_log,
        ats_text_artifact=ats_text,
        created_at=now,
        updated_at=now,
    )

    with factory() as uow:
        uow.artifacts.add(source_artifact)
        uow.evidence.add(evidence)
        current = uow.profiles.get(profile.id)
        assert current is not None
        assert uow.profiles.update(
            replace(
                current,
                active_evidence_version_id=evidence.id,
                revision=current.revision + 1,
            ),
            expected_revision=current.revision,
        )
        uow.reviews.add(review)
        uow.resume_runs.add(run)
        uow.commit()

    with factory() as uow:
        stored = uow.resume_runs.get(run.id)
        assert stored is not None
        assert stored.selection_artifact == selection
        assert stored.tailored_source_bundle_artifact == tailored_source
        assert stored.render_receipt_artifact == receipt
        for artifact in (
            pdf,
            selection,
            tailored_source,
            receipt,
            review_file,
            compile_log,
            ats_text,
        ):
            assert uow.artifacts.get(artifact.id) == artifact


def test_legacy_import_persists_both_database_manifests_atomically(tmp_path) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    service = RoleLoopService(factory, SystemClock(), UUID4Generator())
    profile = service.create_profile(_profile_draft())
    sources = (
        LegacySourceManifest("state.sqlite3", "1" * 64, 100, 0, 0),
        LegacySourceManifest("state-v2.sqlite3", "2" * 64, 200, 0, 0),
    )
    draft = LegacyImportDraft(
        source_checksum="",
        jobs=(),
        source_job_count=0,
        source_event_count=0,
        sources=sources,
    )

    batch = service.apply_legacy_import(profile.id, draft, command_id="legacy-import")

    assert [item.database_name for item in batch.sources] == [
        "state.sqlite3",
        "state-v2.sqlite3",
    ]
    with factory() as uow:
        stored = uow.legacy_imports.get_by_checksum(profile.id, batch.source_checksum)
        assert stored == batch
        assert tuple(uow.legacy_imports.list_sources(batch.id)) == batch.sources


def test_legacy_import_duplicate_keeps_sqlite_native_projection_and_records_history(
    tmp_path,
) -> None:
    database = SQLiteDatabase(tmp_path / "roleloop.sqlite3")
    factory = SQLiteUnitOfWorkFactory(database)
    service = RoleLoopService(
        factory,
        SystemClock(),
        UUID4Generator(),
        agent_registry=_UnusedAgentRegistry(),
    )
    profile = service.create_profile(_profile_draft())
    case = service.add_job_url(profile.id, "https://company.example/jobs/native-7")
    with factory() as uow:
        initial_job = uow.jobs.get(case.job_id)
        assert initial_job is not None
    native_job = service.update_job_details(
        profile.id,
        case.job_id,
        JobDetails(
            title="Native title",
            company="Native Company",
            description="Native description",
            source="company",
            external_requisition_id="REQ-7",
        ),
        expected_revision=initial_job.revision,
    )
    native_case = service.decide_job(
        profile.id,
        native_job.id,
        Decision.SKIP,
        command_id="native-skip-7",
    )
    with factory() as uow:
        native_version = uow.job_versions.get_current(native_job.id)
        native_versions = tuple(uow.job_versions.list_for_job(native_job.id))
        native_decision = uow.decision_events.get(native_case.current_decision_event_id or "")
        assert native_version is not None
        assert native_decision is not None

    legacy_key = "state-v2.sqlite3:legacy-7"
    occurred_at = datetime(2025, 3, 4, tzinfo=UTC)
    draft = LegacyImportDraft(
        source_checksum="",
        jobs=(
            LegacyJobDraft(
                legacy_key=legacy_key,
                url="https://company.example/jobs/native-7?utm_source=legacy",
                details=JobDetails(
                    title="Legacy title",
                    company="Legacy Company",
                    description="Legacy description",
                    source="legacy:state-v2.sqlite3",
                ),
                decision=Decision.TAILOR,
                event_at=occurred_at,
            ),
        ),
        source_job_count=1,
        source_event_count=1,
        sources=(
            LegacySourceManifest("state.sqlite3", "5" * 64, 100, 0, 0),
            LegacySourceManifest("state-v2.sqlite3", "6" * 64, 200, 1, 1),
        ),
        events=(
            LegacyEventDraft(
                source_key="state-v2.sqlite3:event:7",
                job_key=legacy_key,
                occurred_at=occurred_at,
                node="reviewer",
                event_type="job_assessed",
                detail='{"priority":"high"}',
            ),
        ),
    )

    batch = service.apply_legacy_import(
        profile.id,
        draft,
        command_id="legacy-import-7",
    )

    # Re-open through SQLite repositories so the assertions cover actual projections,
    # append-only events, and importer audit mappings after the transaction committed.
    with factory() as uow:
        assert uow.jobs.get(native_job.id) == native_job
        assert uow.job_versions.get_current(native_job.id) == native_version
        assert tuple(uow.job_versions.list_for_job(native_job.id)) == native_versions
        assert uow.cases.get(native_case.id) == native_case
        assert uow.decision_events.get(native_case.current_decision_event_id or "") == (
            native_decision
        )
        decisions = tuple(uow.decision_events.list_for_case(native_case.id))
        assert len(decisions) == 2
        legacy_decision = next(
            item for item in decisions if item.reason is DecisionReason.LEGACY_UNPINNED
        )
        assert legacy_decision.decision is Decision.TAILOR
        assert legacy_decision.supersedes_decision_event_id is None
        history = tuple(uow.events.list_for_case(native_case.id))
        assert {item.event_type for item in history} >= {
            "legacy.job_snapshot",
            "legacy.job_assessed",
        }
        snapshot = next(item for item in history if item.event_type == "legacy.job_snapshot")
        assert snapshot.metadata["job_projection_applied"] is False
        assert snapshot.metadata["case_projection_applied"] is False
        assert "Legacy title" in snapshot.metadata["snapshot_json"]
        items = tuple(uow.legacy_imports.list_items(batch.id))
        assert sum(item.entity_type == "workflow_event" for item in items) == 2


def test_salary_and_remote_arrangement_rules_roundtrip(tmp_path) -> None:
    factory = SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3"))
    service = RoleLoopService(factory, SystemClock(), UUID4Generator())
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            annual_salary_floor=100_000,
            accepted_remote_arrangements=("remote", "hybrid"),
            accepted_hiring_arrangements=("employee", "eor"),
            agent_provider=AgentProvider.DEMO,
        )
    )

    with factory() as uow:
        version = uow.profile_versions.get_current(profile.id)
        assert version is not None
        rules = tuple(uow.profile_versions.list_rules(version.id))
        assert {rule.kind.value for rule in rules} >= {
            "remote_arrangement",
            "remote_hiring",
            "salary_maximum",
        }


def test_artifact_ids_cannot_be_reused_with_different_metadata(tmp_path) -> None:
    factory = SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3"))
    original = _artifact("shared-artifact", b"first")
    with factory() as uow:
        uow.artifacts.add(original)
        uow.commit()

    collision = replace(
        original,
        checksum=hashlib.sha256(b"second").hexdigest(),
        uri="managed/different-object",
        size_bytes=len(b"second"),
    )
    with factory() as uow, pytest.raises(ValueError, match="reused"):
        uow.artifacts.add(collision)

    with factory() as uow:
        assert uow.artifacts.get(original.id) == original
