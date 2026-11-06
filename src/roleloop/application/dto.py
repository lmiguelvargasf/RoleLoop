"""Commands and immutable read models at the application boundary."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from roleloop.domain import (
    AgentConfiguration,
    AgentProvider,
    AgentRunStatus,
    Answer,
    ApplicationFollowUp,
    ApplicationStage,
    ApplicationStageEvent,
    ApplicationStatus,
    ArtifactRef,
    ClaimProvenance,
    Decision,
    DecisionReason,
    EligibilityStatus,
    EvidenceSourceKind,
    Finding,
    FollowUpResolution,
    HardBlockerKind,
    HardBlockerRule,
    Job,
    JobCase,
    JobSourceKind,
    JobVersion,
    Outcome,
    QuestionCategory,
    RemotePreference,
    ResumeApprovalStatus,
    ResumeEvidenceVersion,
    ResumeExperienceSelection,
    ResumeReviewEvent,
    ResumeRun,
    ResumeSource,
    ResumeSourceKind,
    ResumeStatus,
    ReviewRequirement,
    ReviewStatus,
    ReviewVersion,
    RuleOperator,
    ScoutMode,
    ScreenEvaluation,
    SearchProfile,
    SearchProfileVersion,
    TrackedApplication,
    VerificationAnswerEvent,
    WebSourceSnapshot,
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
    agent_provider: AgentProvider | None = None
    hard_blockers: tuple[HardBlockerDraft, ...] = ()
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
class HardBlockerDraft:
    """A deterministic rule evaluated before Reviewer is allowed to run."""

    kind: HardBlockerKind
    operator: RuleOperator
    value: str | int | bool
    key: str | None = None


@dataclass(frozen=True, slots=True)
class ResumeSourceDraft:
    repository: str
    kind: ResumeSourceKind
    document_path: str = "roleloop_contract/v1/cli.py"
    ref: str | None = None
    trust_repository: bool = False


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
    contract_schema_version: str | None = None
    canonical_evidence_bytes: bytes | None = None
    canonical_evidence_media_type: str = "application/json"
    source_bundle_bytes: bytes | None = None
    source_bundle_media_type: str = "application/octet-stream"
    renderer_protocol_version: str | None = None
    renderer_version: str | None = None
    contract_checksum: str | None = None


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


@dataclass(frozen=True, slots=True)
class WebSourceDraft:
    url: str
    source_kind: JobSourceKind
    title: str = ""
    publisher: str = ""
    quoted_evidence: str = ""
    content: bytes | None = None
    media_type: str = "text/html"
    extension: str = ".html"


@dataclass(frozen=True, slots=True)
class DiscoveredJob:
    url: str
    details: JobDetails
    sources: tuple[WebSourceDraft, ...] = ()


@dataclass(frozen=True, slots=True)
class ScoutContext:
    profile: SearchProfile
    profile_version: SearchProfileVersion
    mode: ScoutMode
    requested_url: str | None
    limit: int


@dataclass(frozen=True, slots=True)
class ScoutReport:
    candidates: tuple[DiscoveredJob, ...]
    audit: AgentAudit = field(default_factory=lambda: AgentAudit())


@dataclass(frozen=True, slots=True)
class ReviewerContext:
    profile: SearchProfile
    profile_version: SearchProfileVersion
    hard_blockers: tuple[HardBlockerRule, ...]
    evidence: ResumeEvidenceVersion
    job: Job
    job_version: JobVersion
    sources: tuple[WebSourceSnapshot, ...]
    latest_answers: Mapping[str, Answer]
    screen_evaluations: tuple[ScreenEvaluation, ...]


@dataclass(frozen=True, slots=True)
class ReviewerReport:
    match_evidence: tuple[Finding, ...]
    skeptic_findings: tuple[Finding, ...]
    questions: tuple[AnalysisQuestion, ...]
    recommended_decision: Decision
    requirements: tuple[ReviewRequirement, ...] = ()
    confidence: float = 0.0
    positioning: str = ""
    self_critique: str = ""
    audit: AgentAudit = field(default_factory=lambda: AgentAudit())


@dataclass(frozen=True, slots=True)
class ResumeSelectionContext:
    profile: SearchProfile
    profile_version: SearchProfileVersion
    evidence: ResumeEvidenceVersion
    job: Job
    job_version: JobVersion
    review: ReviewVersion
    answers: Mapping[str, Answer]
    parent_resume_run: ResumeRun | None = None
    feedback: str = ""


@dataclass(frozen=True, slots=True)
class ResumeSelection:
    """Selection-only Resume-agent output; master facts may not be rewritten."""

    headline: str
    experiences: tuple[ResumeExperienceSelection, ...]
    skill_ids: tuple[str, ...]
    audit: AgentAudit = field(default_factory=lambda: AgentAudit())


@dataclass(frozen=True, slots=True)
class MasterResumeRenderRequest:
    evidence: ResumeEvidenceVersion
    selection: ResumeSelection
    job_version: JobVersion
    profile_version: SearchProfileVersion


@dataclass(frozen=True, slots=True)
class MasterResumeRenderResult:
    pdf: bytes
    receipt: bytes
    renderer_version: str
    tailored_source_bundle: bytes
    selection_file: bytes
    review_file: bytes
    compile_log: bytes
    page_count: int
    ats_text: str
    tool_versions: Mapping[str, str]
    output_checksums: Mapping[str, str]
    renderer_source_revision: str
    media_type: str = "application/pdf"
    extension: str = ".pdf"


@dataclass(frozen=True, slots=True)
class PdfInspection:
    valid: bool
    page_count: int
    media_type: str
    errors: tuple[str, ...] = ()
    extracted_text: str = ""


@dataclass(frozen=True, slots=True)
class RuntimeCheck:
    capability: str
    available: bool
    detail: str = ""


@dataclass(frozen=True, slots=True)
class RuntimeReadiness:
    checks: tuple[RuntimeCheck, ...]

    @property
    def ready(self) -> bool:
        return all(check.available for check in self.checks)


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
    profile_version: SearchProfileVersion | None = None


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
    profile_version: SearchProfileVersion | None = None
    job_version: JobVersion | None = None
    answer_history: tuple[VerificationAnswerEvent, ...] = ()
    screen_evaluations: tuple[ScreenEvaluation, ...] = ()
    resume_approval_status: ResumeApprovalStatus = ResumeApprovalStatus.NONE
    sources: tuple[WebSourceSnapshot, ...] = ()


@dataclass(frozen=True, slots=True)
class DecisionResult:
    case: JobCase
    reason: DecisionReason
    resume_run: ResumeRun | None = None


@dataclass(frozen=True, slots=True)
class ResumeRunView:
    run: ResumeRun
    status: ResumeStatus
    is_current: bool


@dataclass(frozen=True, slots=True)
class ResumeCaseView:
    runs: tuple[ResumeRun, ...]
    review_events: tuple[ResumeReviewEvent, ...]
    latest_run: ResumeRun | None
    latest_artifact_id: str | None
    approval_status: ResumeApprovalStatus


@dataclass(frozen=True, slots=True)
class ProviderStatusView:
    profile_version: SearchProfileVersion
    capabilities: Mapping[str, bool]
    readiness: RuntimeReadiness | None = None
    agent_configurations: tuple[AgentConfiguration, ...] = ()


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
    key: str
    source_anchor: str = ""


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
class AgentAudit:
    """Sanitized provider metadata; raw payloads and hidden reasoning are forbidden."""

    provider_response_id: str | None = None
    response_model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    source_urls: tuple[str, ...] = ()
    prompt_hash: str = ""
    output_schema_hash: str = ""
    status: AgentRunStatus = AgentRunStatus.SUCCEEDED
    sanitized_error_code: str | None = None
    sanitized_error_message: str | None = None
    status_detail: str = ""


@dataclass(frozen=True, slots=True)
class AgentDescriptor:
    provider: AgentProvider
    model: str
    prompt_version: str
    output_schema_version: str
    prompt_hash: str
    output_schema_hash: str


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
class TimelineEvent:
    id: str
    event_type: str
    occurred_at: datetime
    actor: str
    entity_type: str
    entity_id: str
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class UnifiedHistoryView:
    job: Job
    case: JobCase
    events: tuple[TimelineEvent, ...]


@dataclass(frozen=True, slots=True)
class StoredArtifact:
    ref: ArtifactRef


@dataclass(frozen=True, slots=True)
class ArtifactPayload:
    ref: ArtifactRef
    data: bytes


@dataclass(frozen=True, slots=True)
class ApplicationView:
    application: TrackedApplication
    stages: tuple[ApplicationStageEvent, ...]
    open_follow_up: ApplicationFollowUp | None
    follow_up_history: tuple[ApplicationFollowUp, ...]
    follow_up_resolutions: tuple[FollowUpResolution, ...]
    job: Job | None = None
    case: JobCase | None = None


@dataclass(frozen=True, slots=True)
class SubmitApplicationDraft:
    submitted_at: datetime | None = None
    follow_up_at: datetime | None = None
    follow_up_note: str = ""


@dataclass(frozen=True, slots=True)
class ApplicationStageDraft:
    stage: ApplicationStage
    occurred_at: datetime | None = None
    note: str = ""
    follow_up_at: datetime | None = None
    follow_up_note: str = ""
    no_follow_up: bool = False


@dataclass(frozen=True, slots=True)
class LegacyJobDraft:
    legacy_key: str
    url: str
    details: JobDetails
    decision: Decision = Decision.UNDECIDED
    stage: ApplicationStage | None = None
    event_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class LegacyEventDraft:
    source_key: str
    job_key: str | None
    occurred_at: datetime
    node: str
    event_type: str
    detail: str = ""


@dataclass(frozen=True, slots=True)
class LegacySourceManifest:
    database_name: str
    source_checksum: str
    size_bytes: int
    job_count: int
    event_count: int


@dataclass(frozen=True, slots=True)
class LegacyImportDraft:
    source_checksum: str
    jobs: tuple[LegacyJobDraft, ...]
    source_job_count: int
    source_event_count: int
    sources: tuple[LegacySourceManifest, ...] = ()
    events: tuple[LegacyEventDraft, ...] = ()
    duplicate_urls: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class LegacyImportPreview:
    source_checksum: str
    source_job_count: int
    source_event_count: int
    importable_jobs: int
    duplicate_urls: tuple[str, ...]
    warnings: tuple[str, ...]
    sources: tuple[LegacySourceManifest, ...] = ()
