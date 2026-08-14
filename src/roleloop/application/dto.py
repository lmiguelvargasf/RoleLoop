"""Commands and immutable read models at the application boundary."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from roleloop.domain import (
    Answer,
    ApplicationStatus,
    ArtifactRef,
    ClaimProvenance,
    Decision,
    EligibilityStatus,
    EvidenceSourceKind,
    Finding,
    Job,
    JobCase,
    Outcome,
    QuestionCategory,
    RemotePreference,
    ResumeEvidenceVersion,
    ResumeRun,
    ResumeSource,
    ResumeSourceKind,
    ResumeStatus,
    ReviewStatus,
    ReviewVersion,
    SearchProfile,
    WorkflowEvent,
)


@dataclass(frozen=True, slots=True)
class ProfileDraft:
    name: str
    target_roles: tuple[str, ...] = ()
    locations: tuple[str, ...] = ()
    remote_preference: RemotePreference = RemotePreference.ANY
    employment_types: tuple[str, ...] = ()
    seniority: tuple[str, ...] = ()
    annual_salary_floor: int | None = None
    salary_currency: str = "USD"
    include_keywords: tuple[str, ...] = ()
    exclude_keywords: tuple[str, ...] = ()
    constraints: str = ""


@dataclass(frozen=True, slots=True)
class ResumeSourceDraft:
    repository: str
    kind: ResumeSourceKind
    document_path: str
    ref: str | None = None


@dataclass(frozen=True, slots=True)
class ResumeSourceSnapshot:
    """Immutable result resolved by a résumé-source synchronizer."""

    source_bytes: bytes
    extracted_text: str
    source_name: str
    media_type: str
    extension: str
    source_revision: str
    content_checksum: str


@dataclass(frozen=True, slots=True)
class EvidenceImport:
    source_kind: EvidenceSourceKind
    path: Path | None = None
    text: str | None = None
    source_name: str | None = None


@dataclass(frozen=True, slots=True)
class ExtractedEvidence:
    source_kind: EvidenceSourceKind
    source_name: str
    source_bytes: bytes
    extracted_text: str
    media_type: str
    extension: str


@dataclass(frozen=True, slots=True)
class JobDetails:
    title: str = ""
    company: str = ""
    location: str = ""
    description: str = ""
    source: str = "manual"
    source_metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DiscoveredJob:
    url: str
    details: JobDetails


@dataclass(frozen=True, slots=True)
class InboxFilters:
    search: str = ""
    review: frozenset[ReviewStatus] = frozenset()
    eligibility: frozenset[EligibilityStatus] = frozenset()
    decision: frozenset[Decision] = frozenset()
    resume: frozenset[ResumeStatus] = frozenset()
    application: frozenset[ApplicationStatus] = frozenset()
    outcome: frozenset[Outcome | None] = frozenset()


@dataclass(frozen=True, slots=True)
class Page:
    limit: int = 50
    offset: int = 0


@dataclass(frozen=True, slots=True)
class ActiveProfileSummary:
    profile: SearchProfile
    evidence: ResumeEvidenceVersion | None
    provider_capabilities: Mapping[str, bool]
    resume_source: ResumeSource | None = None


@dataclass(frozen=True, slots=True)
class JobInboxItem:
    case_id: str
    job_id: str
    canonical_url: str
    title: str
    company: str
    location: str
    review_status: ReviewStatus
    eligibility_status: EligibilityStatus
    decision: Decision
    resume_status: ResumeStatus
    application_status: ApplicationStatus
    outcome: Outcome | None
    updated_at: datetime | None
    submitted_at: datetime | None = None
    submitted_artifact_id: str | None = None


@dataclass(frozen=True, slots=True)
class JobReviewView:
    job: Job
    case: JobCase
    review_status: ReviewStatus
    review: ReviewVersion | None
    answers: Mapping[str, Answer]
    eligibility_status: EligibilityStatus
    latest_resume_run: ResumeRun | None
    resume_status: ResumeStatus


@dataclass(frozen=True, slots=True)
class ResumeRunView:
    run: ResumeRun
    status: ResumeStatus
    is_current: bool


@dataclass(frozen=True, slots=True)
class ReviewAnalysis:
    match_evidence: tuple[Finding, ...]
    skeptic_findings: tuple[Finding, ...]
    questions: tuple[AnalysisQuestion, ...]


@dataclass(frozen=True, slots=True)
class AnalysisQuestion:
    prompt: str
    category: QuestionCategory
    required: bool
    qualifying_answer: Answer
    key: str | None = None


@dataclass(frozen=True, slots=True)
class ResumeDraft:
    content: Mapping[str, Any]
    provenance: tuple[ClaimProvenance, ...] = ()


@dataclass(frozen=True, slots=True)
class CompiledDocument:
    data: bytes
    media_type: str = "application/pdf"
    extension: str = ".pdf"


@dataclass(frozen=True, slots=True)
class ProgressUpdate:
    operation: str
    stage: str
    message: str = ""
    completed: int | None = None
    total: int | None = None


@dataclass(frozen=True, slots=True)
class GenerationContext:
    profile: SearchProfile
    evidence: ResumeEvidenceVersion
    job: Job
    review: ReviewVersion
    answers: Mapping[str, Answer]


@dataclass(frozen=True, slots=True)
class ReviewContext:
    profile: SearchProfile
    evidence: ResumeEvidenceVersion | None
    job: Job


@dataclass(frozen=True, slots=True)
class JobHistoryView:
    job: Job
    case: JobCase
    events: tuple[WorkflowEvent, ...]


@dataclass(frozen=True, slots=True)
class StoredArtifact:
    ref: ArtifactRef
