"""Repository, unit-of-work, and external-provider ports.

Infrastructure adapters implement these structural protocols.  Application
tests can use small in-memory implementations without importing SQLite.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Protocol, Self

from roleloop.domain import (
    AgentRun,
    ApplicationFollowUp,
    ApplicationStageEvent,
    ApplicationSubmission,
    ArtifactRef,
    CaseDecisionEvent,
    CommandReceipt,
    FollowUpResolution,
    HardBlockerRule,
    Job,
    JobCase,
    JobIdentityKey,
    JobVersion,
    LegacyImportBatch,
    LegacyImportItem,
    LegacyImportSource,
    OutcomeEvent,
    ResumeEvidenceVersion,
    ResumeReviewEvent,
    ResumeRun,
    ResumeSource,
    ReviewVersion,
    ScoutCandidate,
    ScoutRun,
    ScreenEvaluation,
    SearchProfile,
    SearchProfileVersion,
    TrackedApplication,
    ValidationFinding,
    VerificationAnswer,
    VerificationAnswerEvent,
    WebSourceSnapshot,
    WorkflowEvent,
)

from .dto import (
    AgentDescriptor,
    CompiledDocument,
    DiscoveredJob,
    EvidenceImport,
    ExtractedEvidence,
    GenerationContext,
    MasterResumeRenderRequest,
    MasterResumeRenderResult,
    PdfInspection,
    ProgressUpdate,
    ResumeDraft,
    ResumeSelection,
    ResumeSelectionContext,
    ResumeSourceSnapshot,
    ReviewAnalysis,
    ReviewContext,
    ReviewerContext,
    ReviewerReport,
    RuntimeReadiness,
    ScoutContext,
    ScoutReport,
)


class ProfilesRepository(Protocol):
    def add(self, profile: SearchProfile) -> None: ...

    def get(self, profile_id: str) -> SearchProfile | None: ...

    def get_active(self) -> SearchProfile | None: ...

    def list(self) -> Sequence[SearchProfile]: ...

    def update(self, profile: SearchProfile, *, expected_revision: int) -> bool: ...

    def set_active(self, profile_id: str, *, at: datetime) -> bool: ...


class EvidenceRepository(Protocol):
    def add(self, evidence: ResumeEvidenceVersion) -> None: ...

    def get(self, evidence_id: str) -> ResumeEvidenceVersion | None: ...

    def list_for_profile(self, profile_id: str) -> Sequence[ResumeEvidenceVersion]: ...


class ResumeSourcesRepository(Protocol):
    def add(self, source: ResumeSource) -> None: ...

    def get(self, source_id: str) -> ResumeSource | None: ...

    def get_for_profile(self, profile_id: str) -> ResumeSource | None: ...

    def update(self, source: ResumeSource, *, expected_revision: int) -> bool: ...


class JobsRepository(Protocol):
    def add(self, job: Job) -> None: ...

    def get(self, job_id: str) -> Job | None: ...

    def get_by_canonical_url(self, canonical_url: str) -> Job | None: ...

    def get_by_identity_key(self, key: str) -> Job | None: ...

    def add_identity_key(self, identity: JobIdentityKey) -> bool: ...

    def list_identity_keys(self, job_id: str) -> Sequence[JobIdentityKey]: ...

    def update(self, job: Job, *, expected_revision: int) -> bool: ...


class JobCasesRepository(Protocol):
    def add(self, case: JobCase) -> None: ...

    def get(self, case_id: str) -> JobCase | None: ...

    def get_for_profile_job(self, profile_id: str, job_id: str) -> JobCase | None: ...

    def list_for_profile(self, profile_id: str) -> Sequence[JobCase]: ...

    def update(self, case: JobCase, *, expected_revision: int) -> bool: ...


class ReviewsRepository(Protocol):
    def add(self, review: ReviewVersion) -> None: ...

    def get(self, review_id: str) -> ReviewVersion | None: ...

    def get_latest(self, case_id: str) -> ReviewVersion | None: ...

    def list_for_case(self, case_id: str) -> Sequence[ReviewVersion]: ...

    def upsert_answer(self, answer: VerificationAnswer) -> None: ...

    def list_answers(self, review_id: str) -> Sequence[VerificationAnswer]: ...


class ResumeRunsRepository(Protocol):
    def add(self, run: ResumeRun) -> None: ...

    def get(self, run_id: str) -> ResumeRun | None: ...

    def get_latest(self, case_id: str) -> ResumeRun | None: ...

    def list_for_case(self, case_id: str) -> Sequence[ResumeRun]: ...

    def list_in_progress(self) -> Sequence[ResumeRun]: ...

    def update(self, run: ResumeRun) -> None: ...


class ApplicationsRepository(Protocol):
    def add_submission(self, submission: ApplicationSubmission) -> None: ...

    def get_submission(self, case_id: str) -> ApplicationSubmission | None: ...

    def add_outcome(self, outcome: OutcomeEvent) -> None: ...

    def list_outcomes(self, case_id: str) -> Sequence[OutcomeEvent]: ...


class EventsRepository(Protocol):
    def add(self, event: WorkflowEvent) -> None: ...

    def list_for_case(self, case_id: str) -> Sequence[WorkflowEvent]: ...


class ArtifactsRepository(Protocol):
    def add(self, artifact: ArtifactRef) -> None: ...

    def get(self, artifact_id: str) -> ArtifactRef | None: ...


class CommandReceiptsRepository(Protocol):
    def add(self, receipt: CommandReceipt) -> None: ...

    def get(self, command_id: str) -> CommandReceipt | None: ...


class ProfileVersionsRepository(Protocol):
    def add(
        self,
        version: SearchProfileVersion,
        rules: Sequence[HardBlockerRule] = (),
    ) -> None: ...

    def get(self, version_id: str) -> SearchProfileVersion | None: ...

    def get_current(self, profile_id: str) -> SearchProfileVersion | None: ...

    def list_for_profile(self, profile_id: str) -> Sequence[SearchProfileVersion]: ...

    def list_rules(self, version_id: str) -> Sequence[HardBlockerRule]: ...


class JobVersionsRepository(Protocol):
    def add(
        self,
        version: JobVersion,
        sources: Sequence[WebSourceSnapshot] = (),
    ) -> None: ...

    def get(self, version_id: str) -> JobVersion | None: ...

    def get_current(self, job_id: str) -> JobVersion | None: ...

    def get_by_fingerprint(self, job_id: str, fingerprint: str) -> JobVersion | None: ...

    def list_for_job(self, job_id: str) -> Sequence[JobVersion]: ...

    def list_sources(self, version_id: str) -> Sequence[WebSourceSnapshot]: ...


class AgentRunsRepository(Protocol):
    def add(self, run: AgentRun) -> None: ...

    def get(self, run_id: str) -> AgentRun | None: ...

    def get_by_command_id(self, command_id: str) -> AgentRun | None: ...

    def update(self, run: AgentRun) -> None: ...

    def list_for_case(self, case_id: str) -> Sequence[AgentRun]: ...

    def list_in_progress(self) -> Sequence[AgentRun]: ...

    def add_scout_run(
        self,
        run: ScoutRun,
        candidates: Sequence[ScoutCandidate],
    ) -> None: ...

    def get_scout_run(self, scout_run_id: str) -> ScoutRun | None: ...

    def list_scout_candidates(self, scout_run_id: str) -> Sequence[ScoutCandidate]: ...


class ScreenEvaluationsRepository(Protocol):
    def add_all(self, evaluations: Sequence[ScreenEvaluation]) -> None: ...

    def list_current(
        self,
        case_id: str,
        job_version_id: str,
        profile_version_id: str,
    ) -> Sequence[ScreenEvaluation]: ...


class AnswerEventsRepository(Protocol):
    def add(self, event: VerificationAnswerEvent) -> None: ...

    def get(self, event_id: str) -> VerificationAnswerEvent | None: ...

    def list_for_case(self, case_id: str) -> Sequence[VerificationAnswerEvent]: ...


class DecisionEventsRepository(Protocol):
    def add(self, event: CaseDecisionEvent) -> None: ...

    def get(self, event_id: str) -> CaseDecisionEvent | None: ...

    def list_for_case(self, case_id: str) -> Sequence[CaseDecisionEvent]: ...


class ResumeReviewsRepository(Protocol):
    def add(self, event: ResumeReviewEvent) -> None: ...

    def get(self, event_id: str) -> ResumeReviewEvent | None: ...

    def get_latest(self, resume_run_id: str) -> ResumeReviewEvent | None: ...

    def list_for_run(self, resume_run_id: str) -> Sequence[ResumeReviewEvent]: ...


class TrackedApplicationsRepository(Protocol):
    def add(self, application: TrackedApplication) -> None: ...

    def get(self, application_id: str) -> TrackedApplication | None: ...

    def get_for_job(self, job_id: str) -> TrackedApplication | None: ...

    def get_for_case(self, case_id: str) -> TrackedApplication | None: ...

    def update(self, application: TrackedApplication, *, expected_revision: int) -> bool: ...

    def add_stage(self, event: ApplicationStageEvent) -> None: ...

    def list_stages(self, application_id: str) -> Sequence[ApplicationStageEvent]: ...


class FollowUpsRepository(Protocol):
    def add(self, follow_up: ApplicationFollowUp) -> None: ...

    def get(self, follow_up_id: str) -> ApplicationFollowUp | None: ...

    def get_open_for_application(self, application_id: str) -> ApplicationFollowUp | None: ...

    def list_for_application(self, application_id: str) -> Sequence[ApplicationFollowUp]: ...

    def list_due(
        self, *, at: datetime, profile_id: str | None = None
    ) -> Sequence[ApplicationFollowUp]: ...

    def add_resolution(self, resolution: FollowUpResolution) -> None: ...

    def list_resolutions(self, follow_up_id: str) -> Sequence[FollowUpResolution]: ...


class LegacyImportsRepository(Protocol):
    def add(self, batch: LegacyImportBatch) -> None: ...

    def add_item(self, item: LegacyImportItem) -> None: ...

    def list_items(self, batch_id: str) -> Sequence[LegacyImportItem]: ...

    def list_sources(self, batch_id: str) -> Sequence[LegacyImportSource]: ...

    def get_by_checksum(
        self, profile_id: str, source_checksum: str
    ) -> LegacyImportBatch | None: ...


class UnitOfWork(Protocol):
    profiles: ProfilesRepository
    evidence: EvidenceRepository
    resume_sources: ResumeSourcesRepository
    jobs: JobsRepository
    cases: JobCasesRepository
    reviews: ReviewsRepository
    resume_runs: ResumeRunsRepository
    applications: ApplicationsRepository
    events: EventsRepository
    artifacts: ArtifactsRepository
    commands: CommandReceiptsRepository
    profile_versions: ProfileVersionsRepository
    job_versions: JobVersionsRepository
    agent_runs: AgentRunsRepository
    screens: ScreenEvaluationsRepository
    answer_events: AnswerEventsRepository
    decision_events: DecisionEventsRepository
    resume_reviews: ResumeReviewsRepository
    tracked_applications: TrackedApplicationsRepository
    follow_ups: FollowUpsRepository
    legacy_imports: LegacyImportsRepository

    def __enter__(self) -> Self: ...

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


class UnitOfWorkFactory(Protocol):
    def __call__(self) -> UnitOfWork: ...


class Clock(Protocol):
    def now(self) -> datetime: ...


class IdGenerator(Protocol):
    def new(self) -> str: ...


class ProgressReporter(Protocol):
    def report(self, update: ProgressUpdate) -> None: ...


class NullProgressReporter:
    def report(self, update: ProgressUpdate) -> None:
        del update


class DiscoveryProvider(Protocol):
    @property
    def version(self) -> str: ...

    async def discover(
        self,
        profile: SearchProfile,
        *,
        limit: int,
        progress: ProgressReporter,
    ) -> Sequence[DiscoveredJob]: ...


class ResumeSourceSynchronizer(Protocol):
    async def sync(
        self,
        source: ResumeSource,
        *,
        progress: ProgressReporter,
    ) -> ResumeSourceSnapshot: ...


class ReviewAnalyzer(Protocol):
    @property
    def version(self) -> str: ...

    async def analyze(
        self, context: ReviewContext, *, progress: ProgressReporter
    ) -> ReviewAnalysis: ...


class ResumeGenerator(Protocol):
    @property
    def version(self) -> str: ...

    async def generate(
        self, context: GenerationContext, *, progress: ProgressReporter
    ) -> ResumeDraft: ...


class ResumeValidator(Protocol):
    @property
    def version(self) -> str: ...

    async def validate(
        self,
        context: GenerationContext,
        draft: ResumeDraft,
        *,
        progress: ProgressReporter,
    ) -> Sequence[ValidationFinding]: ...


class PdfCompiler(Protocol):
    @property
    def version(self) -> str: ...

    async def compile(
        self,
        context: GenerationContext,
        draft: ResumeDraft,
        *,
        progress: ProgressReporter,
    ) -> CompiledDocument: ...


class EvidenceExtractor(Protocol):
    async def extract(self, request: EvidenceImport) -> ExtractedEvidence: ...


class ArtifactStore(Protocol):
    async def put_bytes(
        self,
        data: bytes,
        *,
        media_type: str,
        extension: str,
    ) -> ArtifactRef: ...


class ArtifactReader(Protocol):
    async def read_bytes(self, artifact: ArtifactRef) -> bytes: ...


class ArtifactExporter(Protocol):
    async def export(self, artifact: ArtifactRef, destination: Path) -> Path: ...


class ScoutAgent(Protocol):
    @property
    def descriptor(self) -> AgentDescriptor: ...

    async def discover(
        self,
        context: ScoutContext,
        *,
        progress: ProgressReporter,
    ) -> ScoutReport: ...


class ReviewerAgent(Protocol):
    @property
    def descriptor(self) -> AgentDescriptor: ...

    async def analyze(
        self,
        context: ReviewerContext,
        *,
        progress: ProgressReporter,
    ) -> ReviewerReport: ...


class ResumeAgent(Protocol):
    @property
    def descriptor(self) -> AgentDescriptor: ...

    async def select(
        self,
        context: ResumeSelectionContext,
        *,
        progress: ProgressReporter,
    ) -> ResumeSelection: ...


class AgentProviderRegistry(Protocol):
    """Resolve providers from the current immutable profile version per command."""

    def scout(self, profile_version: SearchProfileVersion) -> ScoutAgent: ...

    def reviewer(self, profile_version: SearchProfileVersion) -> ReviewerAgent: ...

    def resume(self, profile_version: SearchProfileVersion) -> ResumeAgent: ...


class MasterResumeRenderer(Protocol):
    @property
    def protocol_version(self) -> str: ...

    async def render(
        self,
        request: MasterResumeRenderRequest,
        *,
        progress: ProgressReporter,
    ) -> MasterResumeRenderResult: ...


class PdfInspector(Protocol):
    def inspect(self, data: bytes) -> PdfInspection: ...


class RuntimeDoctor(Protocol):
    async def check(
        self, profile_version: SearchProfileVersion | None = None
    ) -> RuntimeReadiness: ...
