from __future__ import annotations

import hashlib
from dataclasses import dataclass

import pytest

from roleloop.application import (
    AnalysisQuestion,
    ArtifactError,
    CompiledDocument,
    EvidenceImport,
    ExtractedEvidence,
    InvalidTransitionError,
    JobDetails,
    ProfileDraft,
    ProgressUpdate,
    ProviderFailureError,
    ProviderUnavailableError,
    ResumeDraft,
    ReviewAnalysis,
    RevisionConflictError,
    RoleLoopService,
    ValidationError,
)
from roleloop.domain import (
    AgentProvider,
    Answer,
    ApplicationStatus,
    ArtifactRef,
    Decision,
    EligibilityStatus,
    EvidenceSourceKind,
    Finding,
    Outcome,
    QuestionCategory,
    ResumeRun,
    ResumeStage,
    ResumeStatus,
    ReviewStatus,
    ValidationFinding,
    ValidationSeverity,
)

from .fakes import AdvancingClock, MemoryUnitOfWorkFactory, SequentialIds


def profile_draft(name: str = "Primary") -> ProfileDraft:
    return ProfileDraft(
        name=name,
        target_roles=("Staff Python Engineer",),
        agent_provider=AgentProvider.DEMO,
    )


def service_with(**providers: object) -> tuple[RoleLoopService, MemoryUnitOfWorkFactory]:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        **providers,
    )
    return service, factory


class Analyzer:
    version = "analyzer-v1"

    def __init__(self) -> None:
        self.calls = 0

    async def analyze(self, context, *, progress) -> ReviewAnalysis:
        del context, progress
        self.calls += 1
        return ReviewAnalysis(
            match_evidence=(Finding("Python experience", source_anchor="resume:skills"),),
            skeptic_findings=(Finding("Location unclear", source_anchor="job:location"),),
            questions=(
                AnalysisQuestion(
                    key="authorized",
                    prompt="Are you authorized to work here?",
                    category=QuestionCategory.ELIGIBILITY,
                    required=True,
                    qualifying_answer=Answer.YES,
                ),
            ),
        )


class Extractor:
    async def extract(self, request: EvidenceImport) -> ExtractedEvidence:
        assert request.text is not None
        return ExtractedEvidence(
            source_kind=request.source_kind,
            source_name=request.source_name or "resume.txt",
            source_bytes=request.text.encode(),
            extracted_text=request.text,
            media_type="text/plain",
            extension=".txt",
        )


class Store:
    async def put_bytes(self, data: bytes, *, media_type: str, extension: str) -> ArtifactRef:
        checksum = hashlib.sha256(data).hexdigest()
        return ArtifactRef(
            id=checksum,
            checksum=checksum,
            uri=f"managed://{checksum}{extension}",
            media_type=media_type,
            size_bytes=len(data),
        )


class Generator:
    version = "generator-v1"

    async def generate(self, context, *, progress) -> ResumeDraft:
        del context, progress
        return ResumeDraft(content={"summary": "Evidence-backed Python engineer"})


class Validator:
    version = "validator-v1"

    def __init__(self, findings: tuple[ValidationFinding, ...] = ()) -> None:
        self.findings = findings

    async def validate(self, context, draft, *, progress):
        del context, draft, progress
        return self.findings


class Compiler:
    version = "compiler-v1"

    async def compile(self, context, draft, *, progress) -> CompiledDocument:
        del context, draft, progress
        return CompiledDocument(b"%PDF-deterministic")


class InvalidCompiler:
    version = "compiler-invalid"

    async def compile(self, context, draft, *, progress) -> CompiledDocument:
        del context, draft, progress
        return CompiledDocument(b"not a PDF", media_type="text/plain")


@dataclass
class Progress:
    updates: list[ProgressUpdate]

    def report(self, update: ProgressUpdate) -> None:
        self.updates.append(update)


def test_profile_validation_activation_and_optimistic_revision() -> None:
    service, _ = service_with()
    with pytest.raises(ValidationError, match="target role"):
        service.create_profile(ProfileDraft(name="No target", agent_provider=AgentProvider.DEMO))

    first = service.create_profile(profile_draft())
    second = service.create_profile(profile_draft("Alternate"))
    assert first.is_active is True
    assert second.is_active is False
    assert service.activate_profile(second.id).is_active is True
    assert service.get_active_profile_summary().profile.id == second.id  # type: ignore[union-attr]

    with pytest.raises(RevisionConflictError):
        service.update_profile(first.id, profile_draft("Changed"), expected_revision=99)


def test_global_job_is_reused_but_each_profile_has_an_independent_case() -> None:
    service, factory = service_with()
    first = service.create_profile(profile_draft())
    second = service.create_profile(profile_draft("Second"))

    first_case = service.add_job_url(first.id, "https://Example.com/jobs/42?utm_source=mail")
    duplicate = service.add_job_url(first.id, "https://example.com/jobs/42")
    second_case = service.add_job_url(second.id, "https://example.com/jobs/42#apply")

    assert duplicate.id == first_case.id
    assert second_case.id != first_case.id
    assert second_case.job_id == first_case.job_id
    assert len(factory.state.jobs) == 1
    assert len(factory.state.cases) == 2


async def test_review_is_provider_safe_current_and_stale_when_job_changes() -> None:
    analyzer = Analyzer()
    service, factory = service_with(analyzer=analyzer)
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")

    first = await service.review_job(profile.id, case.job_id)
    second = await service.review_job(profile.id, case.job_id)
    assert first.review_status is ReviewStatus.CURRENT
    assert second.review.id == first.review.id  # type: ignore[union-attr]
    assert analyzer.calls == 1
    assert len(factory.state.reviews) == 1

    job = factory.state.jobs[case.job_id]
    service.update_job_details(
        profile.id,
        job.id,
        JobDetails(title="Staff Engineer", description="New revision"),
        expected_revision=job.revision,
    )
    assert service.get_job_case(profile.id, job.id).review_status is ReviewStatus.STALE
    await service.review_job(profile.id, job.id)
    assert analyzer.calls == 2


async def test_normalized_job_detail_noop_keeps_revision_and_review_current() -> None:
    analyzer = Analyzer()
    service, factory = service_with(analyzer=analyzer)
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")
    original = factory.state.jobs[case.job_id]
    details = JobDetails(
        title="Staff Engineer",
        company="Casework",
        location="Remote",
        description="Build evidence systems.",
    )
    updated = service.update_job_details(
        profile.id,
        case.job_id,
        details,
        expected_revision=original.revision,
    )
    reviewed = await service.review_job(profile.id, case.job_id)

    unchanged = service.update_job_details(
        profile.id,
        case.job_id,
        JobDetails(
            title="  Staff Engineer  ",
            company=" Casework ",
            location="Remote ",
            description=" Build evidence systems. ",
        ),
        expected_revision=updated.revision,
    )

    assert unchanged.revision == updated.revision
    assert unchanged.updated_at == updated.updated_at
    assert service.get_job_case(profile.id, case.job_id).review_status is ReviewStatus.CURRENT
    repeated = await service.review_job(profile.id, case.job_id)
    assert repeated.review == reviewed.review
    assert analyzer.calls == 1


async def test_unavailable_review_does_not_create_partial_state() -> None:
    service, factory = service_with()
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")

    with pytest.raises(ProviderUnavailableError):
        await service.review_job(profile.id, case.job_id)
    assert factory.state.reviews == {}


async def test_malformed_analyzer_output_does_not_persist_a_review() -> None:
    class MalformedAnalyzer:
        version = "malformed-v1"

        async def analyze(self, context, *, progress) -> ReviewAnalysis:
            del context, progress
            return ReviewAnalysis(
                match_evidence=(Finding("Unsupported source anchor"),),
                skeptic_findings=(),
                questions=(),
            )

    service, factory = service_with(analyzer=MalformedAnalyzer())
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")

    with pytest.raises(ProviderFailureError, match="source anchor"):
        await service.review_job(profile.id, case.job_id)
    assert factory.state.reviews == {}


async def test_questions_drive_eligibility_and_answers_are_review_scoped() -> None:
    analyzer = Analyzer()
    service, _ = service_with(analyzer=analyzer)
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")
    view = await service.review_job(profile.id, case.job_id)
    assert view.eligibility_status is EligibilityStatus.UNRESOLVED

    view = service.answer_verification(profile.id, case.job_id, "authorized", Answer.NO)
    assert view.eligibility_status is EligibilityStatus.INELIGIBLE
    view = service.answer_verification(profile.id, case.job_id, "authorized", Answer.YES)
    assert view.eligibility_status is EligibilityStatus.ELIGIBLE


def test_decisions_submission_and_outcomes_are_audited_and_idempotent() -> None:
    service, factory = service_with()
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")

    watched = service.decide_job(profile.id, case.job_id, Decision.WATCH)
    submitted = service.mark_applied(profile.id, case.job_id)
    repeated = service.mark_applied(profile.id, case.job_id)
    assert watched.decision is Decision.WATCH
    assert submitted.application_status is ApplicationStatus.SUBMITTED
    assert repeated.revision == submitted.revision
    assert len(factory.state.submissions) == 1

    with pytest.raises(InvalidTransitionError):
        service.decide_job(profile.id, case.job_id, Decision.SKIP)
    offered = service.record_outcome(profile.id, case.job_id, Outcome.OFFER)
    again = service.record_outcome(profile.id, case.job_id, Outcome.OFFER)
    assert offered.current_outcome is Outcome.OFFER
    assert again.revision == offered.revision
    assert len(factory.state.outcomes) == 1


async def prepared_tailoring_service(
    *, validator: Validator | None = None, compiler: object | None = None
) -> tuple[RoleLoopService, MemoryUnitOfWorkFactory, str, str]:
    analyzer = Analyzer()
    service, factory = service_with(
        analyzer=analyzer,
        generator=Generator(),
        validator=validator or Validator(),
        compiler=compiler or Compiler(),
        evidence_extractor=Extractor(),
        artifact_store=Store(),
    )
    profile = service.create_profile(profile_draft())
    await service.import_evidence(
        profile.id,
        EvidenceImport(
            source_kind=EvidenceSourceKind.PASTED_TEXT,
            text="Ten years building Python services.",
        ),
    )
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")
    await service.review_job(profile.id, case.job_id)
    service.answer_verification(profile.id, case.job_id, "authorized", Answer.YES)
    service.decide_job(profile.id, case.job_id, Decision.TAILOR)
    return service, factory, profile.id, case.job_id


async def test_resume_generation_progress_validation_artifact_and_submission_snapshot() -> None:
    service, factory, profile_id, job_id = await prepared_tailoring_service()
    progress = Progress([])

    run = await service.generate_resume(profile_id, job_id, progress=progress)
    assert run.stage is ResumeStage.READY
    assert run.artifact is not None
    assert [update.stage for update in progress.updates] == [
        "drafting",
        "validating",
        "compiling",
        "ready",
    ]
    assert service.get_job_case(profile_id, job_id).resume_status is ResumeStatus.READY
    run_events = [
        event.event_type
        for event in factory.state.events
        if event.metadata.get("resume_run_id") == run.id
    ]
    assert run_events == [
        "resume.queued",
        "resume.drafting",
        "resume.validating",
        "resume.compiling",
        "resume.ready",
    ]
    submitted = service.mark_applied(profile_id, job_id)
    assert submitted.submitted_artifact_id == run.artifact.id


async def test_each_confirmed_generation_creates_a_new_immutable_run() -> None:
    service, factory, profile_id, job_id = await prepared_tailoring_service()

    first = await service.generate_resume(profile_id, job_id)
    second = await service.generate_resume(profile_id, job_id)

    assert first.id != second.id
    assert first.stage is ResumeStage.READY
    assert second.stage is ResumeStage.READY
    assert factory.state.runs[first.id] == first
    assert factory.state.runs[second.id] == second
    assert len(factory.state.runs) == 2


async def test_inbox_orders_by_latest_case_job_review_or_resume_activity() -> None:
    service, factory, profile_id, first_job_id = await prepared_tailoring_service()
    second_case = service.add_job_url(profile_id, "https://example.com/jobs/99")
    assert service.list_inbox(profile_id)[0].job_id == second_case.job_id

    await service.generate_resume(profile_id, first_job_id)
    assert service.list_inbox(profile_id)[0].job_id == first_job_id

    second_job = factory.state.jobs[second_case.job_id]
    service.update_job_details(
        profile_id,
        second_job.id,
        JobDetails(title="Newer job activity"),
        expected_revision=second_job.revision,
    )
    assert service.list_inbox(profile_id)[0].job_id == second_case.job_id


async def test_blocking_validation_preserves_findings_and_never_compiles_ready() -> None:
    finding = ValidationFinding(
        severity=ValidationSeverity.ERROR,
        message="Unsupported claim",
        location="summary",
    )
    service, factory, profile_id, job_id = await prepared_tailoring_service(
        validator=Validator((finding,))
    )

    run = await service.generate_resume(profile_id, job_id)
    assert run.stage is ResumeStage.FAILED
    assert run.validation_findings == (finding,)
    assert run.artifact is None
    run_events = [
        event.event_type
        for event in factory.state.events
        if event.metadata.get("resume_run_id") == run.id
    ]
    assert run_events[-1] == "resume.failed"


async def test_invalid_compiler_output_fails_run_without_an_artifact() -> None:
    service, factory, profile_id, job_id = await prepared_tailoring_service(
        compiler=InvalidCompiler()
    )

    with pytest.raises(ArtifactError, match="non-PDF"):
        await service.generate_resume(profile_id, job_id)

    run = next(iter(factory.state.runs.values()))
    assert run.stage is ResumeStage.FAILED
    assert run.artifact is None


async def test_generation_preflight_rejects_missing_provider_without_a_run() -> None:
    analyzer = Analyzer()
    service, factory = service_with(analyzer=analyzer)
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/42")
    await service.review_job(profile.id, case.job_id)
    service.answer_verification(profile.id, case.job_id, "authorized", Answer.YES)
    service.decide_job(profile.id, case.job_id, Decision.TAILOR)

    with pytest.raises(ProviderUnavailableError):
        await service.generate_resume(profile.id, case.job_id)
    assert factory.state.runs == {}


def test_startup_recovery_marks_abandoned_runs_interrupted() -> None:
    service, factory = service_with()
    profile = service.create_profile(profile_draft())
    case = service.add_job_url(profile.id, "https://example.com/jobs/recovery")
    factory.state.runs["run-1"] = ResumeRun(
        id="run-1",
        job_case_id=case.id,
        review_version_id="review-1",
        evidence_version_id="evidence-1",
        input_fingerprint="inputs",
        stage=ResumeStage.COMPILING,
        generator_version="g1",
        validator_version="v1",
        compiler_version="c1",
    )

    assert service.recover_interrupted_runs() == 1
    assert factory.state.runs["run-1"].stage is ResumeStage.INTERRUPTED
    recovery_events = [
        event for event in factory.state.events if event.metadata.get("resume_run_id") == "run-1"
    ]
    assert [event.event_type for event in recovery_events] == ["resume.interrupted"]
    assert recovery_events[0].job_case_id == case.id
    assert recovery_events[0].profile_id == profile.id
    assert service.recover_interrupted_runs() == 0
