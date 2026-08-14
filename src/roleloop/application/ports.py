"""Repository, unit-of-work, and external-provider ports.

Infrastructure adapters implement these structural protocols.  Application
tests can use small in-memory implementations without importing SQLite.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Protocol, Self

from roleloop.domain import (
    ApplicationSubmission,
    ArtifactRef,
    Job,
    JobCase,
    OutcomeEvent,
    ResumeEvidenceVersion,
    ResumeRun,
    ReviewVersion,
    SearchProfile,
    ValidationFinding,
    VerificationAnswer,
    WorkflowEvent,
)

from .dto import (
    CompiledDocument,
    DiscoveredJob,
    EvidenceImport,
    ExtractedEvidence,
    GenerationContext,
    ProgressUpdate,
    ResumeDraft,
    ReviewAnalysis,
    ReviewContext,
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


class JobsRepository(Protocol):
    def add(self, job: Job) -> None: ...

    def get(self, job_id: str) -> Job | None: ...

    def get_by_canonical_url(self, canonical_url: str) -> Job | None: ...

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


class UnitOfWork(Protocol):
    profiles: ProfilesRepository
    evidence: EvidenceRepository
    jobs: JobsRepository
    cases: JobCasesRepository
    reviews: ReviewsRepository
    resume_runs: ResumeRunsRepository
    applications: ApplicationsRepository
    events: EventsRepository

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
