"""Framework-independent entities and value objects for RoleLoop.

The objects in this module intentionally contain no persistence, command-line, or
Textual concerns.  Most records are immutable snapshots.  Application services
replace mutable projections (``SearchProfile``, ``Job``, and ``JobCase``) using
``dataclasses.replace`` and repositories persist those replacements with an
optimistic revision check.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, TypeAlias

ProfileId: TypeAlias = str
JobId: TypeAlias = str
JobCaseId: TypeAlias = str
EvidenceVersionId: TypeAlias = str
ReviewVersionId: TypeAlias = str
ResumeRunId: TypeAlias = str
ArtifactId: TypeAlias = str
ResumeSourceId: TypeAlias = str


class RemotePreference(StrEnum):
    ANY = "any"
    REMOTE = "remote"
    HYBRID = "hybrid"
    ONSITE = "onsite"


class ReviewStatus(StrEnum):
    MISSING = "missing"
    CURRENT = "current"
    STALE = "stale"


class EligibilityStatus(StrEnum):
    UNRESOLVED = "unresolved"
    ELIGIBLE = "eligible"
    INELIGIBLE = "ineligible"


class Decision(StrEnum):
    UNDECIDED = "undecided"
    TAILOR = "tailor"
    WATCH = "watch"
    SKIP = "skip"


class ResumeStatus(StrEnum):
    NONE = "none"
    IN_PROGRESS = "in_progress"
    READY = "ready"
    FAILED = "failed"
    STALE = "stale"


class ResumeStage(StrEnum):
    QUEUED = "queued"
    DRAFTING = "drafting"
    VALIDATING = "validating"
    COMPILING = "compiling"
    READY = "ready"
    FAILED = "failed"
    INTERRUPTED = "interrupted"

    @property
    def is_in_progress(self) -> bool:
        return self in {
            ResumeStage.QUEUED,
            ResumeStage.DRAFTING,
            ResumeStage.VALIDATING,
            ResumeStage.COMPILING,
        }


class ApplicationStatus(StrEnum):
    NOT_SUBMITTED = "not_submitted"
    SUBMITTED = "submitted"


class Outcome(StrEnum):
    INTERVIEWING = "interviewing"
    OFFER = "offer"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    NO_RESPONSE = "no_response"


class QuestionCategory(StrEnum):
    ELIGIBILITY = "eligibility"
    VERIFICATION = "verification"


class Answer(StrEnum):
    YES = "yes"
    NO = "no"
    UNKNOWN = "unknown"


class ValidationSeverity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class EvidenceSourceKind(StrEnum):
    PDF = "pdf"
    TEXT_FILE = "text_file"
    PASTED_TEXT = "pasted_text"


class ResumeSourceKind(StrEnum):
    LOCAL_GIT = "local_git"
    REMOTE_GIT = "remote_git"


@dataclass(frozen=True, slots=True)
class SearchProfile:
    id: ProfileId
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
    revision: int = 1
    is_active: bool = False
    active_evidence_version_id: EvidenceVersionId | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    id: ArtifactId
    checksum: str
    uri: str
    media_type: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class ResumeEvidenceVersion:
    id: EvidenceVersionId
    profile_id: ProfileId
    source_kind: EvidenceSourceKind
    source_name: str
    source_artifact: ArtifactRef
    extracted_text: str
    created_at: datetime
    resume_source_id: ResumeSourceId | None = None
    source_revision: str | None = None
    resume_source_kind: ResumeSourceKind | None = None
    source_repository: str | None = None
    source_ref: str | None = None
    source_document_path: str | None = None


@dataclass(frozen=True, slots=True)
class ResumeSource:
    """Mutable profile-level configuration for a versioned master résumé."""

    id: ResumeSourceId
    profile_id: ProfileId
    kind: ResumeSourceKind
    repository: str
    ref: str
    document_path: str
    last_synced_revision: str | None = None
    last_synced_checksum: str | None = None
    last_synced_evidence_version_id: EvidenceVersionId | None = None
    last_synced_at: datetime | None = None
    revision: int = 1
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class Job:
    id: JobId
    canonical_url: str
    title: str = ""
    company: str = ""
    location: str = ""
    description: str = ""
    source: str = "manual"
    source_metadata: Mapping[str, Any] = field(default_factory=dict)
    revision: int = 1
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class JobCase:
    id: JobCaseId
    profile_id: ProfileId
    job_id: JobId
    decision: Decision = Decision.UNDECIDED
    application_status: ApplicationStatus = ApplicationStatus.NOT_SUBMITTED
    current_outcome: Outcome | None = None
    submitted_at: datetime | None = None
    submitted_artifact_id: ArtifactId | None = None
    revision: int = 1
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class Finding:
    summary: str
    detail: str = ""
    source_anchor: str = ""


@dataclass(frozen=True, slots=True)
class ReviewQuestion:
    id: str
    prompt: str
    category: QuestionCategory
    required: bool
    qualifying_answer: Answer

    def __post_init__(self) -> None:
        if self.qualifying_answer is Answer.UNKNOWN:
            raise ValueError("a qualifying answer must be yes or no")


@dataclass(frozen=True, slots=True)
class VerificationAnswer:
    review_version_id: ReviewVersionId
    question_id: str
    answer: Answer
    answered_at: datetime


@dataclass(frozen=True, slots=True)
class ReviewVersion:
    id: ReviewVersionId
    job_case_id: JobCaseId
    fingerprint: str
    analyzer_version: str
    match_evidence: tuple[Finding, ...]
    skeptic_findings: tuple[Finding, ...]
    questions: tuple[ReviewQuestion, ...]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ClaimProvenance:
    claim: str
    evidence_anchor: str


@dataclass(frozen=True, slots=True)
class ValidationFinding:
    severity: ValidationSeverity
    message: str
    location: str = ""


@dataclass(frozen=True, slots=True)
class ResumeRun:
    id: ResumeRunId
    job_case_id: JobCaseId
    review_version_id: ReviewVersionId
    evidence_version_id: EvidenceVersionId
    input_fingerprint: str
    stage: ResumeStage
    generator_version: str
    validator_version: str
    compiler_version: str
    structured_draft: Mapping[str, Any] | None = None
    provenance: tuple[ClaimProvenance, ...] = ()
    validation_findings: tuple[ValidationFinding, ...] = ()
    artifact: ArtifactRef | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ApplicationSubmission:
    id: str
    job_case_id: JobCaseId
    decision_at_submission: Decision
    artifact_id: ArtifactId | None
    submitted_at: datetime


@dataclass(frozen=True, slots=True)
class OutcomeEvent:
    id: str
    job_case_id: JobCaseId
    outcome: Outcome
    recorded_at: datetime


@dataclass(frozen=True, slots=True)
class WorkflowEvent:
    id: str
    event_type: str
    occurred_at: datetime
    profile_id: ProfileId
    job_case_id: JobCaseId | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
