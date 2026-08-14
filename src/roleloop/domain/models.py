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
ProfileVersionId: TypeAlias = str
JobVersionId: TypeAlias = str
AgentRunId: TypeAlias = str
DecisionEventId: TypeAlias = str
ApplicationId: TypeAlias = str


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


class AgentKind(StrEnum):
    SCOUT = "scout"
    REVIEWER = "reviewer"
    RESUME = "resume"


class AgentProvider(StrEnum):
    OPENAI = "openai"
    DEMO = "demo"


class AgentRunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INTERRUPTED = "interrupted"

    @property
    def is_in_progress(self) -> bool:
        return self in {AgentRunStatus.QUEUED, AgentRunStatus.RUNNING}


class ActorKind(StrEnum):
    HUMAN = "human"
    SYSTEM = "system"


class ScoutMode(StrEnum):
    SEARCH = "search"
    URL_ENRICHMENT = "url_enrichment"


class JobSourceKind(StrEnum):
    COMPANY = "company"
    ATS = "ats"
    AGGREGATOR = "aggregator"
    SEARCH = "search"
    OTHER = "other"


class JobIdentityKind(StrEnum):
    CANONICAL_URL = "canonical_url"
    REQUISITION = "requisition"
    HEURISTIC = "heuristic"


class HardBlockerKind(StrEnum):
    CLOSED = "closed"
    HQ_COUNTRY = "hq_country"
    STARTUP = "startup"
    WORK_AUTHORIZATION = "work_authorization"
    REMOTE_HIRING = "remote_hiring"
    REMOTE_ARRANGEMENT = "remote_arrangement"
    SALARY_MAXIMUM = "salary_maximum"


class RuleOperator(StrEnum):
    EQUALS = "equals"
    CONTAINS = "contains"
    AT_LEAST = "at_least"
    REQUIRED = "required"


class ScreenResult(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"


class FindingKind(StrEnum):
    MATCH = "match"
    SKEPTIC = "skeptic"
    BLOCKER = "blocker"


class DecisionReason(StrEnum):
    HUMAN_CHOICE = "human_choice"
    DETERMINISTIC_HARD_BLOCKER = "deterministic_hard_blocker"
    LEGACY_UNPINNED = "legacy_unpinned"


class ResumeReviewDecision(StrEnum):
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"
    REJECTED = "rejected"


class ResumeApprovalStatus(StrEnum):
    NONE = "none"
    NEEDS_REVIEW = "needs_review"
    CHANGES_REQUESTED = "changes_requested"
    APPROVED = "approved"
    REJECTED = "rejected"
    STALE = "stale"


class ApplicationStage(StrEnum):
    SUBMITTED = "submitted"
    ACKNOWLEDGED = "acknowledged"
    RECRUITER_SCREEN = "recruiter_screen"
    HIRING_MANAGER_SCREEN = "hiring_manager_screen"
    ASSESSMENT = "assessment"
    TECHNICAL_INTERVIEW = "technical_interview"
    FINAL_OR_ONSITE = "final_or_onsite"
    OFFER = "offer"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    NO_RESPONSE = "no_response"

    @property
    def is_terminal(self) -> bool:
        return self in {
            ApplicationStage.OFFER,
            ApplicationStage.REJECTED,
            ApplicationStage.WITHDRAWN,
            ApplicationStage.NO_RESPONSE,
        }


class FollowUpResolutionKind(StrEnum):
    COMPLETED = "completed"
    DISMISSED = "dismissed"
    RESCHEDULED = "rescheduled"


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
    current_version_id: ProfileVersionId | None = None
    residence_country: str = "Ecuador"
    timezone: str = "America/Guayaquil"
    target_hq_countries: tuple[str, ...] = ()
    startup_required: bool = False
    accepted_remote_arrangements: tuple[str, ...] = ()
    accepted_hiring_arrangements: tuple[str, ...] = ()
    search_queries: tuple[str, ...] = ()
    paper_size: str = "a4paper"
    page_limit: int = 2
    agent_configurations: tuple[AgentConfiguration, ...] = ()


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
    contract_schema_version: str | None = None
    canonical_evidence_artifact: ArtifactRef | None = None
    source_bundle_artifact: ArtifactRef | None = None
    renderer_protocol_version: str | None = None
    renderer_version: str | None = None
    contract_checksum: str | None = None


@dataclass(frozen=True, slots=True)
class ResumeSource:
    """Mutable profile-level configuration for a versioned master résumé."""

    id: ResumeSourceId
    profile_id: ProfileId
    kind: ResumeSourceKind
    repository: str
    ref: str
    document_path: str = "roleloop_contract/v1/cli.py"
    trust_acknowledged_at: datetime | None = None
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
    current_version_id: JobVersionId | None = None
    listing_closed: bool | None = None
    hq_country: str | None = None
    startup: bool | None = None
    work_authorization_required: bool | None = None
    us_only: bool | None = None
    remote_from_ecuador: bool | None = None
    remote_arrangement: str | None = None
    hiring_arrangement: str | None = None


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
    current_decision_event_id: DecisionEventId | None = None


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
    source_anchor: str = ""

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
    agent_run_id: AgentRunId | None = None
    job_version_id: JobVersionId | None = None
    profile_version_id: ProfileVersionId | None = None
    evidence_version_id: EvidenceVersionId | None = None
    answer_set_fingerprint: str = ""
    screen_set_fingerprint: str = ""
    recommended_decision: Decision = Decision.UNDECIDED
    legacy_input_status: str = "native"
    requirements: tuple[ReviewRequirement, ...] = ()
    confidence: float = 0.0
    positioning: str = ""
    self_critique: str = ""

    @property
    def strengths(self) -> tuple[Finding, ...]:
        return self.match_evidence

    @property
    def gaps(self) -> tuple[Finding, ...]:
        return self.skeptic_findings


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
    agent_run_id: AgentRunId | None = None
    parent_resume_run_id: ResumeRunId | None = None
    feedback_review_event_id: str | None = None
    gate_decision_event_id: DecisionEventId | None = None
    job_version_id: JobVersionId | None = None
    profile_version_id: ProfileVersionId | None = None
    answer_set_fingerprint: str = ""
    headline: str | None = None
    selected_bullet_ids: tuple[str, ...] = ()
    selected_skill_ids: tuple[str, ...] = ()
    selection_artifact: ArtifactRef | None = None
    tailored_source_bundle_artifact: ArtifactRef | None = None
    render_receipt_artifact: ArtifactRef | None = None
    selected_experiences: tuple[ResumeExperienceSelection, ...] = ()
    review_file_artifact: ArtifactRef | None = None
    compile_log_artifact: ArtifactRef | None = None
    ats_text_artifact: ArtifactRef | None = None
    rendered_page_count: int | None = None
    renderer_source_revision: str | None = None
    render_tool_versions: Mapping[str, str] = field(default_factory=dict)
    render_output_checksums: Mapping[str, str] = field(default_factory=dict)


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


@dataclass(frozen=True, slots=True)
class CommandReceipt:
    command_id: str
    command_type: str
    result_type: str
    result_id: str
    created_at: datetime
    request_fingerprint: str | None = None


@dataclass(frozen=True, slots=True)
class SearchProfileVersion:
    id: ProfileVersionId
    profile_id: ProfileId
    version_number: int
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
    agent_provider: AgentProvider = AgentProvider.DEMO
    residence_country: str = "Ecuador"
    timezone: str = "America/Guayaquil"
    target_hq_countries: tuple[str, ...] = ()
    startup_required: bool = False
    accepted_remote_arrangements: tuple[str, ...] = ()
    accepted_hiring_arrangements: tuple[str, ...] = ()
    search_queries: tuple[str, ...] = ()
    paper_size: str = "a4paper"
    page_limit: int = 2
    agent_configurations: tuple[AgentConfiguration, ...] = ()
    legacy_input_status: str = "native"
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class AgentConfiguration:
    kind: AgentKind
    provider: AgentProvider
    model: str = "gpt-5.6-terra"
    reasoning_effort: str = "medium"


@dataclass(frozen=True, slots=True)
class HardBlockerRule:
    id: str
    profile_version_id: ProfileVersionId
    rule_key: str
    kind: HardBlockerKind
    operator: RuleOperator
    text_value: str | None = None
    integer_value: int | None = None
    boolean_value: bool | None = None
    position: int = 0


@dataclass(frozen=True, slots=True)
class AgentRun:
    id: AgentRunId
    command_id: str
    kind: AgentKind
    provider: AgentProvider
    model: str
    prompt_version: str
    output_schema_version: str
    profile_id: ProfileId
    job_case_id: JobCaseId | None
    input_fingerprint: str
    status: AgentRunStatus
    prompt_hash: str = ""
    output_schema_hash: str = ""
    provider_response_id: str | None = None
    response_model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    source_urls: tuple[str, ...] = ()
    status_detail: str = ""
    request_artifact_id: ArtifactId | None = None
    response_artifact_id: ArtifactId | None = None
    error_code: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class WebSourceSnapshot:
    id: str
    canonical_url: str
    source_kind: JobSourceKind
    title: str
    publisher: str
    retrieved_at: datetime
    content_checksum: str
    quoted_evidence: str = ""
    content_artifact_id: ArtifactId | None = None


@dataclass(frozen=True, slots=True)
class JobIdentityKey:
    key: str
    job_id: JobId
    kind: JobIdentityKind
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class JobVersion:
    id: JobVersionId
    job_id: JobId
    version_number: int
    content_fingerprint: str
    canonical_url: str
    title: str
    company: str
    location: str
    description: str
    source: str
    employment_type: str = ""
    seniority: str = ""
    salary_min: int | None = None
    salary_max: int | None = None
    salary_currency: str | None = None
    external_requisition_id: str | None = None
    listing_closed: bool | None = None
    hq_country: str | None = None
    startup: bool | None = None
    work_authorization_required: bool | None = None
    us_only: bool | None = None
    remote_from_ecuador: bool | None = None
    remote_arrangement: str | None = None
    hiring_arrangement: str | None = None
    legacy_input_status: str = "native"
    observed_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ReviewRequirement:
    key: str
    text: str
    evidence: str
    required: bool = True
    source_anchor: str = ""


@dataclass(frozen=True, slots=True)
class ResumeExperienceSelection:
    experience_id: str
    bullet_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ScoutRun:
    id: str
    agent_run_id: AgentRunId
    profile_version_id: ProfileVersionId
    mode: ScoutMode
    requested_url: str | None = None
    result_limit: int = 20
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ScoutCandidate:
    scout_run_id: str
    position: int
    job_id: JobId
    job_version_id: JobVersionId
    dedupe_key: str


@dataclass(frozen=True, slots=True)
class ScreenEvaluation:
    id: str
    job_case_id: JobCaseId
    job_version_id: JobVersionId
    profile_version_id: ProfileVersionId
    rule_id: str
    result: ScreenResult
    detail: str = ""
    source_snapshot_id: str | None = None
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class VerificationAnswerEvent:
    id: str
    command_id: str
    job_case_id: JobCaseId
    question_key: str
    asked_by_review_version_id: ReviewVersionId
    answer: Answer
    actor: ActorKind
    supersedes_answer_event_id: str | None = None
    legacy: bool = False
    recorded_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class CaseDecisionEvent:
    id: DecisionEventId
    command_id: str
    job_case_id: JobCaseId
    decision: Decision
    reason: DecisionReason
    actor: ActorKind
    review_version_id: ReviewVersionId | None = None
    job_version_id: JobVersionId | None = None
    profile_version_id: ProfileVersionId | None = None
    evidence_version_id: EvidenceVersionId | None = None
    answer_set_fingerprint: str | None = None
    screen_evaluation_id: str | None = None
    supersedes_decision_event_id: DecisionEventId | None = None
    rationale: str = ""
    decided_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ResumeReviewEvent:
    id: str
    command_id: str
    resume_run_id: ResumeRunId
    decision: ResumeReviewDecision
    actor: ActorKind
    feedback: str = ""
    pdf_artifact_id: ArtifactId | None = None
    pdf_checksum: str | None = None
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class TrackedApplication:
    id: ApplicationId
    command_id: str
    job_id: JobId
    job_case_id: JobCaseId
    current_stage: ApplicationStage
    approved_resume_review_event_id: str | None
    resume_run_id: ResumeRunId | None
    pdf_artifact_id: ArtifactId | None
    pdf_checksum: str | None
    job_version_id: JobVersionId | None
    profile_version_id: ProfileVersionId | None
    evidence_version_id: EvidenceVersionId | None
    review_version_id: ReviewVersionId | None
    gate_decision_event_id: DecisionEventId | None
    submitted_at: datetime
    legacy: bool = False
    revision: int = 1
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ApplicationStageEvent:
    id: str
    command_id: str
    application_id: ApplicationId
    stage: ApplicationStage
    actor: ActorKind
    occurred_at: datetime
    recorded_at: datetime
    note: str = ""


@dataclass(frozen=True, slots=True)
class ApplicationFollowUp:
    id: str
    command_id: str
    application_id: ApplicationId
    due_at: datetime
    note: str = ""
    trigger_stage_event_id: str | None = None
    supersedes_follow_up_id: str | None = None
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class FollowUpResolution:
    id: str
    command_id: str
    follow_up_id: str
    disposition: FollowUpResolutionKind
    replacement_follow_up_id: str | None = None
    note: str = ""
    resolved_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class LegacyImportBatch:
    id: str
    command_id: str
    profile_id: ProfileId
    source_checksum: str
    imported_jobs: int
    imported_events: int
    created_at: datetime
    sources: tuple[LegacyImportSource, ...] = ()


@dataclass(frozen=True, slots=True)
class LegacyImportSource:
    batch_id: str
    position: int
    database_name: str
    source_checksum: str
    size_bytes: int
    job_count: int
    event_count: int


@dataclass(frozen=True, slots=True)
class LegacyImportItem:
    batch_id: str
    legacy_key: str
    entity_type: str
    entity_id: str
