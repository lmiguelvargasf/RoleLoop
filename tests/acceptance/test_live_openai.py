from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime

import pytest

from roleloop.application.dto import (
    ResumeSelectionContext,
    ReviewerContext,
    ScoutContext,
)
from roleloop.application.ports import NullProgressReporter
from roleloop.domain import (
    AgentConfiguration,
    AgentKind,
    AgentProvider,
    ArtifactRef,
    EvidenceSourceKind,
    Job,
    JobVersion,
    RemotePreference,
    ResumeEvidenceVersion,
    ReviewVersion,
    ScoutMode,
    SearchProfile,
    SearchProfileVersion,
    WebSourceSnapshot,
)
from roleloop.infrastructure.agent_providers import (
    ProviderCallAudit,
    create_agent_provider_bundle,
)
from roleloop.infrastructure.runtime import AgentRuntimeConfig, ProviderRuntimeConfig

LIVE_ENABLED = os.environ.get("ROLELOOP_RUN_LIVE_OPENAI") == "1" and bool(
    os.environ.get("OPENAI_API_KEY", "").strip()
)


class _AuditSink:
    def __init__(self) -> None:
        self.calls: list[ProviderCallAudit] = []

    def record(self, audit: ProviderCallAudit) -> None:
        self.calls.append(audit)


def _catalog(revision: str) -> bytes:
    digest = hashlib.sha256(b"synthetic live smoke evidence").hexdigest()
    value = {
        "active_experience_order": ["example_labs"],
        "active_experiences": [
            {
                "bullets": [
                    {
                        "experience_id": "example_labs",
                        "id": "example_labs.claim.reliable_agents",
                        "project_id": None,
                        "source_path": "sections/example_labs.tex",
                        "source_sha256": digest,
                        "text": "Built reliable Python agent systems with measured evaluations.",
                    }
                ],
                "id": "example_labs",
                "source_path": "sections/example_labs.tex",
                "source_sha256": digest,
            }
        ],
        "allowed_skills": [
            {
                "group_id": "skill_group.languages",
                "group_name": "Languages",
                "id": "skill.python",
                "text": "Python",
            }
        ],
        "contract_version": 1,
        "renderer_version": "live-smoke-fixture-v1",
        "resume_id": "resume.synthetic-live-smoke",
        "schema": "roleloop.evidence-catalog.v1",
        "source_revision": revision,
        "summary": {
            "id": "summary.current",
            "source_path": "sections/summary.tex",
            "source_sha256": digest,
            "text": "Applied AI engineer focused on reliable production systems.",
        },
        "tracked_manifest": {"main.tex": digest},
    }
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")


@pytest.mark.live_openai
@pytest.mark.skipif(
    not LIVE_ENABLED,
    reason="set ROLELOOP_RUN_LIVE_OPENAI=1 and OPENAI_API_KEY to run three live calls",
)
async def test_live_openai_makes_exactly_one_request_per_agent() -> None:
    configurations = tuple(
        AgentConfiguration(kind, AgentProvider.OPENAI, "gpt-5.6-terra", "medium")
        for kind in AgentKind
    )
    runtime = ProviderRuntimeConfig(
        scout=AgentRuntimeConfig(AgentKind.SCOUT, "gpt-5.6-terra", "medium"),
        reviewer=AgentRuntimeConfig(AgentKind.REVIEWER, "gpt-5.6-terra", "medium"),
        resume=AgentRuntimeConfig(AgentKind.RESUME, "gpt-5.6-terra", "medium"),
        max_attempts=1,
    )
    audits = _AuditSink()
    bundle = create_agent_provider_bundle(
        AgentProvider.OPENAI,
        config=runtime,
        environment=os.environ,
        audit_sink=audits,
    )
    profile = SearchProfile(
        id="profile-live-smoke",
        name="Synthetic live smoke",
        target_roles=("Applied AI Engineer",),
        remote_preference=RemotePreference.REMOTE,
        search_queries=("applied AI engineer remote startup",),
        agent_configurations=configurations,
        is_active=True,
    )
    profile_version = SearchProfileVersion(
        id="profile-version-live-smoke",
        profile_id=profile.id,
        version_number=1,
        name=profile.name,
        target_roles=profile.target_roles,
        remote_preference=profile.remote_preference,
        search_queries=profile.search_queries,
        agent_provider=AgentProvider.OPENAI,
        agent_configurations=configurations,
    )
    progress = NullProgressReporter()

    scout = await bundle.scout.discover(
        ScoutContext(profile, profile_version, ScoutMode.SEARCH, None, 1),
        progress=progress,
    )
    assert scout.candidates
    candidate = scout.candidates[0]
    now = datetime.now(UTC)
    job = Job(
        id="job-live-smoke",
        canonical_url=candidate.url,
        title=candidate.details.title,
        company=candidate.details.company,
        location=candidate.details.location,
        description=candidate.details.description,
        source=candidate.details.source,
    )
    job_version = JobVersion(
        id="job-version-live-smoke",
        job_id=job.id,
        version_number=1,
        content_fingerprint="synthetic-live-smoke",
        canonical_url=job.canonical_url,
        title=job.title,
        company=job.company,
        location=job.location,
        description=job.description,
        source=job.source,
    )
    sources = tuple(
        WebSourceSnapshot(
            id=f"source-{position}",
            canonical_url=source.url,
            source_kind=source.source_kind,
            title=source.title,
            publisher=source.publisher,
            retrieved_at=now,
            content_checksum=hashlib.sha256(source.url.encode("utf-8")).hexdigest(),
            quoted_evidence=source.quoted_evidence,
        )
        for position, source in enumerate(candidate.sources)
    )
    revision = "a" * 40
    catalog = _catalog(revision)
    artifact = ArtifactRef(
        id="evidence-artifact-live-smoke",
        checksum=hashlib.sha256(catalog).hexdigest(),
        uri="managed/synthetic-live-smoke.json",
        media_type="application/json",
        size_bytes=len(catalog),
    )
    evidence = ResumeEvidenceVersion(
        id="evidence-live-smoke",
        profile_id=profile.id,
        source_kind=EvidenceSourceKind.TEXT_FILE,
        source_name="evidence-catalog.json",
        source_artifact=artifact,
        extracted_text=catalog.decode("utf-8"),
        created_at=now,
        source_revision=revision,
        canonical_evidence_artifact=artifact,
        renderer_version="live-smoke-fixture-v1",
    )
    reviewer = await bundle.reviewer.analyze(
        ReviewerContext(
            profile=profile,
            profile_version=profile_version,
            hard_blockers=(),
            evidence=evidence,
            job=job,
            job_version=job_version,
            sources=sources,
            latest_answers={},
            screen_evaluations=(),
        ),
        progress=progress,
    )
    review = ReviewVersion(
        id="review-live-smoke",
        job_case_id="case-live-smoke",
        fingerprint="synthetic-live-smoke",
        analyzer_version="gpt-5.6-terra",
        match_evidence=reviewer.match_evidence,
        skeptic_findings=reviewer.skeptic_findings,
        questions=(),
        created_at=now,
        requirements=reviewer.requirements,
        confidence=reviewer.confidence,
        positioning=reviewer.positioning,
        self_critique=reviewer.self_critique,
    )
    selection = await bundle.resume.select(
        ResumeSelectionContext(
            profile=profile,
            profile_version=profile_version,
            evidence=evidence,
            job=job,
            job_version=job_version,
            review=review,
            answers={},
        ),
        progress=progress,
    )
    assert selection.experiences
    assert [audit.agent_kind for audit in audits.calls] == [
        AgentKind.SCOUT,
        AgentKind.REVIEWER,
        AgentKind.RESUME,
    ]
    assert all(audit.attempts == 1 and audit.succeeded for audit in audits.calls)
