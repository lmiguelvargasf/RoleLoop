from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from roleloop.application.dto import (
    ProfileDraft,
    ResumeSelectionContext,
    ReviewerContext,
    ScoutContext,
)
from roleloop.application.errors import ProviderFailureError, ProviderUnavailableError
from roleloop.application.ports import NullProgressReporter
from roleloop.application.services import RoleLoopService
from roleloop.domain import (
    AgentConfiguration,
    AgentKind,
    AgentProvider,
    ArtifactRef,
    EvidenceSourceKind,
    Job,
    JobVersion,
    ResumeEvidenceVersion,
    ReviewVersion,
    ScoutMode,
    SearchProfile,
    SearchProfileVersion,
)
from roleloop.infrastructure.agent_providers import (
    DemoScoutAgent,
    OpenAIResponsesClient,
    OpenAIScoutAgent,
    ProfileAgentProviderRegistry,
    ProviderCallAudit,
    create_agent_provider_bundle,
)
from roleloop.infrastructure.database import SQLiteDatabase
from roleloop.infrastructure.runtime import (
    OPENAI_MODEL,
    ProviderRuntimeConfig,
    RuntimeSettings,
    SystemClock,
    UUID4Generator,
)
from roleloop.infrastructure.uow import SQLiteUnitOfWorkFactory

JOB_URL = "https://jobs.example.com/applied-ai"
BULLET_ID = "example.claim.1234567890abcdef"


def _catalog() -> str:
    return json.dumps(
        {
            "schema": "roleloop.evidence-catalog.v1",
            "contract_version": 1,
            "source_revision": "a" * 40,
            "resume_id": "fixture",
            "summary": {
                "id": "summary.current",
                "text": "Applied AI engineer",
                "source_path": "sections/summary.tex",
                "source_sha256": "b" * 64,
            },
            "active_experiences": [
                {
                    "id": "example",
                    "source_path": "sections/example.tex",
                    "source_sha256": "b" * 64,
                    "bullets": [
                        {
                            "id": BULLET_ID,
                            "experience_id": "example",
                            "project_id": None,
                            "text": "Built production Python retrieval systems",
                            "source_path": "sections/example.tex",
                            "source_sha256": "b" * 64,
                        }
                    ],
                }
            ],
            "allowed_skills": [
                {
                    "id": "skill.python",
                    "text": "Python",
                    "group_id": "languages",
                    "group_name": "Languages",
                }
            ],
            "active_experience_order": ["example"],
            "renderer_version": "1.0.0",
            "tracked_manifest": {"main.tex": "b" * 64},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _profile_version(
    provider: AgentProvider = AgentProvider.DEMO,
    *,
    configurations: tuple[AgentConfiguration, ...] = (),
) -> SearchProfileVersion:
    return SearchProfileVersion(
        id=f"profile-version-{provider.value}",
        profile_id="profile",
        version_number=1,
        name="Applied AI",
        target_roles=("Applied AI Engineer",),
        agent_provider=provider,
        agent_configurations=configurations,
    )


def _profile() -> SearchProfile:
    return SearchProfile(
        id="profile",
        name="Applied AI",
        target_roles=("Applied AI Engineer",),
    )


def _job() -> Job:
    return Job(
        id="job",
        canonical_url=JOB_URL,
        title="Applied AI Engineer",
        company="Example",
        description="Build production Python retrieval systems",
    )


def _job_version() -> JobVersion:
    return JobVersion(
        id="job-version",
        job_id="job",
        version_number=1,
        content_fingerprint="fingerprint",
        canonical_url=JOB_URL,
        title="Applied AI Engineer",
        company="Example",
        location="Remote",
        description="Build production Python retrieval systems",
        source="fixture",
    )


def _evidence() -> ResumeEvidenceVersion:
    text = _catalog()
    artifact = ArtifactRef(
        id="evidence-artifact",
        checksum="c" * 64,
        uri="evidence.json",
        media_type="application/json",
        size_bytes=len(text.encode()),
    )
    return ResumeEvidenceVersion(
        id="evidence",
        profile_id="profile",
        source_kind=EvidenceSourceKind.TEXT_FILE,
        source_name="evidence-catalog.json",
        source_artifact=artifact,
        extracted_text=text,
        created_at=datetime.now(UTC),
    )


def _review() -> ReviewVersion:
    return ReviewVersion(
        id="review",
        job_case_id="case",
        fingerprint="fingerprint",
        analyzer_version="reviewer-v1",
        match_evidence=(),
        skeptic_findings=(),
        questions=(),
        created_at=datetime.now(UTC),
    )


def _scout_output() -> dict[str, object]:
    return {
        "candidates": [
            {
                "url": JOB_URL,
                "title": "Applied AI Engineer",
                "company": "Example",
                "location": "Remote",
                "description": "Build production Python retrieval systems",
                "source": "company",
                "employment_type": "full-time",
                "seniority": "senior",
                "salary_min": None,
                "salary_max": None,
                "salary_currency": None,
                "external_requisition_id": None,
                "listing_closed": False,
                "hq_country": None,
                "startup": None,
                "work_authorization_required": None,
                "us_only": None,
                "remote_from_ecuador": None,
                "remote_arrangement": None,
                "hiring_arrangement": None,
                "sources": [
                    {
                        "url": JOB_URL,
                        "source_kind": "company",
                        "title": "Careers",
                        "publisher": "Example",
                        "quoted_evidence": "Applied AI Engineer",
                    }
                ],
            }
        ]
    }


def _reviewer_output(anchor: str = BULLET_ID) -> dict[str, object]:
    return {
        "match_evidence": [
            {"summary": "Python", "detail": "Direct evidence", "source_anchor": anchor}
        ],
        "skeptic_findings": [
            {
                "summary": "Verify scope",
                "detail": "Unknown",
                "source_anchor": "job_version:job-version",
            }
        ],
        "questions": [],
        "recommended_decision": "tailor",
        "requirements": [
            {
                "key": "python",
                "text": "Python",
                "evidence": "Direct",
                "required": True,
                "source_anchor": anchor,
            }
        ],
        "confidence": 0.8,
        "positioning": "Applied AI engineer",
        "self_critique": "Verify organizational scope",
    }


def _resume_output(anchor: str = BULLET_ID) -> dict[str, object]:
    return {
        "headline": "Applied AI Engineer",
        "experiences": [{"experience_id": "example", "bullet_ids": [anchor]}],
        "skill_ids": ["skill.python"],
    }


class _FakeResponses:
    def __init__(self, results: list[object]) -> None:
        self.results = list(results)
        self.calls: list[dict[str, object]] = []
        self.responses = self

    async def create(self, **arguments: object) -> object:
        self.calls.append(arguments)
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


def _response(output: dict[str, object], *, sources: bool = False) -> dict[str, object]:
    response: dict[str, object] = {
        "id": "resp_fixture",
        "model": "gpt-5.6-terra",
        "output_text": json.dumps(output),
        "usage": {"input_tokens": 101, "output_tokens": 29, "total_tokens": 130},
    }
    if sources:
        response["output"] = [
            {
                "type": "web_search_call",
                "action": {"sources": [{"url": JOB_URL}]},
            }
        ]
    return response


@pytest.mark.asyncio
async def test_demo_agents_are_deterministic_and_use_catalog_ids() -> None:
    bundle = create_agent_provider_bundle(AgentProvider.DEMO)
    scout_context = ScoutContext(
        profile=_profile(),
        profile_version=_profile_version(),
        mode=ScoutMode.SEARCH,
        requested_url=None,
        limit=10,
    )
    first = await bundle.scout.discover(scout_context, progress=NullProgressReporter())
    second = await bundle.scout.discover(scout_context, progress=NullProgressReporter())
    assert first == second
    assert bundle.scout.descriptor.model == OPENAI_MODEL
    assert first.audit.response_model == "deterministic-demo-v1"
    assert first.audit.prompt_hash == bundle.scout.descriptor.prompt_hash
    assert first.audit.output_schema_hash == bundle.scout.descriptor.output_schema_hash

    selection = await bundle.resume.select(
        ResumeSelectionContext(
            profile=_profile(),
            profile_version=_profile_version(),
            evidence=_evidence(),
            job=_job(),
            job_version=_job_version(),
            review=_review(),
            answers={},
        ),
        progress=NullProgressReporter(),
    )
    assert selection.experiences[0].bullet_ids == (BULLET_ID,)
    assert selection.skill_ids == ("skill.python",)
    assert selection.audit.prompt_hash == bundle.resume.descriptor.prompt_hash


@pytest.mark.asyncio
async def test_service_accepts_demo_descriptor_for_pinned_profile(tmp_path: Path) -> None:
    service = RoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(tmp_path / "roleloop.sqlite3")),
        SystemClock(),
        UUID4Generator(),
        agent_registry=ProfileAgentProviderRegistry(RuntimeSettings()),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Offline demo",
            target_roles=("Applied AI Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )

    cases = await service.discover_jobs(profile.id, limit=1)

    assert len(cases) == 1
    assert cases[0].profile_id == profile.id


@pytest.mark.asyncio
async def test_openai_scout_uses_strict_responses_and_web_search_with_audit() -> None:
    fake = _FakeResponses([_response(_scout_output(), sources=True)])
    bundle = create_agent_provider_bundle(AgentProvider.OPENAI, client=fake)

    report = await bundle.scout.discover(
        ScoutContext(
            profile=_profile(),
            profile_version=_profile_version(AgentProvider.OPENAI),
            mode=ScoutMode.SEARCH,
            requested_url=None,
            limit=5,
        ),
        progress=NullProgressReporter(),
    )

    call = fake.calls[0]
    assert call["model"] == "gpt-5.6-terra"
    assert call["reasoning"] == {"effort": "medium"}
    assert call["store"] is False
    assert call["tools"] == [{"type": "web_search"}]
    assert call["include"] == ["web_search_call.action.sources"]
    text = call["text"]
    assert isinstance(text, dict)
    output_format = text["format"]
    assert isinstance(output_format, dict)
    assert output_format["strict"] is True
    assert output_format["schema"]["additionalProperties"] is False  # type: ignore[index]
    assert report.audit.provider_response_id == "resp_fixture"
    assert report.audit.total_tokens == 130
    assert report.audit.source_urls == (JOB_URL,)
    assert report.audit.prompt_hash == bundle.scout.descriptor.prompt_hash
    assert report.audit.output_schema_hash == bundle.scout.descriptor.output_schema_hash
    assert report.candidates[0].url == JOB_URL


@pytest.mark.asyncio
async def test_openai_scout_preserves_reported_url_and_direct_sources() -> None:
    output = _scout_output()
    candidates = output["candidates"]
    assert isinstance(candidates, list)
    candidate = candidates[0]
    assert isinstance(candidate, dict)
    ats_url = "https://jobs.ashbyhq.com/example/role"
    candidate["url"] = "https://aggregator.example/jobs/123"
    candidate["sources"] = [
        {
            "url": ats_url,
            "source_kind": "ats",
            "title": "ATS role",
            "publisher": "Ashby",
            "quoted_evidence": "Applied AI Engineer",
        },
        {
            "url": JOB_URL,
            "source_kind": "company",
            "title": "Company role",
            "publisher": "Example",
            "quoted_evidence": "Applied AI Engineer",
        },
    ]
    response = _response(output, sources=True)
    response["output"] = [
        {
            "type": "web_search_call",
            "action": {
                "sources": [
                    {"url": "https://aggregator.example/jobs/123"},
                    {"url": ats_url},
                    {"url": JOB_URL},
                ]
            },
        }
    ]
    fake = _FakeResponses([response])
    bundle = create_agent_provider_bundle(AgentProvider.OPENAI, client=fake)

    report = await bundle.scout.discover(
        ScoutContext(
            profile=_profile(),
            profile_version=_profile_version(AgentProvider.OPENAI),
            mode=ScoutMode.SEARCH,
            requested_url=None,
            limit=1,
        ),
        progress=NullProgressReporter(),
    )

    assert report.candidates[0].url == "https://aggregator.example/jobs/123"
    assert {source.url for source in report.candidates[0].sources} == {
        "https://aggregator.example/jobs/123",
        ats_url,
        JOB_URL,
    }


@pytest.mark.asyncio
async def test_openai_scout_does_not_copy_other_results_sources_onto_candidate() -> None:
    output = _scout_output()
    unrelated_url = "https://company-two.example/jobs/unrelated"
    response = _response(output, sources=True)
    response["output"] = [
        {
            "type": "web_search_call",
            "action": {"sources": [{"url": JOB_URL}, {"url": unrelated_url}]},
        }
    ]
    fake = _FakeResponses([response])
    bundle = create_agent_provider_bundle(AgentProvider.OPENAI, client=fake)

    report = await bundle.scout.discover(
        ScoutContext(
            profile=_profile(),
            profile_version=_profile_version(AgentProvider.OPENAI),
            mode=ScoutMode.SEARCH,
            requested_url=None,
            limit=1,
        ),
        progress=NullProgressReporter(),
    )

    assert report.audit.source_urls == (JOB_URL, unrelated_url)
    assert {source.url for source in report.candidates[0].sources} == {JOB_URL}


@pytest.mark.asyncio
async def test_reviewer_and_resume_never_receive_web_search_and_validate_exact_ids() -> None:
    fake = _FakeResponses([_response(_reviewer_output()), _response(_resume_output())])
    bundle = create_agent_provider_bundle(AgentProvider.OPENAI, client=fake)
    profile_version = _profile_version(AgentProvider.OPENAI)
    review = await bundle.reviewer.analyze(
        ReviewerContext(
            profile=_profile(),
            profile_version=profile_version,
            hard_blockers=(),
            evidence=_evidence(),
            job=_job(),
            job_version=_job_version(),
            sources=(),
            latest_answers={},
            screen_evaluations=(),
        ),
        progress=NullProgressReporter(),
    )
    selection = await bundle.resume.select(
        ResumeSelectionContext(
            profile=_profile(),
            profile_version=profile_version,
            evidence=_evidence(),
            job=_job(),
            job_version=_job_version(),
            review=_review(),
            answers={},
        ),
        progress=NullProgressReporter(),
    )

    assert all("tools" not in call and "include" not in call for call in fake.calls)
    assert review.match_evidence[0].source_anchor == BULLET_ID
    assert selection.experiences[0].bullet_ids == (BULLET_ID,)
    assert review.audit.prompt_hash == bundle.reviewer.descriptor.prompt_hash
    assert selection.audit.output_schema_hash == bundle.resume.descriptor.output_schema_hash

    bad_fake = _FakeResponses([_response(_resume_output("invented.claim"))])
    bad_bundle = create_agent_provider_bundle(AgentProvider.OPENAI, client=bad_fake)
    with pytest.raises(ProviderFailureError, match="unknown or inactive"):
        await bad_bundle.resume.select(
            ResumeSelectionContext(
                profile=_profile(),
                profile_version=profile_version,
                evidence=_evidence(),
                job=_job(),
                job_version=_job_version(),
                review=_review(),
                answers={},
            ),
            progress=NullProgressReporter(),
        )


def test_demo_registry_honors_each_pinned_profile_model() -> None:
    configurations = tuple(
        AgentConfiguration(
            kind,
            AgentProvider.DEMO,
            f"demo-{kind.value}-model",
            "medium",
        )
        for kind in AgentKind
    )
    profile_version = _profile_version(
        AgentProvider.DEMO,
        configurations=configurations,
    )
    registry = ProfileAgentProviderRegistry(RuntimeSettings())

    assert registry.scout(profile_version).descriptor.model == "demo-scout-model"
    assert registry.reviewer(profile_version).descriptor.model == "demo-reviewer-model"
    assert registry.resume(profile_version).descriptor.model == "demo-resume-model"


class _RateLimitError(Exception):
    status_code = 429


class _AuditSink:
    def __init__(self) -> None:
        self.records: list[ProviderCallAudit] = []

    def record(self, audit: ProviderCallAudit) -> None:
        self.records.append(audit)


@pytest.mark.asyncio
async def test_openai_retry_is_bounded_and_failure_is_sanitized() -> None:
    delays: list[float] = []

    async def sleeper(delay: float) -> None:
        delays.append(delay)

    sink = _AuditSink()
    fake = _FakeResponses(
        [
            _RateLimitError("secret=https://user:password@example.com"),
            _response(_scout_output(), sources=True),
        ]
    )
    runtime = ProviderRuntimeConfig(max_attempts=2)
    client = OpenAIResponsesClient(
        runtime,
        client=fake,
        audit_sink=sink,
        sleeper=sleeper,
    )
    scout = OpenAIScoutAgent(client, runtime.scout)

    await scout.discover(
        ScoutContext(
            profile=_profile(),
            profile_version=_profile_version(AgentProvider.OPENAI),
            mode=ScoutMode.SEARCH,
            requested_url=None,
            limit=1,
        ),
        progress=NullProgressReporter(),
    )
    assert len(fake.calls) == 2
    assert delays == [0.25]
    assert sink.records[-1].attempts == 2
    assert sink.records[-1].succeeded

    failing_sink = _AuditSink()
    failing = _FakeResponses(
        [
            _RateLimitError("secret=https://user:password@example.com"),
            _RateLimitError("secret=https://user:password@example.com"),
        ]
    )
    failing_client = OpenAIResponsesClient(
        runtime,
        client=failing,
        audit_sink=failing_sink,
        sleeper=sleeper,
    )
    with pytest.raises(ProviderFailureError) as raised:
        await OpenAIScoutAgent(failing_client, runtime.scout).discover(
            ScoutContext(
                profile=_profile(),
                profile_version=_profile_version(AgentProvider.OPENAI),
                mode=ScoutMode.SEARCH,
                requested_url=None,
                limit=1,
            ),
            progress=NullProgressReporter(),
        )
    assert "password" not in str(raised.value)
    assert "password" not in repr(raised.value.details)
    assert failing_sink.records[-1].error_code == "_RateLimitError"
    assert len(failing.calls) == 2


@pytest.mark.asyncio
async def test_production_openai_policy_stops_after_exactly_two_retries() -> None:
    delays: list[float] = []

    async def sleeper(delay: float) -> None:
        delays.append(delay)

    runtime = RuntimeSettings.from_environment({"ROLELOOP_OPENAI_MAX_ATTEMPTS": "5"}).provider
    fake = _FakeResponses([_RateLimitError("temporary") for _ in range(4)])
    client = OpenAIResponsesClient(runtime, client=fake, sleeper=sleeper)

    with pytest.raises(ProviderFailureError):
        await OpenAIScoutAgent(client, runtime.scout).discover(
            ScoutContext(
                profile=_profile(),
                profile_version=_profile_version(AgentProvider.OPENAI),
                mode=ScoutMode.SEARCH,
                requested_url=None,
                limit=1,
            ),
            progress=NullProgressReporter(),
        )

    assert runtime.max_attempts == 3
    assert len(fake.calls) == 3
    assert delays == [0.25, 0.5]


@pytest.mark.asyncio
async def test_registry_is_profile_dynamic_and_openai_key_is_lazy() -> None:
    settings = RuntimeSettings.from_environment({})
    registry = ProfileAgentProviderRegistry(settings, environment={})
    assert isinstance(registry.scout(_profile_version()), DemoScoutAgent)
    openai_scout = registry.scout(_profile_version(AgentProvider.OPENAI))
    assert isinstance(openai_scout, OpenAIScoutAgent)

    with pytest.raises(ProviderUnavailableError, match="OPENAI_API_KEY"):
        await openai_scout.discover(
            ScoutContext(
                profile=_profile(),
                profile_version=_profile_version(AgentProvider.OPENAI),
                mode=ScoutMode.SEARCH,
                requested_url=None,
                limit=1,
            ),
            progress=NullProgressReporter(),
        )

    configured = _profile_version(
        AgentProvider.OPENAI,
        configurations=(
            AgentConfiguration(
                kind=AgentKind.SCOUT,
                provider=AgentProvider.OPENAI,
                model="gpt-5.6-terra",
                reasoning_effort="high",
            ),
        ),
    )
    fake = _FakeResponses([_response(_scout_output(), sources=True)])
    configured_registry = ProfileAgentProviderRegistry(
        settings,
        environment={},
        openai_client=fake,
    )
    await configured_registry.scout(configured).discover(
        ScoutContext(
            profile=_profile(),
            profile_version=configured,
            mode=ScoutMode.SEARCH,
            requested_url=None,
            limit=1,
        ),
        progress=NullProgressReporter(),
    )
    assert fake.calls[0]["reasoning"] == {"effort": "high"}
