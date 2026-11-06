"""Framework-independent RoleLoop use cases."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, is_dataclass, replace
from datetime import datetime
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

from roleloop.domain import (
    ActorKind,
    AgentConfiguration,
    AgentKind,
    AgentProvider,
    AgentRun,
    AgentRunStatus,
    Answer,
    ApplicationFollowUp,
    ApplicationStage,
    ApplicationStageEvent,
    ApplicationStatus,
    ApplicationSubmission,
    CaseDecisionEvent,
    CommandReceipt,
    Decision,
    DecisionReason,
    EligibilityStatus,
    EvidenceSourceKind,
    Finding,
    FollowUpResolution,
    FollowUpResolutionKind,
    HardBlockerKind,
    HardBlockerRule,
    Job,
    JobCase,
    JobIdentityKey,
    JobIdentityKind,
    JobSourceKind,
    JobVersion,
    LegacyImportBatch,
    LegacyImportItem,
    LegacyImportSource,
    Outcome,
    OutcomeEvent,
    QuestionCategory,
    ResumeEvidenceVersion,
    ResumeExperienceSelection,
    ResumeReviewDecision,
    ResumeReviewEvent,
    ResumeRun,
    ResumeSource,
    ResumeSourceKind,
    ResumeStage,
    ResumeStatus,
    ReviewQuestion,
    ReviewRequirement,
    ReviewStatus,
    ReviewVersion,
    RuleOperator,
    ScoutCandidate,
    ScoutMode,
    ScoutRun,
    ScreenEvaluation,
    ScreenResult,
    SearchProfile,
    SearchProfileVersion,
    TrackedApplication,
    ValidationSeverity,
    VerificationAnswer,
    VerificationAnswerEvent,
    WebSourceSnapshot,
    WorkflowEvent,
    answer_set_fingerprint,
    authoritative_resume_fingerprint,
    authoritative_review_fingerprint,
    canonicalize_job_url,
    derive_eligibility,
    may_record_application_stage,
    resume_approval_status,
    resume_input_fingerprint,
    resume_status,
    review_fingerprint,
    review_status,
    screen_set_fingerprint,
    stable_fingerprint,
)
from roleloop.domain.git import (
    InvalidGitRef,
    InvalidGitRemote,
    validate_git_ref,
    validate_remote_git_repository,
)
from roleloop.domain.urls import InvalidJobUrl

from .dto import (
    ActiveProfileSummary,
    AgentAudit,
    AgentDescriptor,
    AnalysisQuestion,
    ApplicationStageDraft,
    ApplicationView,
    ArtifactPayload,
    DecisionResult,
    DiscoveredJob,
    EvidenceImport,
    GenerationContext,
    InboxFilters,
    JobDetails,
    JobHistoryView,
    JobInboxItem,
    JobReviewView,
    LegacyImportDraft,
    LegacyImportPreview,
    LegacySourceManifest,
    MasterResumeRenderRequest,
    Page,
    ProfileDraft,
    ProgressUpdate,
    ProviderStatusView,
    ResumeCaseView,
    ResumeSelection,
    ResumeSelectionContext,
    ResumeSourceDraft,
    ResumeSourceSnapshot,
    ReviewContext,
    ReviewerContext,
    ReviewerReport,
    RuntimeCheck,
    RuntimeReadiness,
    ScoutContext,
    ScoutReport,
    SubmitApplicationDraft,
    TimelineEvent,
    UnifiedHistoryView,
    WebSourceDraft,
)
from .errors import (
    ApplicationError,
    ArtifactError,
    InvalidTransitionError,
    NotFoundError,
    ProviderFailureError,
    ProviderUnavailableError,
    RevisionConflictError,
    ValidationError,
)
from .ports import (
    AgentProviderRegistry,
    ArtifactExporter,
    ArtifactReader,
    ArtifactStore,
    Clock,
    DiscoveryProvider,
    EvidenceExtractor,
    IdGenerator,
    MasterResumeRenderer,
    NullProgressReporter,
    PdfCompiler,
    PdfInspector,
    ProgressReporter,
    ResumeGenerator,
    ResumeSourceSynchronizer,
    ResumeValidator,
    ReviewAnalyzer,
    RuntimeDoctor,
    UnitOfWork,
    UnitOfWorkFactory,
)

_ProviderT = TypeVar("_ProviderT")


class RoleLoopService:
    """Application facade shared by the CLI and Textual adapters."""

    def __init__(
        self,
        uow_factory: UnitOfWorkFactory,
        clock: Clock,
        ids: IdGenerator,
        *,
        discovery: DiscoveryProvider | None = None,
        analyzer: ReviewAnalyzer | None = None,
        generator: ResumeGenerator | None = None,
        validator: ResumeValidator | None = None,
        compiler: PdfCompiler | None = None,
        evidence_extractor: EvidenceExtractor | None = None,
        artifact_store: ArtifactStore | None = None,
        resume_source_synchronizer: ResumeSourceSynchronizer | None = None,
        agent_registry: AgentProviderRegistry | None = None,
        master_resume_renderer: MasterResumeRenderer | None = None,
        pdf_inspector: PdfInspector | None = None,
        artifact_reader: ArtifactReader | None = None,
        artifact_exporter: ArtifactExporter | None = None,
        runtime_doctor: RuntimeDoctor | None = None,
    ) -> None:
        self._uow_factory = uow_factory
        self._clock = clock
        self._ids = ids
        self._discovery = discovery
        self._analyzer = analyzer
        self._generator = generator
        self._validator = validator
        self._compiler = compiler
        self._evidence_extractor = evidence_extractor
        self._artifact_store = artifact_store
        self._resume_source_synchronizer = resume_source_synchronizer
        self._agent_registry = agent_registry
        self._master_resume_renderer = master_resume_renderer
        self._pdf_inspector = pdf_inspector
        self._artifact_reader = artifact_reader
        self._artifact_exporter = artifact_exporter
        self._runtime_doctor = runtime_doctor

    @property
    def provider_capabilities(self) -> dict[str, bool]:
        registry_available = _provider_is_available(self._agent_registry)
        renderer_available = _provider_is_available(self._master_resume_renderer)
        inspector_available = _provider_is_available(self._pdf_inspector)
        return {
            "discovery": _provider_is_available(self._discovery) or registry_available,
            "review": _provider_is_available(self._analyzer) or registry_available,
            "resume_generation": _provider_is_available(self._generator) or registry_available,
            "resume_validation": _provider_is_available(self._validator)
            or (renderer_available and inspector_available),
            "pdf_compilation": _provider_is_available(self._compiler) or renderer_available,
            "evidence_extraction": _provider_is_available(self._evidence_extractor),
            "artifact_storage": _provider_is_available(self._artifact_store),
            "resume_source_sync": _provider_is_available(self._resume_source_synchronizer)
            and _provider_is_available(self._artifact_store),
            "agent_registry": registry_available,
            "master_resume_renderer": renderer_available,
            "pdf_inspection": inspector_available,
            "artifact_read": _provider_is_available(self._artifact_reader),
            "artifact_export": _provider_is_available(self._artifact_exporter),
            "runtime_doctor": _provider_is_available(self._runtime_doctor),
        }

    # Profiles and evidence -------------------------------------------------

    def create_profile(
        self, draft: ProfileDraft, *, command_id: str | None = None
    ) -> SearchProfile:
        draft = _validated_profile_draft(draft)
        request_fingerprint = _request_fingerprint("profile.create", draft=draft)
        now = self._clock.now()
        with self._uow_factory() as uow:
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "profile.create", request_fingerprint)
                    existing = uow.profiles.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent profile result was not found")
                    return existing
            first_profile = uow.profiles.get_active() is None
            profile_id = self._ids.new()
            version_id = self._ids.new()
            profile = SearchProfile(
                id=profile_id,
                name=draft.name,
                target_roles=draft.target_roles,
                locations=draft.locations,
                remote_preference=draft.remote_preference,
                employment_types=draft.employment_types,
                seniority=draft.seniority,
                annual_salary_floor=draft.annual_salary_floor,
                salary_currency=draft.salary_currency,
                include_keywords=draft.include_keywords,
                exclude_keywords=draft.exclude_keywords,
                constraints=draft.constraints,
                residence_country=draft.residence_country,
                timezone=draft.timezone,
                target_hq_countries=draft.target_hq_countries,
                startup_required=draft.startup_required,
                accepted_remote_arrangements=draft.accepted_remote_arrangements,
                accepted_hiring_arrangements=draft.accepted_hiring_arrangements,
                search_queries=draft.search_queries,
                paper_size=draft.paper_size,
                page_limit=draft.page_limit,
                agent_configurations=(),
                is_active=first_profile,
                created_at=now,
                updated_at=now,
            )
            uow.profiles.add(profile)
            version, rules = self._profile_version(
                profile_id,
                version_id,
                1,
                draft,
                now,
            )
            uow.profile_versions.add(version, rules)
            profile = replace(
                profile,
                current_version_id=version.id,
                agent_configurations=version.agent_configurations,
            )
            if not uow.profiles.update(profile, expected_revision=profile.revision):
                raise RevisionConflictError(
                    "profile changed while its initial version was activated"
                )
            self._event(
                uow,
                profile.id,
                "profile.created",
                metadata={"name": profile.name, "active": first_profile},
            )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "profile.create",
                        "profile",
                        profile.id,
                        now,
                        request_fingerprint,
                    )
                )
            uow.commit()
            return profile

    def update_profile(
        self,
        profile_id: str,
        draft: ProfileDraft,
        *,
        expected_revision: int,
        command_id: str | None = None,
    ) -> SearchProfile:
        draft = _validated_profile_draft(draft)
        # A revision is an execution precondition, not part of the semantic command.
        # Excluding it lets an accepted command replay after its own write advanced
        # the revision while the first execution still checks it below.
        request_fingerprint = _request_fingerprint(
            "profile.update",
            profile_id=profile_id,
            draft=draft,
        )
        with self._uow_factory() as uow:
            current = self._require_profile(uow, profile_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "profile.update", request_fingerprint)
                    if receipt.result_id != profile_id:
                        raise ValidationError("command ID was already used for another profile")
                    return current
            self._check_revision(current.revision, expected_revision, "profile")
            versions = tuple(uow.profile_versions.list_for_profile(profile_id))
            version, rules = self._profile_version(
                profile_id,
                self._ids.new(),
                len(versions) + 1,
                draft,
                self._clock.now(),
            )
            uow.profile_versions.add(version, rules)
            updated = replace(
                current,
                name=draft.name,
                target_roles=draft.target_roles,
                locations=draft.locations,
                remote_preference=draft.remote_preference,
                employment_types=draft.employment_types,
                seniority=draft.seniority,
                annual_salary_floor=draft.annual_salary_floor,
                salary_currency=draft.salary_currency,
                include_keywords=draft.include_keywords,
                exclude_keywords=draft.exclude_keywords,
                constraints=draft.constraints,
                current_version_id=version.id,
                residence_country=draft.residence_country,
                timezone=draft.timezone,
                target_hq_countries=draft.target_hq_countries,
                startup_required=draft.startup_required,
                accepted_remote_arrangements=draft.accepted_remote_arrangements,
                accepted_hiring_arrangements=draft.accepted_hiring_arrangements,
                search_queries=draft.search_queries,
                paper_size=draft.paper_size,
                page_limit=draft.page_limit,
                agent_configurations=version.agent_configurations,
                revision=current.revision + 1,
                updated_at=self._clock.now(),
            )
            if not uow.profiles.update(updated, expected_revision=expected_revision):
                raise RevisionConflictError("profile was changed by another operation")
            self._event(uow, profile_id, "profile.updated")
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "profile.update",
                        "profile",
                        profile_id,
                        self._clock.now(),
                        request_fingerprint,
                    )
                )
            uow.commit()
            return updated

    def list_profiles(self) -> tuple[SearchProfile, ...]:
        with self._uow_factory() as uow:
            return tuple(uow.profiles.list())

    def activate_profile(self, profile_id: str, *, command_id: str | None = None) -> SearchProfile:
        request_fingerprint = _request_fingerprint("profile.activate", profile_id=profile_id)
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "profile.activate", request_fingerprint)
                    if receipt.result_id != profile_id:
                        raise ValidationError("command ID was already used for another profile")
                    active = self._require_profile(uow, profile_id)
                    return replace(active, is_active=True)
            if not uow.profiles.set_active(profile_id, at=self._clock.now()):
                raise RevisionConflictError("profile could not be activated")
            self._event(uow, profile_id, "profile.activated")
            active = self._require_profile(uow, profile_id)
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "profile.activate",
                        "profile",
                        profile_id,
                        self._clock.now(),
                        request_fingerprint,
                    )
                )
            uow.commit()
            return replace(active, is_active=True)

    def get_active_profile_summary(self) -> ActiveProfileSummary | None:
        with self._uow_factory() as uow:
            profile = uow.profiles.get_active()
            if profile is None:
                return None
            evidence = (
                uow.evidence.get(profile.active_evidence_version_id)
                if profile.active_evidence_version_id
                else None
            )
            return ActiveProfileSummary(
                profile=profile,
                evidence=evidence,
                provider_capabilities=self.provider_capabilities,
                resume_source=uow.resume_sources.get_for_profile(profile.id),
                profile_version=uow.profile_versions.get_current(profile.id),
            )

    async def import_evidence(
        self, profile_id: str, request: EvidenceImport
    ) -> ResumeEvidenceVersion:
        extractor = self._require_provider(self._evidence_extractor, "evidence extraction")
        store = self._require_provider(self._artifact_store, "artifact storage")
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            expected_revision = profile.revision

        _validate_evidence_import(request)
        try:
            extracted = await extractor.extract(request)
        except ApplicationError:
            raise
        except Exception as exc:
            raise ProviderFailureError(
                f"evidence extraction failed: {exc}",
                details={"provider": "evidence_extraction"},
            ) from exc
        if not extracted.extracted_text.strip():
            raise ArtifactError(
                "no résumé text could be extracted; scanned PDFs require OCR, "
                "which RoleLoop does not perform"
            )
        if not extracted.source_bytes:
            raise ArtifactError("the imported résumé source is empty")
        try:
            source_artifact = await store.put_bytes(
                extracted.source_bytes,
                media_type=extracted.media_type,
                extension=extracted.extension,
            )
        except ApplicationError:
            raise
        except Exception as exc:
            raise ArtifactError(f"could not preserve résumé evidence: {exc}") from exc

        now = self._clock.now()
        evidence = ResumeEvidenceVersion(
            id=self._ids.new(),
            profile_id=profile_id,
            source_kind=extracted.source_kind,
            source_name=extracted.source_name,
            source_artifact=source_artifact,
            extracted_text=extracted.extracted_text,
            created_at=now,
        )
        with self._uow_factory() as uow:
            current = self._require_profile(uow, profile_id)
            self._check_revision(current.revision, expected_revision, "profile")
            uow.artifacts.add(source_artifact)
            uow.evidence.add(evidence)
            updated = replace(
                current,
                active_evidence_version_id=evidence.id,
                revision=current.revision + 1,
                updated_at=now,
            )
            if not uow.profiles.update(updated, expected_revision=expected_revision):
                raise RevisionConflictError(
                    "profile changed while résumé evidence was being imported"
                )
            self._event(
                uow,
                profile_id,
                "evidence.imported",
                metadata={
                    "evidence_version_id": evidence.id,
                    "checksum": source_artifact.checksum,
                    "source_name": evidence.source_name,
                },
            )
            uow.commit()
        return evidence

    def configure_resume_source(
        self,
        profile_id: str,
        draft: ResumeSourceDraft,
        *,
        expected_revision: int | None = None,
        command_id: str | None = None,
    ) -> ResumeSource:
        """Create or update the one master-résumé source assigned to a profile."""

        draft = _validated_resume_source_draft(draft)
        # The adapter may derive this precondition from current state. It must not
        # change the identity of an otherwise identical idempotent replay.
        request_fingerprint = _request_fingerprint(
            "resume_source.configure",
            profile_id=profile_id,
            draft=draft,
        )
        now = self._clock.now()
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(
                        receipt, "resume_source.configure", request_fingerprint
                    )
                    existing = uow.resume_sources.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent résumé source result was not found")
                    return existing
            current = uow.resume_sources.get_for_profile(profile_id)
            if current is None:
                if expected_revision is not None:
                    self._check_revision(0, expected_revision, "résumé source")
                source = ResumeSource(
                    id=self._ids.new(),
                    profile_id=profile_id,
                    kind=draft.kind,
                    repository=draft.repository,
                    ref=draft.ref or _default_resume_source_ref(draft.kind),
                    document_path=draft.document_path,
                    trust_acknowledged_at=now,
                    created_at=now,
                    updated_at=now,
                )
                uow.resume_sources.add(source)
                event_type = "resume_source.configured"
            else:
                concurrency_revision = (
                    current.revision if expected_revision is None else expected_revision
                )
                self._check_revision(current.revision, concurrency_revision, "résumé source")
                configured_values = (
                    draft.kind,
                    draft.repository,
                    draft.ref or _default_resume_source_ref(draft.kind),
                    draft.document_path,
                )
                current_values = (
                    current.kind,
                    current.repository,
                    current.ref,
                    current.document_path,
                )
                if configured_values == current_values and current.trust_acknowledged_at:
                    if command_id is not None:
                        uow.commands.add(
                            CommandReceipt(
                                command_id,
                                "resume_source.configure",
                                "resume_source",
                                current.id,
                                now,
                                request_fingerprint,
                            )
                        )
                        uow.commit()
                    return current
                source = replace(
                    current,
                    kind=configured_values[0],
                    repository=configured_values[1],
                    ref=configured_values[2],
                    document_path=configured_values[3],
                    trust_acknowledged_at=now,
                    last_synced_revision=None,
                    last_synced_checksum=None,
                    last_synced_evidence_version_id=None,
                    last_synced_at=None,
                    revision=current.revision + 1,
                    updated_at=now,
                )
                if not uow.resume_sources.update(source, expected_revision=concurrency_revision):
                    raise RevisionConflictError("résumé source was changed by another operation")
                event_type = "resume_source.reconfigured"
            self._event(
                uow,
                profile_id,
                event_type,
                metadata={
                    "resume_source_id": source.id,
                    "kind": source.kind.value,
                    "ref": source.ref,
                    "document_path": source.document_path,
                },
            )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "resume_source.configure",
                        "resume_source",
                        source.id,
                        now,
                        request_fingerprint,
                    )
                )
            uow.commit()
            return source

    def get_resume_source(self, profile_id: str) -> ResumeSource | None:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            return uow.resume_sources.get_for_profile(profile_id)

    async def sync_resume_source(
        self,
        profile_id: str,
        *,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> ResumeEvidenceVersion:
        """Resolve a pinned Git snapshot and activate it as immutable evidence."""

        synchronizer = self._require_provider(
            self._resume_source_synchronizer, "résumé source synchronization"
        )
        store = self._require_provider(self._artifact_store, "artifact storage")
        reporter = progress or NullProgressReporter()
        request_fingerprint = _request_fingerprint("resume_source.sync", profile_id=profile_id)
        with self._uow_factory() as uow:
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "resume_source.sync", request_fingerprint)
                    existing = uow.evidence.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent résumé sync result was not found")
                    return existing
            profile = self._require_profile(uow, profile_id)
            source = uow.resume_sources.get_for_profile(profile_id)
            if source is None:
                raise InvalidTransitionError(
                    "configure a master résumé source before synchronizing it"
                )
            if source.trust_acknowledged_at is None:
                raise InvalidTransitionError(
                    "acknowledge repository trust before synchronizing executable contract code"
                )
            expected_profile_revision = profile.revision
            expected_source_revision = source.revision

        reporter.report(
            ProgressUpdate(
                operation="resume_source_sync",
                stage="resolving",
                message="Resolving master résumé snapshot",
            )
        )
        try:
            snapshot = await synchronizer.sync(source, progress=reporter)
        except ApplicationError:
            raise
        except Exception as exc:
            raise ProviderFailureError(
                f"résumé source synchronization failed: {exc}",
                details={"provider": "resume_source_sync"},
            ) from exc
        snapshot = _validated_resume_source_snapshot(snapshot)

        with self._uow_factory() as uow:
            current_profile = self._require_profile(uow, profile_id)
            current_source = uow.resume_sources.get_for_profile(profile_id)
            if current_source is None:
                raise RevisionConflictError(
                    "résumé source was removed while synchronization was running"
                )
            self._check_revision(current_source.revision, expected_source_revision, "résumé source")
            self._check_revision(current_profile.revision, expected_profile_revision, "profile")
            existing_evidence = _matching_synced_evidence(
                uow,
                source=current_source,
                snapshot=snapshot,
            )
            if existing_evidence is not None:
                now = self._clock.now()
                source_changed = (
                    current_source.last_synced_revision != snapshot.source_revision
                    or current_source.last_synced_checksum != snapshot.content_checksum
                    or current_source.last_synced_evidence_version_id != existing_evidence.id
                )
                if source_changed:
                    refreshed_source = replace(
                        current_source,
                        last_synced_revision=snapshot.source_revision,
                        last_synced_checksum=snapshot.content_checksum,
                        last_synced_evidence_version_id=existing_evidence.id,
                        last_synced_at=now,
                        revision=current_source.revision + 1,
                        updated_at=now,
                    )
                    if not uow.resume_sources.update(
                        refreshed_source, expected_revision=current_source.revision
                    ):
                        raise RevisionConflictError(
                            "résumé source changed while an existing snapshot was activated"
                        )
                if current_profile.active_evidence_version_id == existing_evidence.id:
                    if command_id is not None:
                        uow.commands.add(
                            CommandReceipt(
                                command_id,
                                "resume_source.sync",
                                "evidence_version",
                                existing_evidence.id,
                                now,
                                request_fingerprint,
                            )
                        )
                    if source_changed or command_id is not None:
                        uow.commit()
                    reporter.report(
                        ProgressUpdate(
                            operation="resume_source_sync",
                            stage="complete",
                            message="Master résumé is already current",
                        )
                    )
                    return existing_evidence
                activated_profile = replace(
                    current_profile,
                    active_evidence_version_id=existing_evidence.id,
                    revision=current_profile.revision + 1,
                    updated_at=now,
                )
                if not uow.profiles.update(
                    activated_profile,
                    expected_revision=current_profile.revision,
                ):
                    raise RevisionConflictError(
                        "profile changed while résumé evidence was being activated"
                    )
                self._event(
                    uow,
                    profile_id,
                    "resume_source.activated",
                    metadata={
                        "resume_source_id": current_source.id,
                        "evidence_version_id": existing_evidence.id,
                        "source_revision": snapshot.source_revision,
                    },
                )
                if command_id is not None:
                    uow.commands.add(
                        CommandReceipt(
                            command_id,
                            "resume_source.sync",
                            "evidence_version",
                            existing_evidence.id,
                            now,
                            request_fingerprint,
                        )
                    )
                uow.commit()
                reporter.report(
                    ProgressUpdate(
                        operation="resume_source_sync",
                        stage="complete",
                        message="Master résumé snapshot activated",
                    )
                )
                return existing_evidence

        try:
            source_artifact = await store.put_bytes(
                snapshot.source_bytes,
                media_type=snapshot.media_type,
                extension=snapshot.extension,
            )
            assert snapshot.canonical_evidence_bytes is not None
            canonical_artifact = await store.put_bytes(
                snapshot.canonical_evidence_bytes,
                media_type=snapshot.canonical_evidence_media_type,
                extension=".json",
            )
            assert snapshot.source_bundle_bytes is not None
            bundle_artifact = await store.put_bytes(
                snapshot.source_bundle_bytes,
                media_type=snapshot.source_bundle_media_type,
                extension=".tar",
            )
        except ApplicationError:
            raise
        except Exception as exc:
            raise ArtifactError(f"could not preserve master résumé snapshot: {exc}") from exc
        if source_artifact.checksum != snapshot.content_checksum:
            raise ArtifactError(
                "artifact storage checksum does not match the synchronized résumé snapshot"
            )

        now = self._clock.now()
        evidence = ResumeEvidenceVersion(
            id=self._ids.new(),
            profile_id=profile_id,
            source_kind=(
                EvidenceSourceKind.PDF
                if snapshot.media_type.partition(";")[0].strip().lower() == "application/pdf"
                else EvidenceSourceKind.TEXT_FILE
            ),
            source_name=snapshot.source_name,
            source_artifact=source_artifact,
            extracted_text=snapshot.extracted_text,
            created_at=now,
            resume_source_id=source.id,
            source_revision=snapshot.source_revision,
            resume_source_kind=source.kind,
            source_repository=source.repository,
            source_ref=source.ref,
            source_document_path=source.document_path,
            contract_schema_version=snapshot.contract_schema_version,
            canonical_evidence_artifact=canonical_artifact,
            source_bundle_artifact=bundle_artifact,
            renderer_protocol_version=snapshot.renderer_protocol_version,
            renderer_version=snapshot.renderer_version,
            contract_checksum=snapshot.contract_checksum,
        )
        with self._uow_factory() as uow:
            current_profile = self._require_profile(uow, profile_id)
            current_source = uow.resume_sources.get_for_profile(profile_id)
            if current_source is None:
                raise RevisionConflictError(
                    "résumé source was removed while synchronization was running"
                )
            self._check_revision(current_source.revision, expected_source_revision, "résumé source")
            self._check_revision(current_profile.revision, expected_profile_revision, "profile")
            for artifact in (source_artifact, canonical_artifact, bundle_artifact):
                uow.artifacts.add(artifact)
            uow.evidence.add(evidence)
            synced_source = replace(
                current_source,
                last_synced_revision=snapshot.source_revision,
                last_synced_checksum=snapshot.content_checksum,
                last_synced_evidence_version_id=evidence.id,
                last_synced_at=now,
                revision=current_source.revision + 1,
                updated_at=now,
            )
            if not uow.resume_sources.update(
                synced_source, expected_revision=current_source.revision
            ):
                raise RevisionConflictError(
                    "résumé source changed while its snapshot was being saved"
                )
            activated_profile = replace(
                current_profile,
                active_evidence_version_id=evidence.id,
                revision=current_profile.revision + 1,
                updated_at=now,
            )
            if not uow.profiles.update(
                activated_profile, expected_revision=current_profile.revision
            ):
                raise RevisionConflictError("profile changed while résumé evidence was being saved")
            self._event(
                uow,
                profile_id,
                "resume_source.synced",
                metadata={
                    "resume_source_id": current_source.id,
                    "evidence_version_id": evidence.id,
                    "source_revision": snapshot.source_revision,
                    "checksum": snapshot.content_checksum,
                },
            )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "resume_source.sync",
                        "evidence_version",
                        evidence.id,
                        now,
                        request_fingerprint,
                    )
                )
            uow.commit()
        reporter.report(
            ProgressUpdate(
                operation="resume_source_sync",
                stage="complete",
                message="Master résumé snapshot synchronized",
            )
        )
        return evidence

    # Jobs and inbox --------------------------------------------------------

    def add_job_url(self, profile_id: str, url: str) -> JobCase:
        try:
            canonical_url = canonicalize_job_url(url)
        except (InvalidJobUrl, UnicodeError) as exc:
            raise ValidationError(str(exc)) from exc
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            _, case, created = self._add_job_case(
                uow,
                profile_id,
                canonical_url,
                JobDetails(),
            )
            if created:
                uow.commit()
            return case

    def update_job_details(
        self,
        profile_id: str,
        job_id: str,
        details: JobDetails,
        *,
        expected_revision: int,
    ) -> Job:
        with self._uow_factory() as uow:
            self._require_case_for_job(uow, profile_id, job_id)
            job = self._require_job(uow, job_id)
            self._check_revision(job.revision, expected_revision, "job")
            if self._agent_registry is not None:
                current_version = uow.job_versions.get_current(job_id)
                if current_version is None:
                    raise InvalidTransitionError(
                        "authoritative job corrections require a current immutable version"
                    )
                corrected = _merge_job_correction(job, current_version, details)
                retained_sources = tuple(uow.job_versions.list_sources(current_version.id))
                updated, case, changed = self._add_job_case(
                    uow,
                    profile_id,
                    current_version.canonical_url,
                    corrected,
                    retained_sources,
                )
                if changed:
                    profile_version = uow.profile_versions.get_current(profile_id)
                    corrected_version = uow.job_versions.get_current(job_id)
                    if profile_version is None or corrected_version is None:
                        raise InvalidTransitionError(
                            "corrected job is missing authoritative version inputs"
                        )
                    self._ensure_screens_and_auto_skip(
                        uow,
                        profile_version,
                        corrected_version,
                        case,
                    )
                    uow.commit()
                return updated
            normalized = (
                details.title.strip(),
                details.company.strip(),
                details.location.strip(),
                details.description.strip(),
                details.source.strip() or job.source,
                dict(details.source_metadata),
            )
            current = (
                job.title,
                job.company,
                job.location,
                job.description,
                job.source,
                dict(job.source_metadata),
            )
            if normalized == current:
                return job
            updated = replace(
                job,
                title=normalized[0],
                company=normalized[1],
                location=normalized[2],
                description=normalized[3],
                source=normalized[4],
                source_metadata=normalized[5],
                revision=job.revision + 1,
                updated_at=self._clock.now(),
            )
            if not uow.jobs.update(updated, expected_revision=expected_revision):
                raise RevisionConflictError("job was changed by another operation")
            case = self._require_case_for_job(uow, profile_id, job_id)
            self._event(uow, profile_id, "job.updated", case.id)
            uow.commit()
            return updated

    async def discover_jobs(
        self,
        profile_id: str,
        *,
        limit: int = 20,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> tuple[JobCase, ...]:
        if limit <= 0:
            raise ValidationError("discovery limit must be positive")
        if self._agent_registry is not None:
            return await self._run_scout(
                profile_id,
                mode=ScoutMode.SEARCH,
                requested_url=None,
                limit=limit,
                command_id=command_id,
                progress=progress,
            )
        provider = self._require_provider(self._discovery, "job discovery")
        reporter = progress or NullProgressReporter()
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
        try:
            discovered = await provider.discover(profile, limit=limit, progress=reporter)
        except ApplicationError:
            raise
        except Exception as exc:
            raise ProviderFailureError(
                f"job discovery failed: {exc}",
                details={"provider": "discovery"},
            ) from exc

        prepared: dict[str, JobDetails] = {}
        for item in discovered[:limit]:
            try:
                canonical = canonicalize_job_url(item.url)
            except (InvalidJobUrl, UnicodeError) as exc:
                raise ProviderFailureError(
                    f"discovery provider returned an invalid URL: {item.url!r}"
                ) from exc
            prepared[canonical] = item.details

        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            cases: list[JobCase] = []
            changed = False
            for canonical, details in prepared.items():
                _, case, created = self._add_job_case(uow, profile_id, canonical, details)
                cases.append(case)
                changed = changed or created
            if changed:
                uow.commit()
        reporter.report(
            ProgressUpdate(
                operation="discovery",
                stage="complete",
                message=f"processed {len(cases)} jobs",
                completed=len(cases),
                total=len(cases),
            )
        )
        return tuple(cases)

    async def inspect_job_url(
        self,
        profile_id: str,
        url: str,
        *,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> JobReviewView:
        try:
            canonical_url = canonicalize_job_url(url)
        except (InvalidJobUrl, UnicodeError) as exc:
            raise ValidationError(str(exc)) from exc
        if self._agent_registry is None:
            case = self.add_job_url(profile_id, canonical_url)
            return self.get_job_case(profile_id, case.job_id)
        cases = await self._run_scout(
            profile_id,
            mode=ScoutMode.URL_ENRICHMENT,
            requested_url=canonical_url,
            limit=1,
            command_id=command_id,
            progress=progress,
        )
        if not cases:
            raise ProviderFailureError("Scout did not return the requested job URL")
        return self.get_job_case(profile_id, cases[0].job_id)

    def list_inbox(
        self,
        profile_id: str,
        *,
        filters: InboxFilters | None = None,
        page: Page | None = None,
    ) -> tuple[JobInboxItem, ...]:
        filters = filters or InboxFilters()
        page = page or Page()
        if page.limit <= 0 or page.limit > 500 or page.offset < 0:
            raise ValidationError("page requires 1-500 items and a non-negative offset")
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            items = [
                self._inbox_item(uow, profile_id, case)
                for case in uow.cases.list_for_profile(profile_id)
            ]
        matching = [item for item in items if _matches_filters(item, filters)]
        matching.sort(
            key=lambda item: (item.updated_at is not None, item.updated_at, item.job_id),
            reverse=True,
        )
        return tuple(matching[page.offset : page.offset + page.limit])

    def get_job_case(self, profile_id: str, job_id: str) -> JobReviewView:
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            return self._job_review_view(uow, profile, job, case)

    def get_history(self, profile_id: str, job_id: str) -> JobHistoryView:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            return JobHistoryView(
                job=job,
                case=case,
                events=tuple(uow.events.list_for_case(case.id)),
            )

    def get_profile_version(self, profile_id: str) -> SearchProfileVersion:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            version = uow.profile_versions.get_current(profile_id)
            if version is None:
                raise NotFoundError("current profile version was not found")
            return version

    async def check_runtime(self, profile_id: str | None = None) -> RuntimeReadiness:
        doctor = self._require_provider(self._runtime_doctor, "runtime doctor")
        with self._uow_factory() as uow:
            profile = (
                uow.profiles.get_active()
                if profile_id is None
                else self._require_profile(uow, profile_id)
            )
            version = None if profile is None else uow.profile_versions.get_current(profile.id)
            source = None if profile is None else uow.resume_sources.get_for_profile(profile.id)
            evidence = (
                None
                if profile is None or profile.active_evidence_version_id is None
                else uow.evidence.get(profile.active_evidence_version_id)
            )
        provider_readiness = await doctor.check(version)
        if profile is None:
            return provider_readiness
        source_checks = _resume_source_runtime_checks(source, evidence)
        return RuntimeReadiness((*provider_readiness.checks, *source_checks))

    async def get_provider_status(self, profile_id: str | None = None) -> ProviderStatusView | None:
        with self._uow_factory() as uow:
            profile = (
                uow.profiles.get_active()
                if profile_id is None
                else self._require_profile(uow, profile_id)
            )
            if profile is None:
                return None
            version = uow.profile_versions.get_current(profile.id)
            if version is None:
                raise NotFoundError("current profile version was not found")
        readiness = (
            None if self._runtime_doctor is None else await self._runtime_doctor.check(version)
        )
        return ProviderStatusView(
            version,
            self.provider_capabilities,
            readiness,
            version.agent_configurations,
        )

    async def get_artifact(self, artifact_id: str) -> ArtifactPayload:
        reader = self._require_provider(self._artifact_reader, "artifact reading")
        with self._uow_factory() as uow:
            artifact = uow.artifacts.get(artifact_id)
            if artifact is None:
                raise NotFoundError("artifact was not found")
        data = await reader.read_bytes(artifact)
        if len(artifact.checksum) == 64 and hashlib.sha256(data).hexdigest() != artifact.checksum:
            raise ArtifactError("artifact content no longer matches its checksum")
        return ArtifactPayload(artifact, data)

    async def export_artifact(self, artifact_id: str, destination: Path) -> Path:
        exporter = self._require_provider(self._artifact_exporter, "artifact export")
        with self._uow_factory() as uow:
            artifact = uow.artifacts.get(artifact_id)
            if artifact is None:
                raise NotFoundError("artifact was not found")
        return await exporter.export(artifact, destination)

    def get_unified_history(self, profile_id: str, job_id: str) -> UnifiedHistoryView:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            timeline: list[TimelineEvent] = [
                TimelineEvent(
                    item.id,
                    item.event_type,
                    item.occurred_at,
                    "system",
                    "workflow_event",
                    item.id,
                    item.metadata,
                )
                for item in uow.events.list_for_case(case.id)
            ]
            timeline.extend(
                TimelineEvent(
                    item.id,
                    "verification.answer",
                    item.recorded_at or self._clock.now(),
                    item.actor.value,
                    "verification_answer_event",
                    item.id,
                    {"question_key": item.question_key, "answer": item.answer.value},
                )
                for item in uow.answer_events.list_for_case(case.id)
            )
            timeline.extend(
                TimelineEvent(
                    item.id,
                    "decision.recorded",
                    item.decided_at or self._clock.now(),
                    item.actor.value,
                    "case_decision_event",
                    item.id,
                    {"decision": item.decision.value, "reason": item.reason.value},
                )
                for item in uow.decision_events.list_for_case(case.id)
            )
            reviews = tuple(uow.reviews.list_for_case(case.id))
            timeline.extend(
                TimelineEvent(
                    item.id,
                    "review.completed",
                    item.created_at,
                    "agent",
                    "review_version",
                    item.id,
                    {"recommendation": item.recommended_decision.value},
                )
                for item in reviews
            )
            runs = tuple(uow.resume_runs.list_for_case(case.id))
            timeline.extend(
                TimelineEvent(
                    item.id,
                    f"resume.{item.stage.value}",
                    item.updated_at or item.created_at or self._clock.now(),
                    "agent",
                    "resume_run",
                    item.id,
                    {"parent_resume_run_id": item.parent_resume_run_id},
                )
                for item in runs
            )
            for run in runs:
                timeline.extend(
                    TimelineEvent(
                        item.id,
                        f"resume_review.{item.decision.value}",
                        item.created_at or self._clock.now(),
                        item.actor.value,
                        "resume_review_event",
                        item.id,
                        {"resume_run_id": run.id, "feedback": item.feedback},
                    )
                    for item in uow.resume_reviews.list_for_run(run.id)
                )
            application = uow.tracked_applications.get_for_case(case.id)
            if application is not None:
                stages = tuple(uow.tracked_applications.list_stages(application.id))
                timeline.extend(
                    TimelineEvent(
                        item.id,
                        f"application.{item.stage.value}",
                        item.occurred_at,
                        item.actor.value,
                        "application_stage_event",
                        item.id,
                        {"note": item.note},
                    )
                    for item in stages
                )
                for follow_up in uow.follow_ups.list_for_application(application.id):
                    timeline.append(
                        TimelineEvent(
                            follow_up.id,
                            "follow_up.scheduled",
                            follow_up.created_at or self._clock.now(),
                            "human",
                            "application_follow_up",
                            follow_up.id,
                            {"due_at": follow_up.due_at.isoformat()},
                        )
                    )
                    timeline.extend(
                        TimelineEvent(
                            resolution.id,
                            f"follow_up.{resolution.disposition.value}",
                            resolution.resolved_at or self._clock.now(),
                            "human",
                            "follow_up_resolution",
                            resolution.id,
                            {"follow_up_id": follow_up.id},
                        )
                        for resolution in uow.follow_ups.list_resolutions(follow_up.id)
                    )
            timeline.sort(key=lambda item: (item.occurred_at, item.id))
            return UnifiedHistoryView(job, case, tuple(timeline))

    def preview_legacy_import(self, draft: LegacyImportDraft) -> LegacyImportPreview:
        sources = _validated_legacy_sources(draft.sources)
        checksum = stable_fingerprint(
            databases=tuple(
                (
                    source.database_name,
                    source.source_checksum,
                    source.size_bytes,
                    source.job_count,
                    source.event_count,
                )
                for source in sources
            )
        )
        supplied_checksum = draft.source_checksum.strip().lower()
        if supplied_checksum and supplied_checksum != checksum:
            raise ValidationError(
                "legacy aggregate checksum does not match the two database manifests"
            )
        if sum(source.job_count for source in sources) != draft.source_job_count:
            raise ValidationError("legacy database job counts do not match the aggregate job count")
        if sum(source.event_count for source in sources) != draft.source_event_count:
            raise ValidationError(
                "legacy database event counts do not match the aggregate event count"
            )
        unique_urls: set[str] = set()
        duplicate_urls = set(draft.duplicate_urls)
        importable = 0
        warnings: list[str] = []
        for item in draft.jobs:
            try:
                canonical = canonicalize_job_url(item.url)
            except (InvalidJobUrl, UnicodeError):
                warnings.append(f"Invalid legacy URL for {item.legacy_key}")
                continue
            if canonical in unique_urls:
                duplicate_urls.add(canonical)
            else:
                unique_urls.add(canonical)
                importable += 1
        if draft.source_job_count != len(draft.jobs):
            raise ValidationError("legacy manifest job count must equal the detailed job rows")
        if draft.source_event_count != len(draft.events):
            raise ValidationError("legacy manifest event count must equal the detailed event rows")
        return LegacyImportPreview(
            source_checksum=checksum,
            source_job_count=draft.source_job_count,
            source_event_count=draft.source_event_count,
            importable_jobs=importable,
            duplicate_urls=tuple(sorted(duplicate_urls)),
            warnings=tuple(warnings),
            sources=sources,
        )

    def apply_legacy_import(
        self,
        profile_id: str,
        draft: LegacyImportDraft,
        *,
        command_id: str | None = None,
    ) -> LegacyImportBatch:
        preview = self.preview_legacy_import(draft)
        request_fingerprint = _request_fingerprint(
            "legacy.import", profile_id=profile_id, draft=draft
        )
        effective_command_id = command_id or self._ids.new()
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "legacy.import", request_fingerprint)
                    existing = uow.legacy_imports.get_by_checksum(
                        profile_id, preview.source_checksum
                    )
                    if existing is None or receipt.result_id != existing.id:
                        raise NotFoundError("legacy import receipt exists without its batch")
                    return existing
            existing = uow.legacy_imports.get_by_checksum(profile_id, preview.source_checksum)
            if existing is not None:
                if command_id is not None:
                    uow.commands.add(
                        CommandReceipt(
                            command_id,
                            "legacy.import",
                            "legacy_import_batch",
                            existing.id,
                            self._clock.now(),
                            request_fingerprint,
                        )
                    )
                    uow.commit()
                return existing
            now = self._clock.now()
            batch = LegacyImportBatch(
                id=self._ids.new(),
                command_id=effective_command_id,
                profile_id=profile_id,
                source_checksum=preview.source_checksum,
                imported_jobs=preview.importable_jobs,
                imported_events=len(draft.events),
                created_at=now,
                sources=tuple(
                    LegacyImportSource(
                        batch_id="",
                        position=position,
                        database_name=source.database_name,
                        source_checksum=source.source_checksum,
                        size_bytes=source.size_bytes,
                        job_count=source.job_count,
                        event_count=source.event_count,
                    )
                    for position, source in enumerate(preview.sources)
                ),
            )
            batch = replace(
                batch,
                sources=tuple(replace(source, batch_id=batch.id) for source in batch.sources),
            )
            uow.legacy_imports.add(batch)
            cases_by_key: dict[str, JobCase] = {}
            legacy_created_job_ids: set[str] = set()
            legacy_created_case_ids: set[str] = set()
            for item in draft.jobs:
                try:
                    canonical = canonicalize_job_url(item.url)
                except (InvalidJobUrl, UnicodeError):
                    continue
                job, case, created_job, created_case = self._add_legacy_job_case(
                    uow,
                    profile_id,
                    canonical,
                    item.details,
                    legacy_created_job_ids,
                )
                if created_job:
                    legacy_created_job_ids.add(job.id)
                if created_case:
                    legacy_created_case_ids.add(case.id)
                cases_by_key[item.legacy_key] = case
                uow.legacy_imports.add_item(
                    LegacyImportItem(batch.id, item.legacy_key, "job", job.id)
                )
                uow.legacy_imports.add_item(
                    LegacyImportItem(batch.id, item.legacy_key, "job_case", case.id)
                )
                snapshot = WorkflowEvent(
                    id=self._ids.new(),
                    event_type="legacy.job_snapshot",
                    occurred_at=item.event_at or now,
                    profile_id=profile_id,
                    job_case_id=case.id,
                    metadata={
                        "legacy_key": item.legacy_key,
                        "canonical_url": canonical,
                        "legacy_unpinned": True,
                        "job_projection_applied": job.id in legacy_created_job_ids,
                        "case_projection_applied": case.id in legacy_created_case_ids,
                        "snapshot_json": json.dumps(
                            _canonical_request_value(item.details),
                            default=str,
                            ensure_ascii=False,
                            separators=(",", ":"),
                            sort_keys=True,
                        ),
                    },
                )
                uow.events.add(snapshot)
                uow.legacy_imports.add_item(
                    LegacyImportItem(
                        batch.id,
                        f"{item.legacy_key}:snapshot",
                        "workflow_event",
                        snapshot.id,
                    )
                )
                if item.decision is not Decision.UNDECIDED:
                    project_legacy_decision = case.id in legacy_created_case_ids
                    decision_event = CaseDecisionEvent(
                        id=self._ids.new(),
                        command_id=self._ids.new(),
                        job_case_id=case.id,
                        decision=item.decision,
                        reason=DecisionReason.LEGACY_UNPINNED,
                        actor=ActorKind.HUMAN,
                        supersedes_decision_event_id=(
                            case.current_decision_event_id if project_legacy_decision else None
                        ),
                        rationale=(
                            "Imported from legacy master repository as non-authoritative history"
                        ),
                        decided_at=item.event_at or now,
                    )
                    uow.decision_events.add(decision_event)
                    if project_legacy_decision:
                        updated_case = replace(
                            case,
                            decision=item.decision,
                            current_decision_event_id=decision_event.id,
                            revision=case.revision + 1,
                            updated_at=item.event_at or now,
                        )
                        if not uow.cases.update(updated_case, expected_revision=case.revision):
                            raise RevisionConflictError("legacy job changed during import")
                        case = updated_case
                        cases_by_key[item.legacy_key] = case
                    uow.legacy_imports.add_item(
                        LegacyImportItem(
                            batch.id,
                            item.legacy_key,
                            "decision",
                            decision_event.id,
                        )
                    )
                if item.stage is not None and uow.tracked_applications.get_for_job(job.id) is None:
                    submitted_at = item.event_at or now
                    application = TrackedApplication(
                        id=self._ids.new(),
                        command_id=self._ids.new(),
                        job_id=job.id,
                        job_case_id=case.id,
                        current_stage=item.stage,
                        approved_resume_review_event_id=None,
                        resume_run_id=None,
                        pdf_artifact_id=None,
                        pdf_checksum=None,
                        job_version_id=None,
                        profile_version_id=None,
                        evidence_version_id=None,
                        review_version_id=None,
                        gate_decision_event_id=None,
                        submitted_at=submitted_at,
                        legacy=True,
                        created_at=submitted_at,
                        updated_at=submitted_at,
                    )
                    stage_event = ApplicationStageEvent(
                        id=self._ids.new(),
                        command_id=self._ids.new(),
                        application_id=application.id,
                        stage=ApplicationStage.SUBMITTED,
                        actor=ActorKind.HUMAN,
                        occurred_at=submitted_at,
                        recorded_at=now,
                        note="Imported legacy application",
                    )
                    uow.tracked_applications.add(application)
                    uow.tracked_applications.add_stage(stage_event)
                    current_stage_event = None
                    if item.stage is not ApplicationStage.SUBMITTED:
                        current_stage_event = ApplicationStageEvent(
                            id=self._ids.new(),
                            command_id=self._ids.new(),
                            application_id=application.id,
                            stage=item.stage,
                            actor=ActorKind.HUMAN,
                            occurred_at=submitted_at,
                            recorded_at=now,
                            note="Imported legacy current stage",
                        )
                        uow.tracked_applications.add_stage(current_stage_event)
                    uow.legacy_imports.add_item(
                        LegacyImportItem(batch.id, item.legacy_key, "application", application.id)
                    )
                    uow.legacy_imports.add_item(
                        LegacyImportItem(batch.id, item.legacy_key, "stage", stage_event.id)
                    )
                    if current_stage_event is not None:
                        uow.legacy_imports.add_item(
                            LegacyImportItem(
                                batch.id,
                                f"{item.legacy_key}:current-stage",
                                "stage",
                                current_stage_event.id,
                            )
                        )
            for event in draft.events:
                event_case = None if event.job_key is None else cases_by_key.get(event.job_key)
                workflow = WorkflowEvent(
                    id=self._ids.new(),
                    event_type=f"legacy.{event.event_type}",
                    occurred_at=event.occurred_at,
                    profile_id=profile_id,
                    job_case_id=None if event_case is None else event_case.id,
                    metadata={
                        "source_key": event.source_key,
                        "node": event.node,
                        "detail": event.detail,
                        "legacy_unpinned": True,
                    },
                )
                uow.events.add(workflow)
                uow.legacy_imports.add_item(
                    LegacyImportItem(
                        batch.id,
                        event.source_key,
                        "workflow_event",
                        workflow.id,
                    )
                )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "legacy.import",
                        "legacy_import_batch",
                        batch.id,
                        now,
                        request_fingerprint,
                    )
                )
            uow.commit()
            return batch

    def _add_legacy_job_case(
        self,
        uow: UnitOfWork,
        profile_id: str,
        canonical_url: str,
        details: JobDetails,
        legacy_created_job_ids: set[str],
    ) -> tuple[Job, JobCase, bool, bool]:
        """Resolve a legacy job without replacing pre-existing native projections."""

        identity_specs = _job_identity_specs(canonical_url, details)
        resolved_jobs = {
            candidate.id: candidate
            for key, _ in identity_specs
            if (candidate := uow.jobs.get_by_identity_key(key)) is not None
        }
        direct = uow.jobs.get_by_canonical_url(canonical_url)
        if direct is not None:
            resolved_jobs[direct.id] = direct
        if len(resolved_jobs) > 1:
            raise ValidationError(
                "job identity keys resolve to conflicting existing jobs; resolve the "
                "canonical URL/requisition collision before importing"
            )
        job = next(iter(resolved_jobs.values()), None)
        if job is None or job.id in legacy_created_job_ids:
            prior_case = None if job is None else uow.cases.get_for_profile_job(profile_id, job.id)
            created_job = job is None
            job, case, _ = self._add_job_case(
                uow,
                profile_id,
                canonical_url,
                details,
                legacy=True,
            )
            return job, case, created_job, prior_case is None

        # Identity aliases are historical linkage, not mutable job facts. Retain them
        # while keeping the native Job row and its current JobVersion byte-for-byte
        # authoritative.
        now = self._clock.now()
        for key, kind in identity_specs:
            if not uow.jobs.add_identity_key(
                JobIdentityKey(key=key, job_id=job.id, kind=kind, created_at=now)
            ):
                raise ValidationError("job identity was concurrently assigned to a different job")
        existing_case = uow.cases.get_for_profile_job(profile_id, job.id)
        if existing_case is not None:
            return job, existing_case, False, False
        case = JobCase(
            id=self._ids.new(),
            profile_id=profile_id,
            job_id=job.id,
            created_at=now,
            updated_at=now,
        )
        uow.cases.add(case)
        self._event(
            uow,
            profile_id,
            "job.added",
            case.id,
            metadata={
                "job_id": job.id,
                "canonical_url": canonical_url,
                "created_global_job": False,
                "legacy_unpinned": True,
            },
        )
        return job, case, False, True

    # Review ---------------------------------------------------------------

    async def review_job(
        self,
        profile_id: str,
        job_id: str,
        *,
        rerun: bool = False,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> JobReviewView:
        request_fingerprint = _request_fingerprint(
            "review.run",
            profile_id=profile_id,
            job_id=job_id,
            rerun=rerun,
        )
        if self._agent_registry is not None:
            # A command replay must be side-effect free. In particular, do not sync and
            # activate a newer master-resume commit before returning its pinned result.
            if command_id is not None:
                with self._uow_factory() as uow:
                    profile = self._require_profile(uow, profile_id)
                    job = self._require_job(uow, job_id)
                    case = self._require_case_for_job(uow, profile_id, job_id)
                    receipt = uow.commands.get(command_id)
                    if receipt is not None:
                        _validate_command_replay(receipt, "review.run", request_fingerprint)
                        if receipt.result_type == "job_case":
                            if receipt.result_id != case.id:
                                raise NotFoundError(
                                    "idempotent screening result was not found for this job"
                                )
                            return self._job_review_view(uow, profile, job, case)
                        stored = uow.reviews.get(receipt.result_id)
                        if stored is None or stored.job_case_id != case.id:
                            raise NotFoundError(
                                "idempotent review result was not found for this job"
                            )
                        return self._job_review_view(uow, profile, job, case)
            source = self.get_resume_source(profile_id)
            if source is None:
                raise InvalidTransitionError(
                    "configure the trusted master résumé repository before review"
                )
            await self.sync_resume_source(profile_id, progress=progress)
            return await self._review_job_authoritative(
                profile_id,
                job_id,
                rerun=rerun,
                command_id=command_id,
                progress=progress,
            )
        reporter = progress or NullProgressReporter()
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            latest = uow.reviews.get_latest(case.id)
            analyzer_version = (
                self._analyzer.version
                if self._analyzer is not None and _provider_is_available(self._analyzer)
                else latest.analyzer_version
                if latest is not None
                else None
            )
            expected = (
                review_fingerprint(
                    job_revision=job.revision,
                    profile_revision=profile.revision,
                    evidence_version_id=profile.active_evidence_version_id,
                    analyzer_version=analyzer_version,
                )
                if analyzer_version is not None
                else None
            )
            if review_status(latest, expected_fingerprint=expected) is ReviewStatus.CURRENT:
                return self._job_review_view(uow, profile, job, case)
            evidence = (
                uow.evidence.get(profile.active_evidence_version_id)
                if profile.active_evidence_version_id
                else None
            )
            profile_revision = profile.revision
            job_revision = job.revision
            evidence_id = profile.active_evidence_version_id

        analyzer = self._require_provider(self._analyzer, "job review")
        expected = review_fingerprint(
            job_revision=job_revision,
            profile_revision=profile_revision,
            evidence_version_id=evidence_id,
            analyzer_version=analyzer.version,
        )
        try:
            analysis = await analyzer.analyze(
                ReviewContext(profile=profile, evidence=evidence, job=job),
                progress=reporter,
            )
            match_evidence = _validated_findings(analysis.match_evidence, "match evidence")
            skeptic_findings = _validated_findings(analysis.skeptic_findings, "skeptic finding")
            questions = _materialize_questions(analysis.questions)
        except ApplicationError:
            raise
        except Exception as exc:
            raise ProviderFailureError(
                f"job review failed: {exc}", details={"provider": "review"}
            ) from exc

        review = ReviewVersion(
            id=self._ids.new(),
            job_case_id=case.id,
            fingerprint=expected,
            analyzer_version=analyzer.version,
            match_evidence=match_evidence,
            skeptic_findings=skeptic_findings,
            questions=questions,
            created_at=self._clock.now(),
        )
        with self._uow_factory() as uow:
            current_profile = self._require_profile(uow, profile_id)
            current_job = self._require_job(uow, job_id)
            current_case = self._require_case_for_job(uow, profile_id, job_id)
            current_fingerprint = review_fingerprint(
                job_revision=current_job.revision,
                profile_revision=current_profile.revision,
                evidence_version_id=current_profile.active_evidence_version_id,
                analyzer_version=analyzer.version,
            )
            if current_fingerprint != expected or current_case.id != case.id:
                raise RevisionConflictError(
                    "job, profile, or evidence changed while review was running"
                )
            uow.reviews.add(review)
            touched = replace(
                current_case,
                revision=current_case.revision + 1,
                updated_at=self._clock.now(),
            )
            if not uow.cases.update(touched, expected_revision=current_case.revision):
                raise RevisionConflictError("job changed while review was being saved")
            self._event(
                uow,
                profile_id,
                "review.completed",
                case.id,
                metadata={"review_version_id": review.id},
            )
            uow.commit()
            return self._job_review_view(uow, current_profile, current_job, touched)

    def answer_verification(
        self,
        profile_id: str,
        job_id: str,
        question_id: str,
        answer: Answer,
        *,
        command_id: str | None = None,
    ) -> JobReviewView:
        if not isinstance(answer, Answer):
            raise ValidationError("answer must be yes, no, or unknown")
        if self._agent_registry is not None:
            return self._answer_verification_authoritative(
                profile_id,
                job_id,
                question_id,
                answer,
                command_id=command_id,
            )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            latest = uow.reviews.get_latest(case.id)
            if latest is None:
                raise InvalidTransitionError("review the job before answering questions")
            expected = self._expected_review_fingerprint(profile, job, latest)
            if review_status(latest, expected_fingerprint=expected) is not ReviewStatus.CURRENT:
                raise InvalidTransitionError(
                    "the review is stale; refresh it before answering questions"
                )
            if not any(question.id == question_id for question in latest.questions):
                raise NotFoundError("review question was not found")
            existing = {item.question_id: item for item in uow.reviews.list_answers(latest.id)}.get(
                question_id
            )
            if existing is not None and existing.answer is answer:
                return self._job_review_view(uow, profile, job, case)
            now = self._clock.now()
            uow.reviews.upsert_answer(
                VerificationAnswer(
                    review_version_id=latest.id,
                    question_id=question_id,
                    answer=answer,
                    answered_at=now,
                )
            )
            touched = replace(case, revision=case.revision + 1, updated_at=now)
            if not uow.cases.update(touched, expected_revision=case.revision):
                raise RevisionConflictError("job changed while the answer was being saved")
            self._event(
                uow,
                profile_id,
                "question.answered",
                case.id,
                metadata={"question_id": question_id, "answer": answer.value},
            )
            uow.commit()
            return self._job_review_view(uow, profile, job, touched)

    def get_answer_history(
        self,
        profile_id: str,
        job_id: str,
        question_id: str | None = None,
    ) -> tuple[VerificationAnswerEvent, ...]:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            events = tuple(uow.answer_events.list_for_case(case.id))
        if question_id is None:
            return events
        return tuple(item for item in events if item.question_key == question_id)

    def _answer_verification_authoritative(
        self,
        profile_id: str,
        job_id: str,
        question_id: str,
        answer: Answer,
        *,
        command_id: str | None,
    ) -> JobReviewView:
        effective_command_id = command_id or self._ids.new()
        request_fingerprint = _request_fingerprint(
            "answer.append",
            profile_id=profile_id,
            job_id=job_id,
            question_id=question_id,
            answer=answer,
        )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "answer.append", request_fingerprint)
                    return self._job_review_view(uow, profile, job, case)
            review = uow.reviews.get_latest(case.id)
            if review is None or review.legacy_input_status != "native":
                raise InvalidTransitionError("run a current Reviewer analysis before answering")
            question = next(
                (item for item in review.questions if item.id == question_id),
                None,
            )
            if question is None:
                raise NotFoundError("review question was not found")
            history = tuple(uow.answer_events.list_for_case(case.id))
            previous = next(
                (item for item in reversed(history) if item.question_key == question_id),
                None,
            )
            now = self._clock.now()
            event = VerificationAnswerEvent(
                id=self._ids.new(),
                command_id=effective_command_id,
                job_case_id=case.id,
                question_key=question_id,
                asked_by_review_version_id=review.id,
                answer=answer,
                actor=ActorKind.HUMAN,
                supersedes_answer_event_id=None if previous is None else previous.id,
                recorded_at=now,
            )
            uow.answer_events.add(event)
            # Keep the v0 read model populated while adapters migrate to event history.
            uow.reviews.upsert_answer(VerificationAnswer(review.id, question_id, answer, now))
            touched = replace(case, revision=case.revision + 1, updated_at=now)
            if not uow.cases.update(touched, expected_revision=case.revision):
                raise RevisionConflictError("job changed while the answer was saved")
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "answer.append",
                        "verification_answer_event",
                        event.id,
                        now,
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "question.answered",
                case.id,
                metadata={"question_id": question_id, "answer_event_id": event.id},
            )
            uow.commit()
            return self._job_review_view(uow, profile, job, touched)

    # Human decisions and résumé generation -------------------------------

    def decide_job(
        self,
        profile_id: str,
        job_id: str,
        decision: Decision,
        *,
        command_id: str | None = None,
    ) -> JobCase:
        if not isinstance(decision, Decision) or decision is Decision.UNDECIDED:
            raise ValidationError("decision must be tailor, watch, or skip")
        if self._agent_registry is not None:
            if decision is Decision.TAILOR:
                raise InvalidTransitionError(
                    "Tailor must use decide_and_tailor so the gate and résumé run are atomic"
                )
            return self._decide_job_authoritative(
                profile_id, job_id, decision, command_id=command_id
            )
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if decision is Decision.SKIP and case.application_status is ApplicationStatus.SUBMITTED:
                raise InvalidTransitionError("a submitted application cannot be skipped")
            if case.decision is decision:
                return case
            updated = replace(
                case,
                decision=decision,
                revision=case.revision + 1,
                updated_at=self._clock.now(),
            )
            if not uow.cases.update(updated, expected_revision=case.revision):
                raise RevisionConflictError("job was changed by another operation")
            self._event(
                uow,
                profile_id,
                "decision.changed",
                case.id,
                metadata={"from": case.decision.value, "to": decision.value},
            )
            uow.commit()
            return updated

    async def decide_and_tailor(
        self,
        profile_id: str,
        job_id: str,
        decision: Decision,
        *,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> DecisionResult:
        if not isinstance(decision, Decision) or decision is Decision.UNDECIDED:
            raise ValidationError("decision must be tailor, watch, or skip")
        operation_id = command_id or self._ids.new()
        if decision is not Decision.TAILOR:
            case = self.decide_job(
                profile_id,
                job_id,
                decision,
                command_id=command_id,
            )
            return DecisionResult(case, DecisionReason.HUMAN_CHOICE, None)
        case, queued = self._queue_tailor_resume_atomic(
            profile_id,
            job_id,
            operation_id=operation_id,
            public_command_id=command_id,
        )
        run = queued
        if queued.stage is ResumeStage.QUEUED:
            run = await self._generate_resume_authoritative(
                profile_id,
                job_id,
                parent_run=None,
                feedback_event=None,
                command_id=f"{operation_id}:resume",
                progress=progress,
                prequeued_run_id=queued.id,
            )
        return DecisionResult(case, DecisionReason.HUMAN_CHOICE, run)

    def _decide_job_authoritative(
        self,
        profile_id: str,
        job_id: str,
        decision: Decision,
        *,
        command_id: str | None,
    ) -> JobCase:
        if decision is Decision.TAILOR:
            raise InvalidTransitionError(
                "Tailor must use decide_and_tailor so the gate and résumé run are atomic"
            )
        effective_command_id = command_id or self._ids.new()
        request_fingerprint = _request_fingerprint(
            "decision.append",
            profile_id=profile_id,
            job_id=job_id,
            decision=decision,
        )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "decision.append", request_fingerprint)
                    return case
            if uow.tracked_applications.get_for_job(job_id) is not None:
                raise InvalidTransitionError(
                    "record application stages after submission; decisions are pre-submission gates"
                )
            now = self._clock.now()
            review = uow.reviews.get_latest(case.id)
            profile_version = uow.profile_versions.get_current(profile_id)
            job_version = uow.job_versions.get_current(job_id)
            evidence = (
                None
                if profile.active_evidence_version_id is None
                else uow.evidence.get(profile.active_evidence_version_id)
            )
            answer_events = tuple(uow.answer_events.list_for_case(case.id))
            answer_fingerprint = answer_set_fingerprint(answer_events)
            if decision is not Decision.SKIP:
                if (
                    review is None
                    or review.legacy_input_status != "native"
                    or profile_version is None
                    or job_version is None
                    or evidence is None
                    or review.fingerprint
                    != self._expected_review_fingerprint(profile, job, review, uow=uow)
                ):
                    raise InvalidTransitionError(
                        "watch requires a completed current Reviewer analysis"
                    )
                if review.answer_set_fingerprint != answer_fingerprint:
                    raise InvalidTransitionError("rerun Reviewer after changing an answer")
            event = CaseDecisionEvent(
                id=self._ids.new(),
                command_id=effective_command_id,
                job_case_id=case.id,
                decision=decision,
                reason=DecisionReason.HUMAN_CHOICE,
                actor=ActorKind.HUMAN,
                review_version_id=None if review is None else review.id,
                job_version_id=None if job_version is None else job_version.id,
                profile_version_id=None if profile_version is None else profile_version.id,
                evidence_version_id=None if evidence is None else evidence.id,
                answer_set_fingerprint=answer_fingerprint,
                supersedes_decision_event_id=case.current_decision_event_id,
                decided_at=now,
            )
            uow.decision_events.add(event)
            updated = replace(
                case,
                decision=decision,
                current_decision_event_id=event.id,
                revision=case.revision + 1,
                updated_at=now,
            )
            if not uow.cases.update(updated, expected_revision=case.revision):
                raise RevisionConflictError("job changed while decision was saved")
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "decision.append",
                        "case_decision_event",
                        event.id,
                        now,
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "decision.changed",
                case.id,
                metadata={"decision_event_id": event.id, "to": decision.value},
            )
            uow.commit()
            return updated

    def _queue_tailor_resume_atomic(
        self,
        profile_id: str,
        job_id: str,
        *,
        operation_id: str,
        public_command_id: str | None,
    ) -> tuple[JobCase, ResumeRun]:
        """Persist the Tailor gate and its first queued run as one command."""

        registry = self._require_provider(self._agent_registry, "agent provider registry")
        renderer = self._require_provider(self._master_resume_renderer, "master résumé renderer")
        gate_command_id = f"{operation_id}:gate"
        resume_command_id = f"{operation_id}:resume"
        public_request_fingerprint = _request_fingerprint(
            "decision.tailor",
            profile_id=profile_id,
            job_id=job_id,
            decision=Decision.TAILOR,
        )
        with self._uow_factory() as uow:
            if public_command_id is not None:
                receipt = uow.commands.get(public_command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "decision.tailor", public_request_fingerprint)
                    existing = uow.resume_runs.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent Tailor result was not found")
                    existing_case = uow.cases.get(existing.job_case_id)
                    if existing_case is None:
                        raise NotFoundError("idempotent Tailor case was not found")
                    return existing_case, existing
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if uow.tracked_applications.get_for_job(job_id) is not None:
                raise InvalidTransitionError(
                    "record application stages after submission; decisions are pre-submission gates"
                )
            if any(item.job_case_id == case.id for item in uow.resume_runs.list_in_progress()):
                raise InvalidTransitionError("résumé generation is already in progress")
            review = uow.reviews.get_latest(case.id)
            profile_version = uow.profile_versions.get_current(profile_id)
            job_version = uow.job_versions.get_current(job_id)
            evidence = (
                None
                if profile.active_evidence_version_id is None
                else uow.evidence.get(profile.active_evidence_version_id)
            )
            answer_events = tuple(uow.answer_events.list_for_case(case.id))
            answer_fingerprint = answer_set_fingerprint(answer_events)
            if (
                review is None
                or review.legacy_input_status != "native"
                or profile_version is None
                or job_version is None
                or evidence is None
                or review.fingerprint
                != self._expected_review_fingerprint(profile, job, review, uow=uow)
            ):
                raise InvalidTransitionError(
                    "Tailor requires a completed current Reviewer analysis"
                )
            answers = _latest_answers_for_review(uow, review, answer_events)
            if derive_eligibility(review.questions, answers) is not EligibilityStatus.ELIGIBLE:
                raise InvalidTransitionError(
                    "answer all required questions favorably, then rerun Reviewer"
                )
            if review.answer_set_fingerprint != answer_fingerprint:
                raise InvalidTransitionError("rerun Reviewer after changing an answer")
            if evidence.source_revision is None or evidence.contract_schema_version is None:
                raise InvalidTransitionError("master résumé contract snapshot is incomplete")
            latest_run = uow.resume_runs.get_latest(case.id)
            same_review_chain = bool(
                latest_run is not None
                and latest_run.review_version_id == review.id
                and latest_run.job_version_id == job_version.id
                and latest_run.profile_version_id == profile_version.id
                and latest_run.evidence_version_id == evidence.id
                and latest_run.answer_set_fingerprint == answer_fingerprint
            )
            if same_review_chain and latest_run is not None:
                if latest_run.stage in {ResumeStage.FAILED, ResumeStage.INTERRUPTED}:
                    raise InvalidTransitionError(
                        "the current résumé chain failed; use resume retry"
                    )
                if latest_run.stage is ResumeStage.READY:
                    raise InvalidTransitionError(
                        "the current résumé chain is ready; approve, reject, or use resume revise"
                    )
            agent = registry.resume(profile_version)
            descriptor = _validated_agent_descriptor(
                agent.descriptor, profile_version, AgentKind.RESUME
            )
            now = self._clock.now()
            gate = CaseDecisionEvent(
                id=self._ids.new(),
                command_id=gate_command_id,
                job_case_id=case.id,
                decision=Decision.TAILOR,
                reason=DecisionReason.HUMAN_CHOICE,
                actor=ActorKind.HUMAN,
                review_version_id=review.id,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                evidence_version_id=evidence.id,
                answer_set_fingerprint=answer_fingerprint,
                supersedes_decision_event_id=case.current_decision_event_id,
                decided_at=now,
            )
            fingerprint = authoritative_resume_fingerprint(
                review_version_id=review.id,
                gate_decision_event_id=gate.id,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                evidence_version_id=evidence.id,
                evidence_source_revision=evidence.source_revision,
                answer_fingerprint=answer_fingerprint,
                model=descriptor.model,
                prompt_version=descriptor.prompt_version,
                prompt_hash=descriptor.prompt_hash,
                schema_version=descriptor.output_schema_version,
                schema_hash=descriptor.output_schema_hash,
                renderer_protocol_version=renderer.protocol_version,
                renderer_version=evidence.renderer_version or "",
            )
            agent_run = AgentRun(
                id=self._ids.new(),
                command_id=resume_command_id,
                kind=AgentKind.RESUME,
                provider=descriptor.provider,
                model=descriptor.model,
                prompt_version=descriptor.prompt_version,
                output_schema_version=descriptor.output_schema_version,
                profile_id=profile_id,
                job_case_id=case.id,
                input_fingerprint=fingerprint,
                status=AgentRunStatus.QUEUED,
                prompt_hash=descriptor.prompt_hash,
                output_schema_hash=descriptor.output_schema_hash,
                created_at=now,
            )
            run = ResumeRun(
                id=self._ids.new(),
                job_case_id=case.id,
                review_version_id=review.id,
                evidence_version_id=evidence.id,
                input_fingerprint=fingerprint,
                stage=ResumeStage.QUEUED,
                generator_version=descriptor.prompt_version,
                validator_version=evidence.contract_schema_version,
                compiler_version=renderer.protocol_version,
                created_at=now,
                updated_at=now,
                agent_run_id=agent_run.id,
                gate_decision_event_id=gate.id,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                answer_set_fingerprint=answer_fingerprint,
            )
            updated_case = replace(
                case,
                decision=Decision.TAILOR,
                current_decision_event_id=gate.id,
                revision=case.revision + 1,
                updated_at=now,
            )
            uow.decision_events.add(gate)
            if not uow.cases.update(updated_case, expected_revision=case.revision):
                raise RevisionConflictError("job changed while Tailor was queued")
            uow.agent_runs.add(agent_run)
            uow.resume_runs.add(run)
            uow.commands.add(
                CommandReceipt(
                    gate_command_id,
                    "decision.append",
                    "case_decision_event",
                    gate.id,
                    now,
                    _request_fingerprint(
                        "decision.append",
                        profile_id=profile_id,
                        job_id=job_id,
                        decision=Decision.TAILOR,
                    ),
                )
            )
            uow.commands.add(
                CommandReceipt(
                    resume_command_id,
                    "resume.generate",
                    "resume_run",
                    run.id,
                    now,
                    _request_fingerprint(
                        "resume.generate",
                        profile_id=profile_id,
                        job_id=job_id,
                        parent_resume_run_id=None,
                        feedback_review_event_id=None,
                        gate_decision_event_id=gate.id,
                    ),
                )
            )
            if public_command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        public_command_id,
                        "decision.tailor",
                        "resume_run",
                        run.id,
                        now,
                        public_request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "decision.changed",
                case.id,
                metadata={"decision_event_id": gate.id, "to": Decision.TAILOR.value},
            )
            self._event(
                uow,
                profile_id,
                "resume.queued",
                case.id,
                metadata={"resume_run_id": run.id, "gate_decision_event_id": gate.id},
            )
            uow.commit()
            return updated_case, run

    async def generate_resume(
        self,
        profile_id: str,
        job_id: str,
        *,
        progress: ProgressReporter | None = None,
    ) -> ResumeRun:
        if self._agent_registry is not None:
            raise InvalidTransitionError(
                "the initial RoleLoop résumé is queued atomically by the Tailor decision; "
                "use retry for a failed run or revise with human feedback"
            )
        # Preflight all providers before creating a run or touching state.
        generator = self._require_provider(self._generator, "résumé generation")
        validator = self._require_provider(self._validator, "résumé validation")
        compiler = self._require_provider(self._compiler, "PDF compilation")
        store = self._require_provider(self._artifact_store, "artifact storage")
        reporter = progress or NullProgressReporter()

        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            review = uow.reviews.get_latest(case.id)
            if review is None:
                raise InvalidTransitionError("review the job before generating a résumé")
            if (
                review_status(
                    review,
                    expected_fingerprint=self._expected_review_fingerprint(profile, job, review),
                )
                is not ReviewStatus.CURRENT
            ):
                raise InvalidTransitionError("refresh the stale review before generating a résumé")
            if case.decision is not Decision.TAILOR:
                raise InvalidTransitionError("choose tailor before generating a tailored résumé")
            if profile.active_evidence_version_id is None:
                raise InvalidTransitionError("import résumé evidence before tailoring")
            evidence = uow.evidence.get(profile.active_evidence_version_id)
            if evidence is None:
                raise NotFoundError("active résumé evidence was not found")
            answer_items = uow.reviews.list_answers(review.id)
            answers = {item.question_id: item.answer for item in answer_items}
            if derive_eligibility(review.questions, answers) is not EligibilityStatus.ELIGIBLE:
                raise InvalidTransitionError(
                    "all required questions must have favorable answers before tailoring"
                )
            in_progress = [
                run for run in uow.resume_runs.list_in_progress() if run.job_case_id == case.id
            ]
            if in_progress:
                raise InvalidTransitionError("résumé generation is already in progress")
            fingerprint = resume_input_fingerprint(
                review_version_id=review.id,
                evidence_version_id=evidence.id,
                generator_version=generator.version,
                validator_version=validator.version,
                compiler_version=compiler.version,
            )
            now = self._clock.now()
            run = ResumeRun(
                id=self._ids.new(),
                job_case_id=case.id,
                review_version_id=review.id,
                evidence_version_id=evidence.id,
                input_fingerprint=fingerprint,
                stage=ResumeStage.QUEUED,
                generator_version=generator.version,
                validator_version=validator.version,
                compiler_version=compiler.version,
                created_at=now,
                updated_at=now,
            )
            uow.resume_runs.add(run)
            self._event(
                uow,
                profile_id,
                "resume.queued",
                case.id,
                metadata={
                    "resume_run_id": run.id,
                    "stage": ResumeStage.QUEUED.value,
                },
            )
            uow.commit()

        context = GenerationContext(
            profile=profile,
            evidence=evidence,
            job=job,
            review=review,
            answers=answers,
        )
        try:
            run = self._advance_run(run, ResumeStage.DRAFTING)
            reporter.report(ProgressUpdate("resume", ResumeStage.DRAFTING.value, "Drafting résumé"))
            draft = await generator.generate(context, progress=reporter)

            run = self._advance_run(
                run,
                ResumeStage.VALIDATING,
                structured_draft=dict(draft.content),
                provenance=tuple(draft.provenance),
            )
            reporter.report(
                ProgressUpdate("resume", ResumeStage.VALIDATING.value, "Validating claims")
            )
            findings = tuple(await validator.validate(context, draft, progress=reporter))
            if any(item.severity is ValidationSeverity.ERROR for item in findings):
                run = self._advance_run(
                    run,
                    ResumeStage.FAILED,
                    validation_findings=findings,
                    error_message="blocking validation findings",
                )
                return run

            run = self._advance_run(
                run,
                ResumeStage.COMPILING,
                validation_findings=findings,
            )
            reporter.report(ProgressUpdate("resume", ResumeStage.COMPILING.value, "Compiling PDF"))
            document = await compiler.compile(context, draft, progress=reporter)
            normalized_media_type = document.media_type.partition(";")[0].strip().lower()
            if normalized_media_type != "application/pdf":
                raise ArtifactError("PDF compiler returned a non-PDF media type")
            if not document.data.startswith(b"%PDF-"):
                raise ArtifactError("PDF compiler returned invalid PDF content")
            artifact = await store.put_bytes(
                document.data,
                media_type=document.media_type,
                extension=document.extension,
            )
            run = self._advance_run(run, ResumeStage.READY, artifact=artifact)
            reporter.report(ProgressUpdate("resume", ResumeStage.READY.value, "Résumé ready"))
            return run
        except asyncio.CancelledError:
            self._advance_run(
                run,
                ResumeStage.INTERRUPTED,
                error_message="operation was interrupted",
            )
            raise
        except ApplicationError as exc:
            self._fail_run(run, exc.message)
            raise
        except Exception as exc:
            code, message = _sanitized_error(exc)
            self._fail_run(run, message)
            raise ProviderFailureError(
                f"résumé generation failed during {run.stage.value} ({code}): {message}"
            ) from exc

    async def retry_resume(
        self,
        profile_id: str,
        job_id: str,
        *,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> ResumeRun:
        if self._agent_registry is None:
            return await self.generate_resume(profile_id, job_id, progress=progress)
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    existing = uow.resume_runs.get(receipt.result_id)
                    if existing is None or existing.job_case_id != case.id:
                        raise NotFoundError("idempotent résumé result was not found for this job")
                    _validate_command_replay(
                        receipt,
                        "resume.generate",
                        _request_fingerprint(
                            "resume.generate",
                            profile_id=profile_id,
                            job_id=job_id,
                            parent_resume_run_id=existing.parent_resume_run_id,
                            feedback_review_event_id=(existing.feedback_review_event_id),
                            gate_decision_event_id=(existing.gate_decision_event_id),
                        ),
                    )
                    return existing
            failed = uow.resume_runs.get_latest(case.id)
            if failed is None or failed.stage not in {
                ResumeStage.FAILED,
                ResumeStage.INTERRUPTED,
            }:
                raise InvalidTransitionError(
                    "retry requires the latest résumé run to be failed or interrupted"
                )
            parent = (
                None
                if failed.parent_resume_run_id is None
                else uow.resume_runs.get(failed.parent_resume_run_id)
            )
            feedback_event = (
                None
                if failed.feedback_review_event_id is None
                else uow.resume_reviews.get(failed.feedback_review_event_id)
            )
            if failed.parent_resume_run_id is not None and parent is None:
                raise NotFoundError("failed résumé parent run was not found")
            if failed.feedback_review_event_id is not None and feedback_event is None:
                raise NotFoundError("failed résumé feedback event was not found")
        return await self._generate_resume_authoritative(
            profile_id,
            job_id,
            parent_run=parent,
            feedback_event=feedback_event,
            command_id=command_id,
            progress=progress,
        )

    async def revise_resume(
        self,
        profile_id: str,
        job_id: str,
        feedback: str,
        *,
        command_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> ResumeRun:
        feedback = feedback.strip()
        if not feedback:
            raise ValidationError("revision feedback is required")
        if self._agent_registry is None:
            raise InvalidTransitionError(
                "resume revision requires the authoritative RoleLoop workflow"
            )
        operation_id = command_id or self._ids.new()
        parent, review_event, queued = self._queue_resume_revision_atomic(
            profile_id,
            job_id,
            feedback,
            operation_id=operation_id,
            public_command_id=command_id,
        )
        if queued.stage is not ResumeStage.QUEUED:
            return queued
        return await self._generate_resume_authoritative(
            profile_id,
            job_id,
            parent_run=parent,
            feedback_event=review_event,
            command_id=f"{operation_id}:generation",
            progress=progress,
            prequeued_run_id=queued.id,
        )

    def _queue_resume_revision_atomic(
        self,
        profile_id: str,
        job_id: str,
        feedback: str,
        *,
        operation_id: str,
        public_command_id: str | None,
    ) -> tuple[ResumeRun, ResumeReviewEvent, ResumeRun]:
        """Persist human feedback and its child run before provider work starts."""

        registry = self._require_provider(self._agent_registry, "agent provider registry")
        renderer = self._require_provider(self._master_resume_renderer, "master résumé renderer")
        generation_command_id = f"{operation_id}:generation"
        public_request_fingerprint = _request_fingerprint(
            "resume.revise",
            profile_id=profile_id,
            job_id=job_id,
            feedback=feedback,
        )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if public_command_id is not None:
                receipt = uow.commands.get(public_command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "resume.revise", public_request_fingerprint)
                    existing = uow.resume_runs.get(receipt.result_id)
                    if existing is None or existing.job_case_id != case.id:
                        raise NotFoundError("idempotent revised résumé was not found for this job")
                    if (
                        existing.parent_resume_run_id is None
                        or existing.feedback_review_event_id is None
                    ):
                        raise InvalidTransitionError(
                            "idempotent revision is missing its parent lineage"
                        )
                    existing_parent = uow.resume_runs.get(existing.parent_resume_run_id)
                    existing_feedback = uow.resume_reviews.get(existing.feedback_review_event_id)
                    if existing_parent is None or existing_feedback is None:
                        raise NotFoundError("idempotent revision lineage was not found")
                    return existing_parent, existing_feedback, existing
            if uow.tracked_applications.get_for_case(case.id) is not None:
                raise InvalidTransitionError(
                    "a submitted application cannot start a new résumé revision"
                )
            if any(run.job_case_id == case.id for run in uow.resume_runs.list_in_progress()):
                raise InvalidTransitionError("résumé generation is already in progress")
            parent = uow.resume_runs.get_latest(case.id)
            if parent is None or parent.stage is not ResumeStage.READY:
                raise InvalidTransitionError("a ready RoleLoop résumé is required for revision")
            latest_review_event = uow.resume_reviews.get_latest(parent.id)
            if latest_review_event is not None and latest_review_event.decision in {
                ResumeReviewDecision.APPROVED,
                ResumeReviewDecision.REJECTED,
            }:
                raise InvalidTransitionError(
                    "an approved or rejected résumé run is closed and cannot be revised"
                )
            if not self._resume_run_is_current(uow, profile, job, case, parent):
                raise InvalidTransitionError(
                    "the parent résumé is stale; review and Tailor from current inputs"
                )
            review = uow.reviews.get(parent.review_version_id)
            evidence = uow.evidence.get(parent.evidence_version_id)
            profile_version = (
                None
                if parent.profile_version_id is None
                else uow.profile_versions.get(parent.profile_version_id)
            )
            job_version = (
                None
                if parent.job_version_id is None
                else uow.job_versions.get(parent.job_version_id)
            )
            gate = (
                None
                if parent.gate_decision_event_id is None
                else uow.decision_events.get(parent.gate_decision_event_id)
            )
            if (
                review is None
                or evidence is None
                or profile_version is None
                or job_version is None
                or gate is None
                or evidence.source_revision is None
                or evidence.contract_schema_version is None
            ):
                raise InvalidTransitionError("the parent résumé is missing reproducible lineage")
            descriptor = _validated_agent_descriptor(
                registry.resume(profile_version).descriptor,
                profile_version,
                AgentKind.RESUME,
            )
            now = self._clock.now()
            review_event = ResumeReviewEvent(
                id=self._ids.new(),
                command_id=f"{operation_id}:feedback",
                resume_run_id=parent.id,
                decision=ResumeReviewDecision.CHANGES_REQUESTED,
                actor=ActorKind.HUMAN,
                feedback=feedback,
                created_at=now,
            )
            fingerprint = authoritative_resume_fingerprint(
                review_version_id=review.id,
                gate_decision_event_id=gate.id,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                evidence_version_id=evidence.id,
                evidence_source_revision=evidence.source_revision,
                answer_fingerprint=parent.answer_set_fingerprint,
                model=descriptor.model,
                prompt_version=descriptor.prompt_version,
                prompt_hash=descriptor.prompt_hash,
                schema_version=descriptor.output_schema_version,
                schema_hash=descriptor.output_schema_hash,
                renderer_protocol_version=renderer.protocol_version,
                renderer_version=evidence.renderer_version or "",
                parent_resume_run_id=parent.id,
                feedback_review_event_id=review_event.id,
            )
            agent_run = AgentRun(
                id=self._ids.new(),
                command_id=generation_command_id,
                kind=AgentKind.RESUME,
                provider=descriptor.provider,
                model=descriptor.model,
                prompt_version=descriptor.prompt_version,
                output_schema_version=descriptor.output_schema_version,
                profile_id=profile_id,
                job_case_id=case.id,
                input_fingerprint=fingerprint,
                status=AgentRunStatus.QUEUED,
                prompt_hash=descriptor.prompt_hash,
                output_schema_hash=descriptor.output_schema_hash,
                created_at=now,
            )
            queued = ResumeRun(
                id=self._ids.new(),
                job_case_id=case.id,
                review_version_id=review.id,
                evidence_version_id=evidence.id,
                input_fingerprint=fingerprint,
                stage=ResumeStage.QUEUED,
                generator_version=descriptor.prompt_version,
                validator_version=evidence.contract_schema_version,
                compiler_version=renderer.protocol_version,
                created_at=now,
                updated_at=now,
                agent_run_id=agent_run.id,
                parent_resume_run_id=parent.id,
                feedback_review_event_id=review_event.id,
                gate_decision_event_id=gate.id,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                answer_set_fingerprint=parent.answer_set_fingerprint,
            )
            uow.resume_reviews.add(review_event)
            uow.agent_runs.add(agent_run)
            uow.resume_runs.add(queued)
            uow.commands.add(
                CommandReceipt(
                    generation_command_id,
                    "resume.generate",
                    "resume_run",
                    queued.id,
                    now,
                    _request_fingerprint(
                        "resume.generate",
                        profile_id=profile_id,
                        job_id=job_id,
                        parent_resume_run_id=parent.id,
                        feedback_review_event_id=review_event.id,
                        gate_decision_event_id=gate.id,
                    ),
                )
            )
            if public_command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        public_command_id,
                        "resume.revise",
                        "resume_run",
                        queued.id,
                        now,
                        public_request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "resume.changes_requested",
                case.id,
                metadata={
                    "resume_run_id": parent.id,
                    "resume_review_event_id": review_event.id,
                },
            )
            self._event(
                uow,
                profile_id,
                "resume.queued",
                case.id,
                metadata={
                    "resume_run_id": queued.id,
                    "parent_resume_run_id": parent.id,
                },
            )
            uow.commit()
            return parent, review_event, queued

    async def approve_resume(
        self,
        profile_id: str,
        job_id: str,
        resume_run_id: str | None = None,
        *,
        command_id: str | None = None,
    ) -> ResumeReviewEvent:
        request_fingerprint = _request_fingerprint(
            "resume.review",
            profile_id=profile_id,
            job_id=job_id,
            resume_run_id=resume_run_id,
            decision=ResumeReviewDecision.APPROVED,
            feedback="",
        )
        if command_id is not None:
            with self._uow_factory() as uow:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "resume.review", request_fingerprint)
                    existing = uow.resume_reviews.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent résumé review was not found")
                    return existing
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            run = (
                uow.resume_runs.get_latest(case.id)
                if resume_run_id is None
                else uow.resume_runs.get(resume_run_id)
            )
            if run is None or run.job_case_id != case.id or run.artifact is None:
                raise NotFoundError("RoleLoop résumé PDF was not found for this job")
            artifact = run.artifact
        verified_checksum = await self._verify_pdf_artifact(artifact)
        return self._record_resume_review(
            profile_id,
            job_id,
            run.id,
            ResumeReviewDecision.APPROVED,
            "",
            command_id=command_id,
            verified_pdf_checksum=verified_checksum,
            request_fingerprint=request_fingerprint,
        )

    def reject_resume(
        self,
        profile_id: str,
        job_id: str,
        resume_run_id: str | None = None,
        *,
        feedback: str = "",
        command_id: str | None = None,
    ) -> ResumeReviewEvent:
        request_fingerprint = _request_fingerprint(
            "resume.review",
            profile_id=profile_id,
            job_id=job_id,
            resume_run_id=resume_run_id,
            decision=ResumeReviewDecision.REJECTED,
            feedback=feedback.strip(),
        )
        return self._record_resume_review(
            profile_id,
            job_id,
            resume_run_id,
            ResumeReviewDecision.REJECTED,
            feedback,
            command_id=command_id,
            request_fingerprint=request_fingerprint,
        )

    def _record_resume_review(
        self,
        profile_id: str,
        job_id: str,
        resume_run_id: str | None,
        decision: ResumeReviewDecision,
        feedback: str,
        *,
        command_id: str | None,
        verified_pdf_checksum: str | None = None,
        request_fingerprint: str | None = None,
    ) -> ResumeReviewEvent:
        effective_command_id = command_id or self._ids.new()
        request_fingerprint = request_fingerprint or _request_fingerprint(
            "resume.review",
            profile_id=profile_id,
            job_id=job_id,
            resume_run_id=resume_run_id,
            decision=decision,
            feedback=feedback.strip(),
        )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            run = (
                uow.resume_runs.get_latest(case.id)
                if resume_run_id is None
                else uow.resume_runs.get(resume_run_id)
            )
            if run is None or run.job_case_id != case.id:
                raise NotFoundError("RoleLoop résumé run was not found for this job")
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "resume.review", request_fingerprint)
                    existing = uow.resume_reviews.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent résumé review was not found")
                    return existing
            latest_run = uow.resume_runs.get_latest(case.id)
            if latest_run is None or latest_run.id != run.id:
                raise InvalidTransitionError(
                    "only the latest résumé run can receive a new human review"
                )
            latest_review_event = uow.resume_reviews.get_latest(run.id)
            if latest_review_event is not None and latest_review_event.decision in {
                ResumeReviewDecision.APPROVED,
                ResumeReviewDecision.REJECTED,
            }:
                raise InvalidTransitionError(
                    "an approved or rejected résumé run is closed and cannot be reviewed again"
                )
            if run.stage is not ResumeStage.READY or run.artifact is None:
                raise InvalidTransitionError("only a ready RoleLoop PDF can be reviewed")
            if (
                decision is ResumeReviewDecision.APPROVED
                and verified_pdf_checksum != run.artifact.checksum
            ):
                raise ArtifactError(
                    "the exact RoleLoop PDF must be read and checksum-verified before approval"
                )
            if not self._resume_run_is_current(uow, profile, job, case, run):
                raise InvalidTransitionError("résumé is stale; generate it from current inputs")
            now = self._clock.now()
            event = ResumeReviewEvent(
                id=self._ids.new(),
                command_id=effective_command_id,
                resume_run_id=run.id,
                decision=decision,
                actor=ActorKind.HUMAN,
                feedback=feedback.strip(),
                pdf_artifact_id=(
                    run.artifact.id if decision is ResumeReviewDecision.APPROVED else None
                ),
                pdf_checksum=(
                    run.artifact.checksum if decision is ResumeReviewDecision.APPROVED else None
                ),
                created_at=now,
            )
            uow.resume_reviews.add(event)
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "resume.review",
                        "resume_review_event",
                        event.id,
                        now,
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                f"resume.{decision.value}",
                case.id,
                metadata={"resume_run_id": run.id, "resume_review_event_id": event.id},
            )
            uow.commit()
            return event

    async def _verify_pdf_artifact(self, artifact: Any) -> str:
        reader = self._require_provider(self._artifact_reader, "artifact reading")
        try:
            data = await reader.read_bytes(artifact)
        except ApplicationError:
            raise
        except Exception as exc:
            raise ArtifactError("RoleLoop PDF bytes could not be read") from exc
        checksum = hashlib.sha256(data).hexdigest()
        if checksum != artifact.checksum or len(data) != artifact.size_bytes:
            raise ArtifactError("RoleLoop PDF bytes no longer match artifact metadata")
        if artifact.media_type.partition(";")[
            0
        ].strip().lower() != "application/pdf" or not data.startswith(b"%PDF-"):
            raise ArtifactError("RoleLoop résumé artifact is not a valid PDF")
        return checksum

    def get_resume(self, profile_id: str, job_id: str) -> ResumeCaseView:
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            runs = tuple(uow.resume_runs.list_for_case(case.id))
            latest = runs[-1] if runs else None
            events = tuple(
                event for run in runs for event in uow.resume_reviews.list_for_run(run.id)
            )
            latest_review = None if latest is None else uow.resume_reviews.get_latest(latest.id)
            current = (
                False
                if latest is None
                else self._resume_run_is_current(uow, profile, job, case, latest)
            )
            return ResumeCaseView(
                runs=runs,
                review_events=events,
                latest_run=latest,
                latest_artifact_id=(
                    None if latest is None or latest.artifact is None else latest.artifact.id
                ),
                approval_status=resume_approval_status(latest, latest_review, is_current=current),
            )

    def get_resume_review_history(
        self, profile_id: str, job_id: str
    ) -> tuple[ResumeReviewEvent, ...]:
        return self.get_resume(profile_id, job_id).review_events

    def recover_interrupted_runs(self) -> int:
        """Mark runs abandoned by a prior process as interrupted and retryable."""

        with self._uow_factory() as uow:
            runs = tuple(uow.resume_runs.list_in_progress())
            agent_runs = tuple(uow.agent_runs.list_in_progress())
            if not runs and not agent_runs:
                return 0
            now = self._clock.now()
            linked_agent_ids = {run.agent_run_id for run in runs if run.agent_run_id is not None}
            for run in runs:
                updated = replace(
                    run,
                    stage=ResumeStage.INTERRUPTED,
                    error_message="process stopped before generation completed",
                    updated_at=now,
                )
                uow.resume_runs.update(updated)
                if run.agent_run_id is not None:
                    agent_run = uow.agent_runs.get(run.agent_run_id)
                    if agent_run is not None and agent_run.status in {
                        AgentRunStatus.QUEUED,
                        AgentRunStatus.RUNNING,
                    }:
                        uow.agent_runs.update(
                            replace(
                                agent_run,
                                status=AgentRunStatus.INTERRUPTED,
                                error_code="interrupted",
                                error_message=("process stopped before generation completed"),
                                finished_at=now,
                            )
                        )
                case = uow.cases.get(run.job_case_id)
                if case is not None:
                    self._event(
                        uow,
                        case.profile_id,
                        "resume.interrupted",
                        case.id,
                        metadata={
                            "resume_run_id": run.id,
                            "stage": ResumeStage.INTERRUPTED.value,
                            "from_stage": run.stage.value,
                            "error": updated.error_message,
                        },
                    )
            orphan_agent_runs = tuple(run for run in agent_runs if run.id not in linked_agent_ids)
            for agent_run in orphan_agent_runs:
                uow.agent_runs.update(
                    replace(
                        agent_run,
                        status=AgentRunStatus.INTERRUPTED,
                        error_code="interrupted",
                        error_message="process stopped before agent execution completed",
                        finished_at=now,
                    )
                )
            uow.commit()
            return len(runs) + len(orphan_agent_runs)

    # Applications and outcomes -------------------------------------------

    def mark_applied(self, profile_id: str, job_id: str) -> JobCase:
        if self._agent_registry is not None:
            raise InvalidTransitionError(
                "authoritative applications require submit_application with an approved "
                "RoleLoop PDF and explicit follow-up date"
            )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if case.decision is Decision.SKIP:
                raise InvalidTransitionError("a skipped job cannot be marked submitted")
            if case.application_status is ApplicationStatus.SUBMITTED:
                return case
            view = self._job_review_view(uow, profile, job, case)
            artifact_id = (
                view.latest_resume_run.artifact.id
                if view.resume_status is ResumeStatus.READY
                and view.latest_resume_run is not None
                and view.latest_resume_run.artifact is not None
                else None
            )
            now = self._clock.now()
            updated = replace(
                case,
                application_status=ApplicationStatus.SUBMITTED,
                submitted_at=now,
                submitted_artifact_id=artifact_id,
                revision=case.revision + 1,
                updated_at=now,
            )
            if not uow.cases.update(updated, expected_revision=case.revision):
                raise RevisionConflictError("job was changed by another operation")
            uow.applications.add_submission(
                ApplicationSubmission(
                    id=self._ids.new(),
                    job_case_id=case.id,
                    decision_at_submission=case.decision,
                    artifact_id=artifact_id,
                    submitted_at=now,
                )
            )
            self._event(
                uow,
                profile_id,
                "application.submitted",
                case.id,
                metadata={
                    "decision": case.decision.value,
                    "artifact_id": artifact_id,
                },
            )
            uow.commit()
            return updated

    async def submit_application(
        self,
        profile_id: str,
        job_id: str,
        draft: SubmitApplicationDraft | None = None,
        *,
        command_id: str | None = None,
    ) -> ApplicationView:
        draft = draft or SubmitApplicationDraft()
        request_fingerprint = _request_fingerprint(
            "application.submit",
            profile_id=profile_id,
            job_id=job_id,
            draft=draft,
        )
        if command_id is not None:
            with self._uow_factory() as uow:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "application.submit", request_fingerprint)
                    existing = uow.tracked_applications.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent application result was not found")
                    return self._application_view(uow, existing)
        if draft.follow_up_at is None:
            raise ValidationError("submission requires an explicit first follow-up date")
        effective_command_id = command_id or self._ids.new()
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if uow.tracked_applications.get_for_job(job_id) is not None:
                raise InvalidTransitionError("an application already exists for this job")
            candidate_run = uow.resume_runs.get_latest(case.id)
            if (
                candidate_run is None
                or candidate_run.stage is not ResumeStage.READY
                or candidate_run.artifact is None
                or not self._resume_run_is_current(uow, profile, job, case, candidate_run)
            ):
                raise InvalidTransitionError("submission requires a current RoleLoop PDF")
            candidate_approval = uow.resume_reviews.get_latest(candidate_run.id)
            if (
                candidate_approval is None
                or candidate_approval.decision is not ResumeReviewDecision.APPROVED
                or candidate_approval.pdf_artifact_id != candidate_run.artifact.id
                or candidate_approval.pdf_checksum != candidate_run.artifact.checksum
            ):
                raise InvalidTransitionError(
                    "explicitly approve the exact RoleLoop PDF before submission"
                )
            artifact_to_verify = candidate_run.artifact
        verified_checksum = await self._verify_pdf_artifact(artifact_to_verify)
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "application.submit", request_fingerprint)
                    existing = uow.tracked_applications.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent application result was not found")
                    return self._application_view(uow, existing)
            if uow.tracked_applications.get_for_job(job_id) is not None:
                raise InvalidTransitionError("an application already exists for this job")
            run = uow.resume_runs.get_latest(case.id)
            if (
                run is None
                or run.stage is not ResumeStage.READY
                or run.artifact is None
                or not self._resume_run_is_current(uow, profile, job, case, run)
            ):
                raise InvalidTransitionError("submission requires a current RoleLoop PDF")
            approval = uow.resume_reviews.get_latest(run.id)
            if (
                approval is None
                or approval.decision is not ResumeReviewDecision.APPROVED
                or approval.pdf_artifact_id != run.artifact.id
                or approval.pdf_checksum != run.artifact.checksum
            ):
                raise InvalidTransitionError(
                    "explicitly approve the exact RoleLoop PDF before submission"
                )
            if (
                run.artifact.id != artifact_to_verify.id
                or run.artifact.checksum != verified_checksum
            ):
                raise RevisionConflictError(
                    "the approved RoleLoop PDF changed while submission was prepared"
                )
            gate = (
                None
                if run.gate_decision_event_id is None
                else uow.decision_events.get(run.gate_decision_event_id)
            )
            if gate is None or gate.decision is not Decision.TAILOR:
                raise InvalidTransitionError("submission requires the pinned Tailor gate")
            submitted_at = draft.submitted_at or self._clock.now()
            if draft.follow_up_at <= submitted_at:
                raise ValidationError("first follow-up must be after submission")
            application = TrackedApplication(
                id=self._ids.new(),
                command_id=effective_command_id,
                job_id=job_id,
                job_case_id=case.id,
                current_stage=ApplicationStage.SUBMITTED,
                approved_resume_review_event_id=approval.id,
                resume_run_id=run.id,
                pdf_artifact_id=run.artifact.id,
                pdf_checksum=run.artifact.checksum,
                job_version_id=run.job_version_id,
                profile_version_id=run.profile_version_id,
                evidence_version_id=run.evidence_version_id,
                review_version_id=run.review_version_id,
                gate_decision_event_id=run.gate_decision_event_id,
                submitted_at=submitted_at,
                created_at=submitted_at,
                updated_at=submitted_at,
            )
            stage = ApplicationStageEvent(
                id=self._ids.new(),
                command_id=f"{effective_command_id}:stage",
                application_id=application.id,
                stage=ApplicationStage.SUBMITTED,
                actor=ActorKind.HUMAN,
                occurred_at=submitted_at,
                recorded_at=self._clock.now(),
            )
            uow.tracked_applications.add(application)
            uow.tracked_applications.add_stage(stage)
            uow.follow_ups.add(
                ApplicationFollowUp(
                    id=self._ids.new(),
                    command_id=f"{effective_command_id}:follow-up",
                    application_id=application.id,
                    due_at=draft.follow_up_at,
                    note=draft.follow_up_note.strip(),
                    trigger_stage_event_id=stage.id,
                    created_at=self._clock.now(),
                )
            )
            updated_case = replace(
                case,
                application_status=ApplicationStatus.SUBMITTED,
                submitted_at=submitted_at,
                submitted_artifact_id=run.artifact.id,
                revision=case.revision + 1,
                updated_at=self._clock.now(),
            )
            if not uow.cases.update(updated_case, expected_revision=case.revision):
                raise RevisionConflictError("job changed while application was submitted")
            if uow.applications.get_submission(case.id) is None:
                uow.applications.add_submission(
                    ApplicationSubmission(
                        self._ids.new(),
                        case.id,
                        Decision.TAILOR,
                        run.artifact.id,
                        submitted_at,
                    )
                )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "application.submit",
                        "tracked_application",
                        application.id,
                        self._clock.now(),
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "application.submitted",
                case.id,
                metadata={
                    "application_id": application.id,
                    "resume_review_event_id": approval.id,
                },
            )
            uow.commit()
            return self._application_view(uow, application)

    def record_application_stage(
        self,
        profile_id: str,
        job_id: str,
        draft: ApplicationStageDraft,
        *,
        command_id: str | None = None,
    ) -> ApplicationView:
        if not isinstance(draft.stage, ApplicationStage):
            raise ValidationError("application stage is invalid")
        if draft.follow_up_at is not None and draft.no_follow_up:
            raise ValidationError("choose a follow-up date or --no-follow-up, not both")
        if draft.stage.is_terminal:
            if draft.follow_up_at is not None:
                raise ValidationError("terminal application stages cannot schedule follow-ups")
        elif (draft.follow_up_at is None) == (not draft.no_follow_up):
            raise ValidationError(
                "nonterminal stages require a follow-up date or explicit --no-follow-up"
            )
        effective_command_id = command_id or self._ids.new()
        request_fingerprint = _request_fingerprint(
            "application.stage",
            profile_id=profile_id,
            job_id=job_id,
            draft=draft,
        )
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            application = uow.tracked_applications.get_for_case(case.id)
            if application is None or application.job_case_id != case.id:
                raise InvalidTransitionError("submit the application before recording stages")
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "application.stage", request_fingerprint)
                    return self._application_view(uow, application)
            if not may_record_application_stage(application.current_stage, draft.stage):
                raise InvalidTransitionError(
                    f"cannot move application from {application.current_stage.value} "
                    f"to {draft.stage.value}"
                )
            now = self._clock.now()
            event = ApplicationStageEvent(
                id=self._ids.new(),
                command_id=effective_command_id,
                application_id=application.id,
                stage=draft.stage,
                actor=ActorKind.HUMAN,
                occurred_at=draft.occurred_at or now,
                recorded_at=now,
                note=draft.note.strip(),
            )
            uow.tracked_applications.add_stage(event)
            updated = replace(
                application,
                current_stage=draft.stage,
                revision=application.revision + 1,
                updated_at=now,
            )
            if not uow.tracked_applications.update(updated, expected_revision=application.revision):
                raise RevisionConflictError("application changed while stage was saved")
            if draft.follow_up_at is not None:
                self._replace_open_follow_up(
                    uow,
                    application.id,
                    draft.follow_up_at,
                    draft.follow_up_note,
                    event.id,
                    effective_command_id,
                )
            elif draft.stage.is_terminal or draft.no_follow_up:
                open_follow_up = uow.follow_ups.get_open_for_application(application.id)
                if open_follow_up is not None:
                    uow.follow_ups.add_resolution(
                        FollowUpResolution(
                            id=self._ids.new(),
                            command_id=f"{effective_command_id}:close-follow-up",
                            follow_up_id=open_follow_up.id,
                            disposition=FollowUpResolutionKind.DISMISSED,
                            note=(
                                "Application reached a terminal stage"
                                if draft.stage.is_terminal
                                else "User explicitly chose no follow-up"
                            ),
                            resolved_at=now,
                        )
                    )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "application.stage",
                        "application_stage_event",
                        event.id,
                        now,
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "application.stage_recorded",
                case.id,
                metadata={"application_id": application.id, "stage": draft.stage.value},
            )
            uow.commit()
            return self._application_view(uow, updated)

    def get_application(self, profile_id: str, job_id: str) -> ApplicationView | None:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            application = uow.tracked_applications.get_for_case(case.id)
            if application is None or application.job_case_id != case.id:
                return None
            return self._application_view(uow, application)

    def list_applications(self, profile_id: str) -> tuple[ApplicationView, ...]:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            applications = tuple(
                application
                for case in uow.cases.list_for_profile(profile_id)
                if (application := uow.tracked_applications.get_for_case(case.id)) is not None
            )
            unique = {item.id: item for item in applications}
            return tuple(
                self._application_view(uow, item)
                for item in sorted(
                    unique.values(), key=lambda value: value.submitted_at, reverse=True
                )
            )

    def list_due_followups(
        self,
        profile_id: str | None = None,
        *,
        at: Any | None = None,
    ) -> tuple[ApplicationFollowUp, ...]:
        with self._uow_factory() as uow:
            if profile_id is not None:
                self._require_profile(uow, profile_id)
            return tuple(uow.follow_ups.list_due(at=at or self._clock.now(), profile_id=profile_id))

    def resolve_followup(
        self,
        profile_id: str,
        follow_up_id: str,
        *,
        note: str = "",
        command_id: str | None = None,
    ) -> FollowUpResolution:
        effective_command_id = command_id or self._ids.new()
        request_fingerprint = _request_fingerprint(
            "follow_up.resolve",
            profile_id=profile_id,
            follow_up_id=follow_up_id,
            note=note.strip(),
        )
        with self._uow_factory() as uow:
            self._require_follow_up_for_profile(uow, profile_id, follow_up_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "follow_up.resolve", request_fingerprint)
                    resolutions = uow.follow_ups.list_resolutions(follow_up_id)
                    existing = next(
                        (item for item in resolutions if item.id == receipt.result_id), None
                    )
                    if existing is None:
                        raise ValidationError("command ID was already used for another operation")
                    return existing
            if uow.follow_ups.list_resolutions(follow_up_id):
                raise InvalidTransitionError("follow-up is already resolved")
            resolution = FollowUpResolution(
                id=self._ids.new(),
                command_id=effective_command_id,
                follow_up_id=follow_up_id,
                disposition=FollowUpResolutionKind.COMPLETED,
                note=note.strip(),
                resolved_at=self._clock.now(),
            )
            uow.follow_ups.add_resolution(resolution)
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "follow_up.resolve",
                        "follow_up_resolution",
                        resolution.id,
                        self._clock.now(),
                        request_fingerprint,
                    )
                )
            uow.commit()
            return resolution

    def reschedule_followup(
        self,
        profile_id: str,
        follow_up_id: str,
        due_at: Any,
        *,
        note: str = "",
        command_id: str | None = None,
    ) -> ApplicationFollowUp:
        effective_command_id = command_id or self._ids.new()
        request_fingerprint = _request_fingerprint(
            "follow_up.reschedule",
            profile_id=profile_id,
            follow_up_id=follow_up_id,
            due_at=due_at,
            note=note.strip(),
        )
        with self._uow_factory() as uow:
            previous = self._require_follow_up_for_profile(uow, profile_id, follow_up_id)
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "follow_up.reschedule", request_fingerprint)
                    if uow.follow_ups.get(receipt.result_id) is None:
                        raise NotFoundError("idempotent follow-up result was not found")
                    existing = self._require_follow_up_for_profile(
                        uow,
                        profile_id,
                        receipt.result_id,
                    )
                    if existing.supersedes_follow_up_id != previous.id:
                        raise ValidationError("command ID was already used for another operation")
                    return existing
            if uow.follow_ups.list_resolutions(follow_up_id):
                raise InvalidTransitionError("follow-up is already resolved")
            replacement = ApplicationFollowUp(
                id=self._ids.new(),
                command_id=effective_command_id,
                application_id=previous.application_id,
                due_at=due_at,
                note=note.strip() or previous.note,
                supersedes_follow_up_id=previous.id,
                created_at=self._clock.now(),
            )
            uow.follow_ups.add(replacement)
            uow.follow_ups.add_resolution(
                FollowUpResolution(
                    id=self._ids.new(),
                    command_id=f"{effective_command_id}:resolution",
                    follow_up_id=previous.id,
                    disposition=FollowUpResolutionKind.RESCHEDULED,
                    replacement_follow_up_id=replacement.id,
                    resolved_at=self._clock.now(),
                )
            )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "follow_up.reschedule",
                        "application_follow_up",
                        replacement.id,
                        self._clock.now(),
                        request_fingerprint,
                    )
                )
            uow.commit()
            return replacement

    def get_followup_history(
        self, profile_id: str, job_id: str
    ) -> tuple[ApplicationFollowUp | FollowUpResolution, ...]:
        view = self.get_application(profile_id, job_id)
        if view is None:
            return ()
        combined: list[ApplicationFollowUp | FollowUpResolution] = [
            *view.follow_up_history,
            *view.follow_up_resolutions,
        ]
        combined.sort(
            key=lambda item: (
                (item.created_at if isinstance(item, ApplicationFollowUp) else item.resolved_at)
                or self._clock.now()
            )
        )
        return tuple(combined)

    def record_outcome(self, profile_id: str, job_id: str, outcome: Outcome) -> JobCase:
        if not isinstance(outcome, Outcome):
            raise ValidationError("outcome is not supported")
        if self._agent_registry is not None:
            raise InvalidTransitionError(
                "authoritative outcomes must use record_application_stage with a fixed "
                "terminal stage"
            )
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            if case.application_status is not ApplicationStatus.SUBMITTED:
                raise InvalidTransitionError(
                    "mark the application submitted before recording an outcome"
                )
            if case.current_outcome is outcome:
                return case
            now = self._clock.now()
            updated = replace(
                case,
                current_outcome=outcome,
                revision=case.revision + 1,
                updated_at=now,
            )
            if not uow.cases.update(updated, expected_revision=case.revision):
                raise RevisionConflictError("job was changed by another operation")
            uow.applications.add_outcome(
                OutcomeEvent(
                    id=self._ids.new(),
                    job_case_id=case.id,
                    outcome=outcome,
                    recorded_at=now,
                )
            )
            self._event(
                uow,
                profile_id,
                "application.outcome_recorded",
                case.id,
                metadata={"outcome": outcome.value},
            )
            uow.commit()
            return updated

    # Internal read-model and persistence helpers -------------------------

    async def _generate_resume_authoritative(
        self,
        profile_id: str,
        job_id: str,
        *,
        parent_run: ResumeRun | None,
        feedback_event: ResumeReviewEvent | None,
        command_id: str | None,
        progress: ProgressReporter | None,
        prequeued_run_id: str | None = None,
    ) -> ResumeRun:
        registry = self._require_provider(self._agent_registry, "agent provider registry")
        renderer = self._require_provider(self._master_resume_renderer, "master résumé renderer")
        inspector = self._require_provider(self._pdf_inspector, "PDF inspection")
        store = self._require_provider(self._artifact_store, "artifact storage")
        reporter = progress or NullProgressReporter()
        prequeued_run: ResumeRun | None = None
        prequeued_agent_run: AgentRun | None = None
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            profile_version = uow.profile_versions.get_current(profile_id)
            job_version = uow.job_versions.get_current(job_id)
            review = uow.reviews.get_latest(case.id)
            gate = (
                None
                if case.current_decision_event_id is None
                else uow.decision_events.get(case.current_decision_event_id)
            )
            evidence = (
                None
                if profile.active_evidence_version_id is None
                else uow.evidence.get(profile.active_evidence_version_id)
            )
            if (
                profile_version is None
                or job_version is None
                or review is None
                or review.legacy_input_status != "native"
                or gate is None
                or evidence is None
            ):
                raise InvalidTransitionError("tailoring requires complete pinned workflow inputs")
            if gate.decision is not Decision.TAILOR or gate.review_version_id != review.id:
                raise InvalidTransitionError("a current human Tailor gate is required")
            if (
                gate.job_version_id != job_version.id
                or gate.profile_version_id != profile_version.id
                or gate.evidence_version_id != evidence.id
            ):
                raise InvalidTransitionError("Tailor gate is stale; review and decide again")
            if evidence.source_revision is None or evidence.contract_schema_version is None:
                raise InvalidTransitionError("master résumé contract snapshot is incomplete")
            answer_events = tuple(uow.answer_events.list_for_case(case.id))
            answer_fingerprint = answer_set_fingerprint(answer_events)
            if (
                review.answer_set_fingerprint != answer_fingerprint
                or gate.answer_set_fingerprint != answer_fingerprint
            ):
                raise InvalidTransitionError("answers changed after review or Tailor gate")
            answers = _latest_answers_for_review(uow, review, answer_events)
            if derive_eligibility(review.questions, answers) is not EligibilityStatus.ELIGIBLE:
                raise InvalidTransitionError("required verification answers are unresolved")
            request_fingerprint = _request_fingerprint(
                "resume.generate",
                profile_id=profile_id,
                job_id=job_id,
                parent_resume_run_id=(None if parent_run is None else parent_run.id),
                feedback_review_event_id=(None if feedback_event is None else feedback_event.id),
                gate_decision_event_id=gate.id,
            )
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "resume.generate", request_fingerprint)
                    existing = uow.resume_runs.get(receipt.result_id)
                    if existing is None:
                        raise NotFoundError("idempotent résumé result was not found")
                    if prequeued_run_id is None or existing.id != prequeued_run_id:
                        return existing
                    prequeued_run = existing
                    if existing.agent_run_id is None:
                        raise InvalidTransitionError(
                            "queued résumé is missing its Resume agent run"
                        )
                    prequeued_agent_run = uow.agent_runs.get(existing.agent_run_id)
                    if prequeued_agent_run is None:
                        raise NotFoundError("queued Resume agent run was not found")
                elif prequeued_run_id is not None:
                    raise InvalidTransitionError("prequeued résumé is missing its command receipt")
            elif prequeued_run_id is not None:
                raise ValidationError("a prequeued résumé requires a command ID")
            if prequeued_run is None and any(
                item.job_case_id == case.id for item in uow.resume_runs.list_in_progress()
            ):
                raise InvalidTransitionError("résumé generation is already in progress")
        agent = registry.resume(profile_version)
        descriptor = _validated_agent_descriptor(
            agent.descriptor, profile_version, AgentKind.RESUME
        )
        fingerprint = authoritative_resume_fingerprint(
            review_version_id=review.id,
            gate_decision_event_id=gate.id,
            job_version_id=job_version.id,
            profile_version_id=profile_version.id,
            evidence_version_id=evidence.id,
            evidence_source_revision=evidence.source_revision,
            answer_fingerprint=answer_fingerprint,
            model=descriptor.model,
            prompt_version=descriptor.prompt_version,
            prompt_hash=descriptor.prompt_hash,
            schema_version=descriptor.output_schema_version,
            schema_hash=descriptor.output_schema_hash,
            renderer_protocol_version=renderer.protocol_version,
            renderer_version=evidence.renderer_version or "",
            parent_resume_run_id=None if parent_run is None else parent_run.id,
            feedback_review_event_id=(None if feedback_event is None else feedback_event.id),
        )
        now = self._clock.now()
        if prequeued_run is not None and prequeued_agent_run is not None:
            run = prequeued_run
            agent_run = prequeued_agent_run
            if (
                run.stage is not ResumeStage.QUEUED
                or agent_run.status is not AgentRunStatus.QUEUED
                or run.job_case_id != case.id
                or run.review_version_id != review.id
                or run.evidence_version_id != evidence.id
                or run.input_fingerprint != fingerprint
                or run.parent_resume_run_id != (None if parent_run is None else parent_run.id)
                or run.feedback_review_event_id
                != (None if feedback_event is None else feedback_event.id)
                or run.gate_decision_event_id != gate.id
                or run.job_version_id != job_version.id
                or run.profile_version_id != profile_version.id
                or agent_run.command_id != command_id
                or agent_run.input_fingerprint != fingerprint
                or agent_run.kind is not AgentKind.RESUME
            ):
                raise InvalidTransitionError(
                    "prequeued résumé no longer matches its exact pinned inputs"
                )
            agent_run = replace(
                agent_run,
                status=AgentRunStatus.RUNNING,
                started_at=now,
            )
            with self._uow_factory() as uow:
                persisted = uow.agent_runs.get(agent_run.id)
                if persisted is None or persisted.status is not AgentRunStatus.QUEUED:
                    raise InvalidTransitionError(
                        "queued Resume agent run is already executing or finished"
                    )
                uow.agent_runs.update(agent_run)
                uow.commit()
        else:
            effective_command_id = command_id or self._ids.new()
            agent_run = AgentRun(
                id=self._ids.new(),
                command_id=effective_command_id,
                kind=AgentKind.RESUME,
                provider=descriptor.provider,
                model=descriptor.model,
                prompt_version=descriptor.prompt_version,
                output_schema_version=descriptor.output_schema_version,
                profile_id=profile_id,
                job_case_id=case.id,
                input_fingerprint=fingerprint,
                status=AgentRunStatus.RUNNING,
                prompt_hash=descriptor.prompt_hash,
                output_schema_hash=descriptor.output_schema_hash,
                started_at=now,
                created_at=now,
            )
            run = ResumeRun(
                id=self._ids.new(),
                job_case_id=case.id,
                review_version_id=review.id,
                evidence_version_id=evidence.id,
                input_fingerprint=fingerprint,
                stage=ResumeStage.QUEUED,
                generator_version=descriptor.prompt_version,
                validator_version=evidence.contract_schema_version,
                compiler_version=renderer.protocol_version,
                created_at=now,
                updated_at=now,
                agent_run_id=agent_run.id,
                parent_resume_run_id=None if parent_run is None else parent_run.id,
                feedback_review_event_id=(None if feedback_event is None else feedback_event.id),
                gate_decision_event_id=gate.id,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                answer_set_fingerprint=answer_fingerprint,
            )
            with self._uow_factory() as uow:
                uow.agent_runs.add(agent_run)
                uow.resume_runs.add(run)
                if command_id is not None:
                    uow.commands.add(
                        CommandReceipt(
                            command_id,
                            "resume.generate",
                            "resume_run",
                            run.id,
                            now,
                            request_fingerprint,
                        )
                    )
                uow.commit()
        try:
            run = self._advance_run(run, ResumeStage.DRAFTING)
            selection = await agent.select(
                ResumeSelectionContext(
                    profile=profile,
                    profile_version=profile_version,
                    evidence=evidence,
                    job=job,
                    job_version=job_version,
                    review=review,
                    answers=answers,
                    parent_resume_run=parent_run,
                    feedback="" if feedback_event is None else feedback_event.feedback,
                ),
                progress=reporter,
            )
            _validate_agent_audit(selection.audit, descriptor)
            selection = _validated_resume_selection(selection)
            selection_payload = json.dumps(
                {
                    "headline": selection.headline,
                    "experiences": [
                        {
                            "experience_id": item.experience_id,
                            "bullet_ids": list(item.bullet_ids),
                        }
                        for item in selection.experiences
                    ],
                    "skill_ids": list(selection.skill_ids),
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            run, agent_run = self._persist_resume_selection_success(
                run,
                agent_run,
                selection.audit,
                structured_draft=json.loads(selection_payload),
                headline=selection.headline,
                selected_experiences=selection.experiences,
                selected_bullet_ids=tuple(
                    bullet
                    for experience in selection.experiences
                    for bullet in experience.bullet_ids
                ),
                selected_skill_ids=selection.skill_ids,
            )
            rendered = await renderer.render(
                MasterResumeRenderRequest(
                    evidence,
                    selection,
                    job_version,
                    profile_version,
                ),
                progress=reporter,
            )
            inspection = inspector.inspect(rendered.pdf)
            if not inspection.valid or inspection.errors:
                raise ArtifactError(
                    "rendered PDF failed inspection: " + "; ".join(inspection.errors)
                )
            if rendered.page_count != inspection.page_count:
                raise ArtifactError("renderer and PDF inspector page counts disagree")
            if rendered.page_count > profile_version.page_limit:
                raise ArtifactError("rendered PDF exceeds the profile page limit")
            if not rendered.pdf.startswith(b"%PDF-"):
                raise ArtifactError("master renderer returned invalid PDF content")
            if rendered.renderer_source_revision != evidence.source_revision:
                raise ArtifactError(
                    "renderer source revision differs from the Reviewer-pinned commit"
                )
            if rendered.renderer_version != evidence.renderer_version:
                raise ArtifactError("renderer version differs from the Reviewer-pinned contract")
            pdf_checksum = hashlib.sha256(rendered.pdf).hexdigest()
            selection_checksum = hashlib.sha256(rendered.selection_file).hexdigest()
            tailored_source_checksum = hashlib.sha256(rendered.tailored_source_bundle).hexdigest()
            receipt_checksums = set(rendered.output_checksums.values())
            if pdf_checksum not in receipt_checksums:
                raise ArtifactError("render receipt does not contain the PDF checksum")
            if selection_checksum not in receipt_checksums:
                raise ArtifactError(
                    "render receipt does not contain the exact selection-file checksum"
                )
            if tailored_source_checksum not in receipt_checksums:
                raise ArtifactError("render receipt does not contain the tailored source checksum")
            if evidence.source_bundle_artifact is None:
                raise ArtifactError("pinned evidence is missing its source bundle")
            try:
                exact_selection = json.loads(rendered.selection_file)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ArtifactError("renderer returned an invalid selection JSON file") from exc
            if not isinstance(exact_selection, dict):
                raise ArtifactError("renderer selection file must contain a JSON object")
            pdf_artifact = await store.put_bytes(
                rendered.pdf,
                media_type=rendered.media_type,
                extension=rendered.extension,
            )
            selection_artifact = await store.put_bytes(
                rendered.selection_file,
                media_type="application/json",
                extension=".json",
            )
            tailored_source_artifact = await store.put_bytes(
                rendered.tailored_source_bundle,
                media_type="application/x-tar",
                extension=".tar",
            )
            receipt_artifact = await store.put_bytes(
                rendered.receipt,
                media_type="application/json",
                extension=".json",
            )
            review_file_artifact = await store.put_bytes(
                rendered.review_file,
                media_type="text/markdown",
                extension=".md",
            )
            compile_log_artifact = await store.put_bytes(
                rendered.compile_log,
                media_type="text/plain",
                extension=".log",
            )
            ats_artifact = await store.put_bytes(
                rendered.ats_text.encode("utf-8"),
                media_type="text/plain",
                extension=".txt",
            )
            run = self._finalize_resume_success(
                run,
                agent_run,
                command_id=command_id,
                request_fingerprint=request_fingerprint,
                artifact=pdf_artifact,
                selection_artifact=selection_artifact,
                tailored_source_bundle_artifact=tailored_source_artifact,
                render_receipt_artifact=receipt_artifact,
                review_file_artifact=review_file_artifact,
                compile_log_artifact=compile_log_artifact,
                ats_text_artifact=ats_artifact,
                rendered_page_count=rendered.page_count,
                renderer_source_revision=rendered.renderer_source_revision,
                render_tool_versions=dict(rendered.tool_versions),
                render_output_checksums=dict(rendered.output_checksums),
            )
            return run
        except asyncio.CancelledError as exc:
            self._finish_agent_failure(agent_run, exc)
            self._advance_run(
                run, ResumeStage.INTERRUPTED, error_message="operation was interrupted"
            )
            raise
        except ApplicationError as exc:
            self._finish_agent_failure(agent_run, exc)
            self._fail_run(run, exc.message)
            raise
        except Exception as exc:
            self._finish_agent_failure(agent_run, exc)
            code, message = _sanitized_error(exc)
            self._fail_run(run, message)
            raise ProviderFailureError(f"résumé workflow failed ({code}): {message}") from exc

    async def _run_scout(
        self,
        profile_id: str,
        *,
        mode: ScoutMode,
        requested_url: str | None,
        limit: int,
        command_id: str | None,
        progress: ProgressReporter | None,
    ) -> tuple[JobCase, ...]:
        registry = self._require_provider(self._agent_registry, "agent provider registry")
        reporter = progress or NullProgressReporter()
        request_fingerprint = _request_fingerprint(
            "scout.run",
            profile_id=profile_id,
            mode=mode,
            requested_url=requested_url,
            limit=limit,
        )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            profile_version = uow.profile_versions.get_current(profile_id)
            if profile_version is None:
                raise InvalidTransitionError("profile has no reproducible current version")
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "scout.run", request_fingerprint)
                    return tuple(
                        self._require_case_for_job(uow, profile_id, candidate.job_id)
                        for candidate in uow.agent_runs.list_scout_candidates(receipt.result_id)
                    )
                prior_attempt = uow.agent_runs.get_by_command_id(command_id)
                if prior_attempt is not None:
                    raise InvalidTransitionError(
                        "this Scout command did not complete; retry with a new command ID"
                    )
        agent = registry.scout(profile_version)
        descriptor = _validated_agent_descriptor(agent.descriptor, profile_version, AgentKind.SCOUT)
        effective_command_id = command_id or self._ids.new()
        run_id = self._ids.new()
        started_at = self._clock.now()
        input_fingerprint = stable_fingerprint(
            profile_version_id=profile_version.id,
            mode=mode.value,
            requested_url=requested_url,
            limit=limit,
            model=descriptor.model,
            prompt_version=descriptor.prompt_version,
            prompt_hash=descriptor.prompt_hash,
            schema_version=descriptor.output_schema_version,
            schema_hash=descriptor.output_schema_hash,
        )
        agent_run = AgentRun(
            id=run_id,
            command_id=effective_command_id,
            kind=AgentKind.SCOUT,
            provider=descriptor.provider,
            model=descriptor.model,
            prompt_version=descriptor.prompt_version,
            output_schema_version=descriptor.output_schema_version,
            profile_id=profile_id,
            job_case_id=None,
            input_fingerprint=input_fingerprint,
            status=AgentRunStatus.RUNNING,
            prompt_hash=descriptor.prompt_hash,
            output_schema_hash=descriptor.output_schema_hash,
            started_at=started_at,
            created_at=started_at,
        )
        with self._uow_factory() as uow:
            uow.agent_runs.add(agent_run)
            uow.commit()
        try:
            report = await agent.discover(
                ScoutContext(profile, profile_version, mode, requested_url, limit),
                progress=reporter,
            )
            _validate_agent_audit(report.audit, descriptor)
        except BaseException as exc:
            self._finish_agent_failure(agent_run, exc)
            raise

        try:
            prepared = _prepare_scout_candidates(report.candidates, limit)
            return self._persist_scout_success(
                agent_run=agent_run,
                report=report,
                profile_id=profile_id,
                profile_version=profile_version,
                mode=mode,
                requested_url=requested_url,
                limit=limit,
                command_id=command_id,
                request_fingerprint=request_fingerprint,
                prepared=prepared,
            )
        except BaseException as exc:
            self._finish_agent_failure(agent_run, exc)
            raise

    def _persist_scout_success(
        self,
        *,
        agent_run: AgentRun,
        report: ScoutReport,
        profile_id: str,
        profile_version: SearchProfileVersion,
        mode: ScoutMode,
        requested_url: str | None,
        limit: int,
        command_id: str | None,
        request_fingerprint: str,
        prepared: Mapping[str, _PreparedScoutCandidate],
    ) -> tuple[JobCase, ...]:
        now = self._clock.now()
        with self._uow_factory() as uow:
            persisted = uow.agent_runs.get(agent_run.id)
            if persisted is None:
                raise NotFoundError("Scout run disappeared while executing")
            cases: list[JobCase] = []
            candidates: list[ScoutCandidate] = []
            scout_run_id = self._ids.new()
            for position, (canonical, prepared_item) in enumerate(prepared.items()):
                item = prepared_item.candidate
                job, case, _ = self._add_job_case(
                    uow,
                    profile_id,
                    canonical,
                    item.details,
                    item.sources,
                    identity_alias_urls=prepared_item.identity_alias_urls,
                )
                version = uow.job_versions.get_current(job.id)
                if version is None:
                    raise InvalidTransitionError("Scout job did not create an immutable version")
                self._ensure_screens_and_auto_skip(
                    uow,
                    profile_version,
                    version,
                    case,
                )
                case = uow.cases.get(case.id) or case
                cases.append(case)
                candidates.append(
                    ScoutCandidate(
                        scout_run_id,
                        position,
                        job.id,
                        version.id,
                        canonical,
                    )
                )
            uow.agent_runs.update(
                replace(
                    persisted,
                    status=AgentRunStatus.SUCCEEDED,
                    provider_response_id=report.audit.provider_response_id,
                    response_model=report.audit.response_model,
                    input_tokens=report.audit.input_tokens,
                    output_tokens=report.audit.output_tokens,
                    total_tokens=report.audit.total_tokens,
                    source_urls=tuple(dict.fromkeys(report.audit.source_urls)),
                    status_detail=report.audit.status_detail,
                    finished_at=now,
                )
            )
            uow.agent_runs.add_scout_run(
                ScoutRun(
                    scout_run_id,
                    agent_run.id,
                    profile_version.id,
                    mode,
                    requested_url,
                    limit,
                    now,
                ),
                candidates,
            )
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "scout.run",
                        "scout_run",
                        scout_run_id,
                        now,
                        request_fingerprint,
                    )
                )
            uow.commit()
            return tuple(cases)

    async def _review_job_authoritative(
        self,
        profile_id: str,
        job_id: str,
        *,
        rerun: bool,
        command_id: str | None,
        progress: ProgressReporter | None,
    ) -> JobReviewView:
        registry = self._require_provider(self._agent_registry, "agent provider registry")
        reporter = progress or NullProgressReporter()
        request_fingerprint = _request_fingerprint(
            "review.run",
            profile_id=profile_id,
            job_id=job_id,
            rerun=rerun,
        )
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            job = self._require_job(uow, job_id)
            case = self._require_case_for_job(uow, profile_id, job_id)
            profile_version = uow.profile_versions.get_current(profile_id)
            job_version = uow.job_versions.get_current(job_id)
            if profile_version is None or job_version is None:
                raise InvalidTransitionError("job and profile require immutable current versions")
            if profile.active_evidence_version_id is None:
                raise InvalidTransitionError("synchronize master résumé evidence before review")
            evidence = uow.evidence.get(profile.active_evidence_version_id)
            if evidence is None or evidence.source_revision is None:
                raise InvalidTransitionError("current résumé evidence is not commit-pinned")
            if evidence.contract_schema_version is None:
                raise InvalidTransitionError("current résumé evidence lacks the v1 contract")
            if command_id is not None:
                receipt = uow.commands.get(command_id)
                if receipt is not None:
                    _validate_command_replay(receipt, "review.run", request_fingerprint)
                    if receipt.result_type == "job_case":
                        if receipt.result_id != case.id:
                            raise NotFoundError(
                                "idempotent screening result was not found for this job"
                            )
                        return self._job_review_view(uow, profile, job, case)
                    stored = uow.reviews.get(receipt.result_id)
                    if stored is None:
                        raise NotFoundError("idempotent review result was not found")
                    return self._job_review_view(uow, profile, job, case)
                prior_attempt = uow.agent_runs.get_by_command_id(command_id)
                if prior_attempt is not None:
                    raise InvalidTransitionError(
                        "this Reviewer command did not complete; retry with a new command ID"
                    )
            screens = self._ensure_screens_and_auto_skip(uow, profile_version, job_version, case)
            hard_blockers = tuple(uow.profile_versions.list_rules(profile_version.id))
            failed = any(item.result is ScreenResult.FAIL for item in screens)
            if failed:
                if command_id is not None:
                    uow.commands.add(
                        CommandReceipt(
                            command_id,
                            "review.run",
                            "job_case",
                            case.id,
                            self._clock.now(),
                            request_fingerprint,
                        )
                    )
                uow.commit()
                refreshed = uow.cases.get(case.id) or case
                return self._job_review_view(uow, profile, job, refreshed)
            answer_events = tuple(uow.answer_events.list_for_case(case.id))
            answer_fingerprint = answer_set_fingerprint(answer_events)
            screens_fingerprint = screen_set_fingerprint(screens)
            sources = tuple(uow.job_versions.list_sources(job_version.id))
            latest = uow.reviews.get_latest(case.id)
            latest_answers = (
                {} if latest is None else _latest_answers_for_review(uow, latest, answer_events)
            )
        agent = registry.reviewer(profile_version)
        descriptor = _validated_agent_descriptor(
            agent.descriptor, profile_version, AgentKind.REVIEWER
        )
        fingerprint = authoritative_review_fingerprint(
            job_version_id=job_version.id,
            profile_version_id=profile_version.id,
            evidence_version_id=evidence.id,
            evidence_source_revision=evidence.source_revision,
            answer_fingerprint=answer_fingerprint,
            screen_fingerprint=screens_fingerprint,
            model=descriptor.model,
            prompt_version=descriptor.prompt_version,
            prompt_hash=descriptor.prompt_hash,
            schema_version=descriptor.output_schema_version,
            schema_hash=descriptor.output_schema_hash,
        )
        if not rerun and latest is not None and latest.fingerprint == fingerprint:
            with self._uow_factory() as uow:
                profile = self._require_profile(uow, profile_id)
                job = self._require_job(uow, job_id)
                case = self._require_case_for_job(uow, profile_id, job_id)
                if command_id is not None:
                    uow.commands.add(
                        CommandReceipt(
                            command_id,
                            "review.run",
                            "review_version",
                            latest.id,
                            self._clock.now(),
                            request_fingerprint,
                        )
                    )
                    uow.commit()
                return self._job_review_view(uow, profile, job, case)
        effective_command_id = command_id or self._ids.new()
        now = self._clock.now()
        agent_run = AgentRun(
            id=self._ids.new(),
            command_id=effective_command_id,
            kind=AgentKind.REVIEWER,
            provider=descriptor.provider,
            model=descriptor.model,
            prompt_version=descriptor.prompt_version,
            output_schema_version=descriptor.output_schema_version,
            profile_id=profile_id,
            job_case_id=case.id,
            input_fingerprint=fingerprint,
            status=AgentRunStatus.RUNNING,
            prompt_hash=descriptor.prompt_hash,
            output_schema_hash=descriptor.output_schema_hash,
            started_at=now,
            created_at=now,
        )
        with self._uow_factory() as uow:
            uow.agent_runs.add(agent_run)
            uow.commit()
        try:
            report = await agent.analyze(
                ReviewerContext(
                    profile=profile,
                    profile_version=profile_version,
                    hard_blockers=hard_blockers,
                    evidence=evidence,
                    job=job,
                    job_version=job_version,
                    sources=sources,
                    latest_answers=latest_answers,
                    screen_evaluations=screens,
                ),
                progress=reporter,
            )
            _validate_agent_audit(report.audit, descriptor)
            match_evidence = _validated_findings(report.match_evidence, "strength")
            skeptic_findings = _validated_findings(report.skeptic_findings, "gap")
            questions = _merge_review_questions(screens, report.questions)
            requirements = _validated_review_requirements(report.requirements)
            if not 0.0 <= report.confidence <= 1.0:
                raise ProviderFailureError("Reviewer confidence must be between 0 and 1")
            if not report.positioning.strip() or not report.self_critique.strip():
                raise ProviderFailureError("Reviewer must provide positioning and self-critique")
        except BaseException as exc:
            self._finish_agent_failure(agent_run, exc)
            raise
        completed_at = self._clock.now()
        review = ReviewVersion(
            id=self._ids.new(),
            job_case_id=case.id,
            fingerprint=fingerprint,
            analyzer_version=(
                f"{descriptor.provider.value}:{descriptor.model}:"
                f"{descriptor.prompt_version}:{descriptor.output_schema_version}"
            ),
            match_evidence=match_evidence,
            skeptic_findings=skeptic_findings,
            questions=questions,
            created_at=completed_at,
            agent_run_id=agent_run.id,
            job_version_id=job_version.id,
            profile_version_id=profile_version.id,
            evidence_version_id=evidence.id,
            answer_set_fingerprint=answer_fingerprint,
            screen_set_fingerprint=screens_fingerprint,
            recommended_decision=report.recommended_decision,
            requirements=requirements,
            confidence=report.confidence,
            positioning=report.positioning.strip(),
            self_critique=report.self_critique.strip(),
        )
        try:
            return self._persist_reviewer_success(
                agent_run=agent_run,
                report=report,
                review=review,
                profile_id=profile_id,
                job_id=job_id,
                case=case,
                profile_version=profile_version,
                job_version=job_version,
                evidence=evidence,
                answer_fingerprint=answer_fingerprint,
                command_id=command_id,
                request_fingerprint=request_fingerprint,
                completed_at=completed_at,
            )
        except BaseException as exc:
            self._finish_agent_failure(agent_run, exc)
            raise

    def _persist_reviewer_success(
        self,
        *,
        agent_run: AgentRun,
        report: ReviewerReport,
        review: ReviewVersion,
        profile_id: str,
        job_id: str,
        case: JobCase,
        profile_version: SearchProfileVersion,
        job_version: JobVersion,
        evidence: ResumeEvidenceVersion,
        answer_fingerprint: str,
        command_id: str | None,
        request_fingerprint: str,
        completed_at: datetime,
    ) -> JobReviewView:
        with self._uow_factory() as uow:
            current_profile = self._require_profile(uow, profile_id)
            current_job = self._require_job(uow, job_id)
            current_case = self._require_case_for_job(uow, profile_id, job_id)
            if (
                current_profile.current_version_id != profile_version.id
                or current_job.current_version_id != job_version.id
                or current_profile.active_evidence_version_id != evidence.id
                or answer_set_fingerprint(uow.answer_events.list_for_case(case.id))
                != answer_fingerprint
            ):
                raise RevisionConflictError("review inputs changed while Reviewer was running")
            uow.reviews.add(review)
            persisted_run = uow.agent_runs.get(agent_run.id)
            if persisted_run is None:
                raise NotFoundError("Reviewer agent run was not found")
            uow.agent_runs.update(
                replace(
                    persisted_run,
                    status=AgentRunStatus.SUCCEEDED,
                    provider_response_id=report.audit.provider_response_id,
                    response_model=report.audit.response_model,
                    input_tokens=report.audit.input_tokens,
                    output_tokens=report.audit.output_tokens,
                    total_tokens=report.audit.total_tokens,
                    source_urls=tuple(dict.fromkeys(report.audit.source_urls)),
                    status_detail=report.audit.status_detail,
                    finished_at=completed_at,
                )
            )
            touched = replace(
                current_case,
                revision=current_case.revision + 1,
                updated_at=completed_at,
            )
            if not uow.cases.update(touched, expected_revision=current_case.revision):
                raise RevisionConflictError("job changed while review was saved")
            if command_id is not None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "review.run",
                        "review_version",
                        review.id,
                        completed_at,
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                profile_id,
                "review.completed",
                case.id,
                metadata={"review_version_id": review.id, "agent_run_id": agent_run.id},
            )
            uow.commit()
            return self._job_review_view(uow, current_profile, current_job, touched)

    def _ensure_screens_and_auto_skip(
        self,
        uow: UnitOfWork,
        profile_version: SearchProfileVersion,
        job_version: JobVersion,
        case: JobCase,
    ) -> tuple[ScreenEvaluation, ...]:
        existing = tuple(uow.screens.list_current(case.id, job_version.id, profile_version.id))
        rules = tuple(uow.profile_versions.list_rules(profile_version.id))
        if len(existing) == len(rules):
            evaluations = existing
        else:
            now = self._clock.now()
            evaluations = tuple(
                _evaluate_screen_rule(
                    self._ids.new(), case, job_version, profile_version, rule, now
                )
                for rule in rules
            )
            uow.screens.add_all(evaluations)
        failed = next(
            (item for item in evaluations if item.result is ScreenResult.FAIL),
            None,
        )
        application = uow.tracked_applications.get_for_job(job_version.job_id)
        if failed is not None and case.decision is not Decision.SKIP and application is None:
            now = self._clock.now()
            decision = CaseDecisionEvent(
                id=self._ids.new(),
                command_id=self._ids.new(),
                job_case_id=case.id,
                decision=Decision.SKIP,
                reason=DecisionReason.DETERMINISTIC_HARD_BLOCKER,
                actor=ActorKind.SYSTEM,
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                screen_evaluation_id=failed.id,
                supersedes_decision_event_id=case.current_decision_event_id,
                rationale=failed.detail,
                decided_at=now,
            )
            uow.decision_events.add(decision)
            updated = replace(
                case,
                decision=Decision.SKIP,
                current_decision_event_id=decision.id,
                revision=case.revision + 1,
                updated_at=now,
            )
            if not uow.cases.update(updated, expected_revision=case.revision):
                raise RevisionConflictError("job changed while screening was saved")
        return evaluations

    def _finish_agent_failure(self, run: AgentRun, exc: BaseException) -> None:
        with self._uow_factory() as uow:
            persisted = uow.agent_runs.get(run.id)
            if persisted is None or persisted.status not in {
                AgentRunStatus.QUEUED,
                AgentRunStatus.RUNNING,
            }:
                return
            interrupted = isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt))
            code, message = _sanitized_error(exc)
            uow.agent_runs.update(
                replace(
                    persisted,
                    status=(AgentRunStatus.INTERRUPTED if interrupted else AgentRunStatus.FAILED),
                    error_code=code,
                    error_message=message,
                    finished_at=self._clock.now(),
                )
            )
            uow.commit()

    def _finalize_resume_success(
        self,
        run: ResumeRun,
        agent_run: AgentRun,
        *,
        command_id: str | None,
        request_fingerprint: str,
        **changes: Any,
    ) -> ResumeRun:
        """Publish deterministic render artifacts after the Resume agent succeeded."""

        completed_at = self._clock.now()
        with self._uow_factory() as uow:
            persisted_run = uow.resume_runs.get(run.id)
            persisted_agent = uow.agent_runs.get(agent_run.id)
            if persisted_run is None:
                raise NotFoundError("résumé run disappeared before finalization")
            if persisted_agent is None:
                raise NotFoundError("Resume agent run disappeared before finalization")
            if (
                persisted_run.stage is not ResumeStage.COMPILING
                or persisted_agent.status is not AgentRunStatus.SUCCEEDED
                or persisted_run.agent_run_id != persisted_agent.id
                or persisted_run.input_fingerprint != persisted_agent.input_fingerprint
            ):
                raise InvalidTransitionError(
                    "résumé and Resume agent are not in matching finalization states"
                )
            case = uow.cases.get(persisted_run.job_case_id)
            if case is None:
                raise NotFoundError("job case disappeared before résumé finalization")
            profile = uow.profiles.get(case.profile_id)
            job = uow.jobs.get(case.job_id)
            if profile is None or job is None:
                raise NotFoundError("workflow inputs disappeared before résumé finalization")
            if not self._resume_run_matches_current_inputs(
                uow,
                profile,
                job,
                case,
                persisted_run,
                expected_agent_status=AgentRunStatus.SUCCEEDED,
            ):
                raise RevisionConflictError("résumé inputs changed while Resume was running")
            ready = replace(
                persisted_run,
                stage=ResumeStage.READY,
                updated_at=completed_at,
                **changes,
            )
            _register_resume_run_artifacts(uow, ready)
            uow.resume_runs.update(ready)
            if command_id is not None and uow.commands.get(command_id) is None:
                uow.commands.add(
                    CommandReceipt(
                        command_id,
                        "resume.generate",
                        "resume_run",
                        ready.id,
                        completed_at,
                        request_fingerprint,
                    )
                )
            self._event(
                uow,
                case.profile_id,
                "resume.ready",
                case.id,
                metadata={
                    "resume_run_id": ready.id,
                    "stage": ResumeStage.READY.value,
                    "from_stage": persisted_run.stage.value,
                    "error": ready.error_message,
                },
            )
            uow.commit()
            return ready

    def _persist_resume_selection_success(
        self,
        run: ResumeRun,
        agent_run: AgentRun,
        audit: AgentAudit,
        **changes: Any,
    ) -> tuple[ResumeRun, AgentRun]:
        """Commit the provider result before deterministic rendering begins."""

        completed_at = self._clock.now()
        with self._uow_factory() as uow:
            persisted_run = uow.resume_runs.get(run.id)
            persisted_agent = uow.agent_runs.get(agent_run.id)
            if persisted_run is None:
                raise NotFoundError("résumé run disappeared after Resume selection")
            if persisted_agent is None:
                raise NotFoundError("Resume agent run disappeared after selection")
            if (
                persisted_run.stage is not ResumeStage.DRAFTING
                or persisted_agent.status is not AgentRunStatus.RUNNING
                or persisted_run.agent_run_id != persisted_agent.id
                or persisted_run.input_fingerprint != persisted_agent.input_fingerprint
            ):
                raise InvalidTransitionError(
                    "résumé and Resume agent are not in matching selection states"
                )
            case = uow.cases.get(persisted_run.job_case_id)
            if case is None:
                raise NotFoundError("job case disappeared after Resume selection")
            profile = uow.profiles.get(case.profile_id)
            job = uow.jobs.get(case.job_id)
            if profile is None or job is None:
                raise NotFoundError("workflow inputs disappeared after Resume selection")
            if not self._resume_run_matches_current_inputs(
                uow,
                profile,
                job,
                case,
                persisted_run,
                expected_agent_status=AgentRunStatus.RUNNING,
            ):
                raise RevisionConflictError("résumé inputs changed while Resume was selecting")
            compiling = replace(
                persisted_run,
                stage=ResumeStage.COMPILING,
                updated_at=completed_at,
                **changes,
            )
            succeeded_agent = replace(
                persisted_agent,
                status=AgentRunStatus.SUCCEEDED,
                provider_response_id=audit.provider_response_id,
                response_model=audit.response_model,
                input_tokens=audit.input_tokens,
                output_tokens=audit.output_tokens,
                total_tokens=audit.total_tokens,
                source_urls=tuple(dict.fromkeys(audit.source_urls)),
                status_detail=audit.status_detail,
                finished_at=completed_at,
            )
            uow.resume_runs.update(compiling)
            uow.agent_runs.update(succeeded_agent)
            self._event(
                uow,
                case.profile_id,
                "resume.compiling",
                case.id,
                metadata={
                    "resume_run_id": compiling.id,
                    "stage": ResumeStage.COMPILING.value,
                    "from_stage": persisted_run.stage.value,
                    "error": compiling.error_message,
                },
            )
            uow.commit()
            return compiling, succeeded_agent

    def _resume_run_is_current(
        self,
        uow: UnitOfWork,
        profile: SearchProfile,
        job: Job,
        case: JobCase,
        run: ResumeRun,
    ) -> bool:
        expected_agent_status = AgentRunStatus.SUCCEEDED if run.stage is ResumeStage.READY else None
        return self._resume_run_matches_current_inputs(
            uow,
            profile,
            job,
            case,
            run,
            expected_agent_status=expected_agent_status,
        )

    def _resume_run_matches_current_inputs(
        self,
        uow: UnitOfWork,
        profile: SearchProfile,
        job: Job,
        case: JobCase,
        run: ResumeRun,
        *,
        expected_agent_status: AgentRunStatus | None,
        seen_run_ids: frozenset[str] = frozenset(),
    ) -> bool:
        """Validate one run against immutable lineage and the current workflow heads."""

        if (
            self._agent_registry is None
            or self._master_resume_renderer is None
            or run.id in seen_run_ids
            or uow.resume_runs.get(run.id) != run
            or uow.profiles.get(profile.id) != profile
            or uow.jobs.get(job.id) != job
            or uow.cases.get(case.id) != case
            or case.profile_id != profile.id
            or case.job_id != job.id
            or run.job_case_id != case.id
            or profile.current_version_id != run.profile_version_id
            or job.current_version_id != run.job_version_id
            or profile.active_evidence_version_id != run.evidence_version_id
            or case.current_decision_event_id != run.gate_decision_event_id
            or case.decision is not Decision.TAILOR
        ):
            return False
        profile_version = uow.profile_versions.get_current(profile.id)
        job_version = uow.job_versions.get_current(job.id)
        evidence = uow.evidence.get(run.evidence_version_id)
        review = uow.reviews.get(run.review_version_id)
        latest_review = uow.reviews.get_latest(case.id)
        gate = (
            None
            if run.gate_decision_event_id is None
            else uow.decision_events.get(run.gate_decision_event_id)
        )
        if (
            profile_version is None
            or job_version is None
            or evidence is None
            or review is None
            or latest_review is None
            or review.legacy_input_status != "native"
            or gate is None
            or profile_version.id != run.profile_version_id
            or profile_version.profile_id != profile.id
            or job_version.id != run.job_version_id
            or job_version.job_id != job.id
            or evidence.profile_id != profile.id
            or latest_review.id != review.id
            or review.job_case_id != case.id
            or review.job_version_id != job_version.id
            or review.profile_version_id != profile_version.id
            or review.evidence_version_id != evidence.id
            or evidence.source_revision is None
            or evidence.contract_schema_version is None
            or evidence.renderer_protocol_version != self._master_resume_renderer.protocol_version
            or evidence.renderer_version is None
            or gate.job_case_id != case.id
            or gate.decision is not Decision.TAILOR
            or gate.actor is not ActorKind.HUMAN
            or gate.review_version_id != review.id
            or gate.job_version_id != job_version.id
            or gate.profile_version_id != profile_version.id
            or gate.evidence_version_id != evidence.id
            or run.generator_version == ""
            or run.validator_version != evidence.contract_schema_version
            or run.compiler_version != self._master_resume_renderer.protocol_version
        ):
            return False
        answer_events = tuple(uow.answer_events.list_for_case(case.id))
        answer_fingerprint = answer_set_fingerprint(answer_events)
        answers = _latest_answers_for_review(uow, review, answer_events)
        screens = tuple(uow.screens.list_current(case.id, job_version.id, profile_version.id))
        screens_fingerprint = screen_set_fingerprint(screens)
        if (
            run.answer_set_fingerprint != answer_fingerprint
            or review.answer_set_fingerprint != answer_fingerprint
            or gate.answer_set_fingerprint != answer_fingerprint
            or review.screen_set_fingerprint != screens_fingerprint
            or derive_eligibility(review.questions, answers) is not EligibilityStatus.ELIGIBLE
        ):
            return False
        try:
            reviewer_descriptor = _validated_agent_descriptor(
                self._agent_registry.reviewer(profile_version).descriptor,
                profile_version,
                AgentKind.REVIEWER,
            )
            resume_descriptor = _validated_agent_descriptor(
                self._agent_registry.resume(profile_version).descriptor,
                profile_version,
                AgentKind.RESUME,
            )
        except ApplicationError:
            return False
        expected_review_fingerprint = authoritative_review_fingerprint(
            job_version_id=job_version.id,
            profile_version_id=profile_version.id,
            evidence_version_id=evidence.id,
            evidence_source_revision=evidence.source_revision,
            answer_fingerprint=answer_fingerprint,
            screen_fingerprint=screens_fingerprint,
            model=reviewer_descriptor.model,
            prompt_version=reviewer_descriptor.prompt_version,
            prompt_hash=reviewer_descriptor.prompt_hash,
            schema_version=reviewer_descriptor.output_schema_version,
            schema_hash=reviewer_descriptor.output_schema_hash,
        )
        reviewer_agent = (
            None if review.agent_run_id is None else uow.agent_runs.get(review.agent_run_id)
        )
        linked_agent = None if run.agent_run_id is None else uow.agent_runs.get(run.agent_run_id)
        if (
            review.fingerprint != expected_review_fingerprint
            or reviewer_agent is None
            or reviewer_agent.kind is not AgentKind.REVIEWER
            or reviewer_agent.status is not AgentRunStatus.SUCCEEDED
            or reviewer_agent.profile_id != profile.id
            or reviewer_agent.job_case_id != case.id
            or reviewer_agent.input_fingerprint != review.fingerprint
            or reviewer_agent.provider is not reviewer_descriptor.provider
            or reviewer_agent.model != reviewer_descriptor.model
            or reviewer_agent.prompt_version != reviewer_descriptor.prompt_version
            or reviewer_agent.prompt_hash != reviewer_descriptor.prompt_hash
            or reviewer_agent.output_schema_version != reviewer_descriptor.output_schema_version
            or reviewer_agent.output_schema_hash != reviewer_descriptor.output_schema_hash
            or linked_agent is None
            or linked_agent.kind is not AgentKind.RESUME
            or linked_agent.profile_id != profile.id
            or linked_agent.job_case_id != case.id
            or linked_agent.input_fingerprint != run.input_fingerprint
            or linked_agent.provider is not resume_descriptor.provider
            or linked_agent.model != resume_descriptor.model
            or linked_agent.prompt_version != resume_descriptor.prompt_version
            or linked_agent.prompt_hash != resume_descriptor.prompt_hash
            or linked_agent.output_schema_version != resume_descriptor.output_schema_version
            or linked_agent.output_schema_hash != resume_descriptor.output_schema_hash
            or (
                expected_agent_status is not None
                and linked_agent.status is not expected_agent_status
            )
            or run.generator_version != resume_descriptor.prompt_version
        ):
            return False
        parent_id = run.parent_resume_run_id
        feedback_id = run.feedback_review_event_id
        if (parent_id is None) != (feedback_id is None):
            return False
        if parent_id is not None and feedback_id is not None:
            parent = uow.resume_runs.get(parent_id)
            feedback = uow.resume_reviews.get(feedback_id)
            latest_parent_review = uow.resume_reviews.get_latest(parent_id)
            if (
                parent is None
                or feedback is None
                or latest_parent_review is None
                or parent.job_case_id != case.id
                or parent.stage is not ResumeStage.READY
                or feedback.resume_run_id != parent.id
                or latest_parent_review.id != feedback.id
                or feedback.decision is not ResumeReviewDecision.CHANGES_REQUESTED
                or feedback.actor is not ActorKind.HUMAN
                or not feedback.feedback.strip()
                or not self._resume_run_matches_current_inputs(
                    uow,
                    profile,
                    job,
                    case,
                    parent,
                    expected_agent_status=AgentRunStatus.SUCCEEDED,
                    seen_run_ids=seen_run_ids | {run.id},
                )
            ):
                return False
        expected = authoritative_resume_fingerprint(
            review_version_id=review.id,
            gate_decision_event_id=gate.id,
            job_version_id=job_version.id,
            profile_version_id=profile_version.id,
            evidence_version_id=evidence.id,
            evidence_source_revision=evidence.source_revision,
            answer_fingerprint=answer_fingerprint,
            model=resume_descriptor.model,
            prompt_version=resume_descriptor.prompt_version,
            prompt_hash=resume_descriptor.prompt_hash,
            schema_version=resume_descriptor.output_schema_version,
            schema_hash=resume_descriptor.output_schema_hash,
            renderer_protocol_version=self._master_resume_renderer.protocol_version,
            renderer_version=evidence.renderer_version,
            parent_resume_run_id=run.parent_resume_run_id,
            feedback_review_event_id=run.feedback_review_event_id,
        )
        if run.stage is ResumeStage.READY:
            return (
                run.input_fingerprint == expected
                and run.artifact is not None
                and run.renderer_source_revision == evidence.source_revision
            )
        return run.input_fingerprint == expected

    def _application_view(
        self, uow: UnitOfWork, application: TrackedApplication
    ) -> ApplicationView:
        follow_ups = tuple(uow.follow_ups.list_for_application(application.id))
        resolutions = tuple(
            resolution
            for follow_up in follow_ups
            for resolution in uow.follow_ups.list_resolutions(follow_up.id)
        )
        return ApplicationView(
            application=application,
            stages=tuple(uow.tracked_applications.list_stages(application.id)),
            open_follow_up=uow.follow_ups.get_open_for_application(application.id),
            follow_up_history=follow_ups,
            follow_up_resolutions=resolutions,
            job=uow.jobs.get(application.job_id),
            case=uow.cases.get(application.job_case_id),
        )

    def _replace_open_follow_up(
        self,
        uow: UnitOfWork,
        application_id: str,
        due_at: Any,
        note: str,
        trigger_stage_event_id: str,
        command_id: str,
    ) -> ApplicationFollowUp:
        previous = uow.follow_ups.get_open_for_application(application_id)
        replacement = ApplicationFollowUp(
            id=self._ids.new(),
            command_id=f"{command_id}:follow-up",
            application_id=application_id,
            due_at=due_at,
            note=note.strip(),
            trigger_stage_event_id=trigger_stage_event_id,
            supersedes_follow_up_id=None if previous is None else previous.id,
            created_at=self._clock.now(),
        )
        uow.follow_ups.add(replacement)
        if previous is not None:
            uow.follow_ups.add_resolution(
                FollowUpResolution(
                    id=self._ids.new(),
                    command_id=f"{command_id}:follow-up-resolution",
                    follow_up_id=previous.id,
                    disposition=FollowUpResolutionKind.RESCHEDULED,
                    replacement_follow_up_id=replacement.id,
                    note="Replaced by explicit follow-up date on a later stage",
                    resolved_at=self._clock.now(),
                )
            )
        return replacement

    def _profile_version(
        self,
        profile_id: str,
        version_id: str,
        version_number: int,
        draft: ProfileDraft,
        created_at: datetime,
    ) -> tuple[SearchProfileVersion, tuple[HardBlockerRule, ...]]:
        if draft.agent_provider is None:
            raise ValidationError("an agent provider must be selected")
        configurations = draft.agent_configurations or tuple(
            AgentConfiguration(
                kind=kind,
                provider=draft.agent_provider,
                model="gpt-5.6-terra",
                reasoning_effort="medium",
            )
            for kind in AgentKind
        )
        blockers = list(draft.hard_blockers)
        blocker_kinds = {item.kind for item in blockers}
        if HardBlockerKind.CLOSED not in blocker_kinds:
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.CLOSED,
                    RuleOperator.EQUALS,
                    False,
                    "listing-open",
                )
            )
        if draft.target_hq_countries and HardBlockerKind.HQ_COUNTRY not in blocker_kinds:
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.HQ_COUNTRY,
                    RuleOperator.CONTAINS,
                    "\u001f".join(draft.target_hq_countries),
                    "hq-country",
                )
            )
        if draft.startup_required and HardBlockerKind.STARTUP not in blocker_kinds:
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.STARTUP,
                    RuleOperator.EQUALS,
                    True,
                    "startup-required",
                )
            )
        if HardBlockerKind.WORK_AUTHORIZATION not in blocker_kinds:
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.WORK_AUTHORIZATION,
                    RuleOperator.EQUALS,
                    False,
                    "work-authorization",
                )
            )
        if (
            draft.accepted_hiring_arrangements
            and HardBlockerKind.REMOTE_HIRING not in blocker_kinds
        ):
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.REMOTE_HIRING,
                    RuleOperator.CONTAINS,
                    "\u001f".join(draft.accepted_hiring_arrangements),
                    "remote-hiring",
                )
            )
        if (
            draft.accepted_remote_arrangements
            and HardBlockerKind.REMOTE_ARRANGEMENT not in blocker_kinds
        ):
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.REMOTE_ARRANGEMENT,
                    RuleOperator.CONTAINS,
                    "\u001f".join(draft.accepted_remote_arrangements),
                    "remote-arrangement",
                )
            )
        if (
            draft.annual_salary_floor is not None
            and HardBlockerKind.SALARY_MAXIMUM not in blocker_kinds
        ):
            from .dto import HardBlockerDraft

            blockers.append(
                HardBlockerDraft(
                    HardBlockerKind.SALARY_MAXIMUM,
                    RuleOperator.AT_LEAST,
                    draft.annual_salary_floor,
                    "salary-maximum",
                )
            )
        version = SearchProfileVersion(
            id=version_id,
            profile_id=profile_id,
            version_number=version_number,
            name=draft.name,
            target_roles=draft.target_roles,
            locations=draft.locations,
            remote_preference=draft.remote_preference,
            employment_types=draft.employment_types,
            seniority=draft.seniority,
            annual_salary_floor=draft.annual_salary_floor,
            salary_currency=draft.salary_currency,
            include_keywords=draft.include_keywords,
            exclude_keywords=draft.exclude_keywords,
            constraints=draft.constraints,
            agent_provider=draft.agent_provider,
            residence_country=draft.residence_country,
            timezone=draft.timezone,
            target_hq_countries=draft.target_hq_countries,
            startup_required=draft.startup_required,
            accepted_remote_arrangements=draft.accepted_remote_arrangements,
            accepted_hiring_arrangements=draft.accepted_hiring_arrangements,
            search_queries=draft.search_queries,
            paper_size=draft.paper_size,
            page_limit=draft.page_limit,
            agent_configurations=configurations,
            created_at=created_at,
        )
        rules = tuple(
            HardBlockerRule(
                id=self._ids.new(),
                profile_version_id=version_id,
                rule_key=blocker.key or f"{blocker.kind.value}:{position}",
                kind=blocker.kind,
                operator=blocker.operator,
                text_value=blocker.value if isinstance(blocker.value, str) else None,
                integer_value=(
                    blocker.value
                    if isinstance(blocker.value, int) and not isinstance(blocker.value, bool)
                    else None
                ),
                boolean_value=(blocker.value if isinstance(blocker.value, bool) else None),
                position=position,
            )
            for position, blocker in enumerate(blockers)
        )
        return version, rules

    def _add_job_case(
        self,
        uow: UnitOfWork,
        profile_id: str,
        canonical_url: str,
        details: JobDetails,
        sources: Sequence[WebSourceDraft | WebSourceSnapshot] = (),
        legacy: bool = False,
        identity_alias_urls: Sequence[str] = (),
    ) -> tuple[Job, JobCase, bool]:
        now = self._clock.now()
        identity_specs = tuple(
            dict.fromkeys(
                (
                    *_job_identity_specs(canonical_url, details),
                    *(
                        (f"url:{alias_url}", JobIdentityKind.CANONICAL_URL)
                        for alias_url in identity_alias_urls
                    ),
                )
            )
        )
        resolved_jobs = {
            candidate.id: candidate
            for key, _ in identity_specs
            if (candidate := uow.jobs.get_by_identity_key(key)) is not None
        }
        direct = uow.jobs.get_by_canonical_url(canonical_url)
        if direct is not None:
            resolved_jobs[direct.id] = direct
        if len(resolved_jobs) > 1:
            raise ValidationError(
                "job identity keys resolve to conflicting existing jobs; resolve the "
                "canonical URL/requisition collision before importing"
            )
        job = next(iter(resolved_jobs.values()), None)
        created_job = job is None
        job_updated = False
        if job is None:
            job = Job(
                id=self._ids.new(),
                canonical_url=canonical_url,
                title=details.title.strip(),
                company=details.company.strip(),
                location=details.location.strip(),
                description=details.description.strip(),
                source=details.source.strip() or "manual",
                source_metadata=dict(details.source_metadata),
                created_at=now,
                updated_at=now,
            )
            uow.jobs.add(job)
        else:
            merged_metadata = {**job.source_metadata, **details.source_metadata}
            merged_values = (
                details.title.strip() or job.title,
                details.company.strip() or job.company,
                details.location.strip() or job.location,
                details.description.strip() or job.description,
                details.source.strip() or job.source,
                merged_metadata,
            )
            current_values = (
                job.title,
                job.company,
                job.location,
                job.description,
                job.source,
                job.source_metadata,
            )
            if merged_values != current_values:
                original_revision = job.revision
                job = replace(
                    job,
                    title=merged_values[0],
                    company=merged_values[1],
                    location=merged_values[2],
                    description=merged_values[3],
                    source=merged_values[4],
                    source_metadata=merged_values[5],
                    revision=job.revision + 1,
                    updated_at=now,
                )
                if not uow.jobs.update(job, expected_revision=original_revision):
                    raise RevisionConflictError(
                        "job was changed while discovery results were being saved"
                    )
                job_updated = True
        for key, kind in identity_specs:
            if not uow.jobs.add_identity_key(
                JobIdentityKey(key=key, job_id=job.id, kind=kind, created_at=now)
            ):
                raise ValidationError("job identity was concurrently assigned to a different job")
        content_fingerprint = _job_details_fingerprint(job, canonical_url, details, sources)
        current_version = uow.job_versions.get_current(job.id)
        version = uow.job_versions.get_by_fingerprint(job.id, content_fingerprint)
        if version is None:
            version = JobVersion(
                id=self._ids.new(),
                job_id=job.id,
                version_number=len(tuple(uow.job_versions.list_for_job(job.id))) + 1,
                content_fingerprint=content_fingerprint,
                canonical_url=canonical_url,
                title=details.title.strip() or job.title,
                company=details.company.strip() or job.company,
                location=details.location.strip() or job.location,
                description=details.description.strip() or job.description,
                source=details.source.strip() or job.source,
                employment_type=details.employment_type.strip(),
                seniority=details.seniority.strip(),
                salary_min=details.salary_min,
                salary_max=details.salary_max,
                salary_currency=(
                    None
                    if details.salary_currency is None
                    else details.salary_currency.strip().upper()
                ),
                external_requisition_id=details.external_requisition_id,
                listing_closed=details.listing_closed,
                hq_country=details.hq_country,
                startup=details.startup,
                work_authorization_required=details.work_authorization_required,
                us_only=details.us_only,
                remote_from_ecuador=details.remote_from_ecuador,
                remote_arrangement=_arrangement_token(details.remote_arrangement),
                hiring_arrangement=_arrangement_token(details.hiring_arrangement),
                legacy_input_status="legacy_unverified" if legacy else "native",
                observed_at=now,
            )
            source_snapshots = tuple(
                source
                if isinstance(source, WebSourceSnapshot)
                else WebSourceSnapshot(
                    id=self._ids.new(),
                    canonical_url=source.url,
                    source_kind=source.source_kind,
                    title=source.title.strip(),
                    publisher=source.publisher.strip(),
                    retrieved_at=now,
                    content_checksum=hashlib.sha256(
                        source.content
                        if source.content is not None
                        else (source.quoted_evidence or source.url).encode("utf-8")
                    ).hexdigest(),
                    quoted_evidence=source.quoted_evidence.strip(),
                )
                for source in sources
            )
            uow.job_versions.add(version, source_snapshots)
        if current_version is None or current_version.id != version.id:
            projected = replace(
                job,
                current_version_id=version.id,
                revision=(job.revision if created_job or job_updated else job.revision + 1),
                updated_at=now,
            )
            if not uow.jobs.update(projected, expected_revision=job.revision):
                raise RevisionConflictError("job changed while its immutable version was activated")
            job = projected
            job_updated = True
        case = uow.cases.get_for_profile_job(profile_id, job.id)
        if case is not None:
            if job_updated:
                self._event(
                    uow,
                    profile_id,
                    "job.updated",
                    case.id,
                    metadata={"source": job.source},
                )
            return job, case, job_updated
        case = JobCase(
            id=self._ids.new(),
            profile_id=profile_id,
            job_id=job.id,
            created_at=now,
            updated_at=now,
        )
        uow.cases.add(case)
        self._event(
            uow,
            profile_id,
            "job.added",
            case.id,
            metadata={
                "job_id": job.id,
                "canonical_url": canonical_url,
                "created_global_job": created_job,
            },
        )
        return job, case, True

    def _job_review_view(
        self,
        uow: UnitOfWork,
        profile: SearchProfile,
        job: Job,
        case: JobCase,
    ) -> JobReviewView:
        review = uow.reviews.get_latest(case.id)
        expected_review = (
            self._expected_review_fingerprint(profile, job, review, uow=uow)
            if review is not None
            else None
        )
        review_state = review_status(review, expected_fingerprint=expected_review)
        answer_history = tuple(uow.answer_events.list_for_case(case.id))
        if review is None:
            answers: dict[str, Answer] = {}
        elif answer_history:
            answers = _latest_answers_for_review(uow, review, answer_history)
        else:
            answers = {
                answer.question_id: answer.answer for answer in uow.reviews.list_answers(review.id)
            }
        eligibility = (
            derive_eligibility(review.questions, answers)
            if review is not None
            else EligibilityStatus.UNRESOLVED
        )
        latest_run = uow.resume_runs.get_latest(case.id)
        expected_resume = (
            latest_run.input_fingerprint
            if latest_run is not None
            and latest_run.profile_version_id is not None
            and self._resume_run_is_current(uow, profile, job, case, latest_run)
            else self._expected_resume_fingerprint(profile, review, review_state, latest_run)
        )
        resume_state = resume_status(latest_run, expected_fingerprint=expected_resume)
        latest_resume_review = (
            None if latest_run is None else uow.resume_reviews.get_latest(latest_run.id)
        )
        profile_version = uow.profile_versions.get_current(profile.id)
        job_version = uow.job_versions.get_current(job.id)
        projected_job = (
            job
            if job_version is None or job.canonical_url == job_version.canonical_url
            else replace(job, canonical_url=job_version.canonical_url)
        )
        screens = (
            ()
            if profile_version is None or job_version is None
            else tuple(uow.screens.list_current(case.id, job_version.id, profile_version.id))
        )
        return JobReviewView(
            job=projected_job,
            case=case,
            review_status=review_state,
            review=review,
            answers=answers,
            eligibility_status=eligibility,
            latest_resume_run=latest_run,
            resume_status=resume_state,
            profile_version=profile_version,
            job_version=job_version,
            answer_history=answer_history,
            screen_evaluations=screens,
            resume_approval_status=resume_approval_status(
                latest_run,
                latest_resume_review,
                is_current=resume_state is ResumeStatus.READY,
            ),
            sources=(
                () if job_version is None else tuple(uow.job_versions.list_sources(job_version.id))
            ),
        )

    def _inbox_item(self, uow: UnitOfWork, profile_id: str, case: JobCase) -> JobInboxItem:
        profile = self._require_profile(uow, profile_id)
        job = self._require_job(uow, case.job_id)
        view = self._job_review_view(uow, profile, job, case)
        activity_candidates = (
            case.updated_at,
            job.updated_at,
            view.review.created_at if view.review is not None else None,
            (view.latest_resume_run.updated_at if view.latest_resume_run is not None else None),
        )
        latest_activity = max(
            (value for value in activity_candidates if value is not None),
            default=None,
        )
        return JobInboxItem(
            case_id=case.id,
            job_id=job.id,
            canonical_url=view.job.canonical_url,
            title=view.job.title,
            company=view.job.company,
            location=view.job.location,
            review_status=view.review_status,
            eligibility_status=view.eligibility_status,
            decision=case.decision,
            resume_status=view.resume_status,
            application_status=case.application_status,
            outcome=case.current_outcome,
            submitted_at=case.submitted_at,
            submitted_artifact_id=case.submitted_artifact_id,
            updated_at=latest_activity,
        )

    def _expected_review_fingerprint(
        self,
        profile: SearchProfile,
        job: Job,
        review: ReviewVersion,
        *,
        uow: UnitOfWork | None = None,
    ) -> str:
        if review.legacy_input_status != "native":
            return ""
        if (
            uow is not None
            and self._agent_registry is not None
            and review.job_version_id is not None
            and review.profile_version_id is not None
            and review.evidence_version_id is not None
        ):
            profile_version = uow.profile_versions.get_current(profile.id)
            job_version = uow.job_versions.get_current(job.id)
            evidence = uow.evidence.get(review.evidence_version_id)
            if (
                profile_version is None
                or job_version is None
                or evidence is None
                or evidence.source_revision is None
                or profile.current_version_id != review.profile_version_id
                or job.current_version_id != review.job_version_id
                or profile.active_evidence_version_id != review.evidence_version_id
            ):
                return ""
            try:
                descriptor = _validated_agent_descriptor(
                    self._agent_registry.reviewer(profile_version).descriptor,
                    profile_version,
                    AgentKind.REVIEWER,
                )
            except ApplicationError:
                return ""
            answers = tuple(uow.answer_events.list_for_case(review.job_case_id))
            screens = tuple(
                uow.screens.list_current(
                    review.job_case_id,
                    job_version.id,
                    profile_version.id,
                )
            )
            return authoritative_review_fingerprint(
                job_version_id=job_version.id,
                profile_version_id=profile_version.id,
                evidence_version_id=evidence.id,
                evidence_source_revision=evidence.source_revision,
                answer_fingerprint=answer_set_fingerprint(answers),
                screen_fingerprint=screen_set_fingerprint(screens),
                model=descriptor.model,
                prompt_version=descriptor.prompt_version,
                prompt_hash=descriptor.prompt_hash,
                schema_version=descriptor.output_schema_version,
                schema_hash=descriptor.output_schema_hash,
            )
        analyzer_version = (
            self._analyzer.version
            if self._analyzer is not None and _provider_is_available(self._analyzer)
            else review.analyzer_version
        )
        return review_fingerprint(
            job_revision=job.revision,
            profile_revision=profile.revision,
            evidence_version_id=profile.active_evidence_version_id,
            analyzer_version=analyzer_version,
        )

    def _expected_resume_fingerprint(
        self,
        profile: SearchProfile,
        review: ReviewVersion | None,
        review_state: ReviewStatus,
        run: ResumeRun | None,
    ) -> str | None:
        if (
            run is None
            or review is None
            or review_state is not ReviewStatus.CURRENT
            or profile.active_evidence_version_id is None
        ):
            return None
        return resume_input_fingerprint(
            review_version_id=review.id,
            evidence_version_id=profile.active_evidence_version_id,
            generator_version=(
                self._generator.version
                if self._generator is not None and _provider_is_available(self._generator)
                else run.generator_version
            ),
            validator_version=(
                self._validator.version
                if self._validator is not None and _provider_is_available(self._validator)
                else run.validator_version
            ),
            compiler_version=(
                self._compiler.version
                if self._compiler is not None and _provider_is_available(self._compiler)
                else run.compiler_version
            ),
        )

    def _advance_run(self, run: ResumeRun, stage: ResumeStage, **changes: Any) -> ResumeRun:
        with self._uow_factory() as uow:
            persisted = uow.resume_runs.get(run.id)
            if persisted is None:
                raise NotFoundError("résumé run disappeared while it was executing")
            case = uow.cases.get(persisted.job_case_id)
            if case is None:
                raise NotFoundError("job case disappeared while résumé generation was running")
            updated = replace(
                persisted,
                stage=stage,
                updated_at=self._clock.now(),
                **changes,
            )
            _register_resume_run_artifacts(uow, updated)
            uow.resume_runs.update(updated)
            self._event(
                uow,
                case.profile_id,
                f"resume.{stage.value}",
                case.id,
                metadata={
                    "resume_run_id": updated.id,
                    "stage": stage.value,
                    "from_stage": persisted.stage.value,
                    "error": updated.error_message,
                },
            )
            uow.commit()
        return updated

    def _fail_run(self, run: ResumeRun, message: str) -> ResumeRun:
        if run.stage in {ResumeStage.FAILED, ResumeStage.INTERRUPTED}:
            return run
        return self._advance_run(
            run, ResumeStage.FAILED, error_message=message or "provider failed"
        )

    def _require_profile(self, uow: UnitOfWork, profile_id: str) -> SearchProfile:
        profile = uow.profiles.get(profile_id)
        if profile is None:
            raise NotFoundError("search profile was not found")
        return profile

    def _require_job(self, uow: UnitOfWork, job_id: str) -> Job:
        job = uow.jobs.get(job_id)
        if job is None:
            raise NotFoundError("job was not found")
        return job

    def _require_case_for_job(self, uow: UnitOfWork, profile_id: str, job_id: str) -> JobCase:
        case = uow.cases.get_for_profile_job(profile_id, job_id)
        if case is None:
            raise NotFoundError("job is not in this search profile")
        return case

    def _require_follow_up_for_profile(
        self,
        uow: UnitOfWork,
        profile_id: str,
        follow_up_id: str,
    ) -> ApplicationFollowUp:
        """Resolve an opaque follow-up ID only inside its owning profile."""

        self._require_profile(uow, profile_id)
        follow_up = uow.follow_ups.get(follow_up_id)
        if follow_up is None:
            raise NotFoundError("follow-up was not found")
        application = uow.tracked_applications.get(follow_up.application_id)
        if application is None:
            raise NotFoundError("follow-up was not found")
        case = uow.cases.get(application.job_case_id)
        scoped_case = uow.cases.get_for_profile_job(profile_id, application.job_id)
        job = uow.jobs.get(application.job_id)
        if (
            case is None
            or scoped_case is None
            or job is None
            or case.id != scoped_case.id
            or case.profile_id != profile_id
            or case.job_id != application.job_id
        ):
            raise NotFoundError("follow-up was not found")
        return follow_up

    @staticmethod
    def _check_revision(actual: int, expected: int, resource: str) -> None:
        if actual != expected:
            raise RevisionConflictError(
                f"{resource} revision conflict",
                details={"expected_revision": expected, "actual_revision": actual},
            )

    @staticmethod
    def _require_provider(provider: _ProviderT | None, capability: str) -> _ProviderT:
        if not _provider_is_available(provider):
            raise ProviderUnavailableError(f"{capability} provider is not configured")
        assert provider is not None
        return provider

    def _event(
        self,
        uow: UnitOfWork,
        profile_id: str,
        event_type: str,
        case_id: str | None = None,
        *,
        metadata: dict[str, object] | None = None,
    ) -> None:
        uow.events.add(
            WorkflowEvent(
                id=self._ids.new(),
                event_type=event_type,
                occurred_at=self._clock.now(),
                profile_id=profile_id,
                job_case_id=case_id,
                metadata=metadata or {},
            )
        )


def _validated_profile_draft(draft: ProfileDraft) -> ProfileDraft:
    name = draft.name.strip()
    if not name:
        raise ValidationError("profile name is required")
    if not isinstance(draft.agent_provider, AgentProvider):
        raise ValidationError("select either the demo or OpenAI agent provider")
    if draft.annual_salary_floor is not None and draft.annual_salary_floor < 0:
        raise ValidationError("annual salary floor cannot be negative")
    currency = draft.salary_currency.strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise ValidationError("salary currency must be a three-letter code")

    def cleaned(values: Sequence[str]) -> tuple[str, ...]:
        return tuple(dict.fromkeys(value.strip() for value in values if value.strip()))

    target_roles = cleaned(draft.target_roles)
    if not target_roles:
        raise ValidationError("at least one target role is required")
    residence_country = draft.residence_country.strip()
    timezone = draft.timezone.strip()
    if not residence_country or not timezone:
        raise ValidationError("residence country and timezone are required")
    paper_size = draft.paper_size.strip().lower()
    if paper_size not in {"a4paper", "letterpaper"}:
        raise ValidationError("paper size must be a4paper or letterpaper")
    if draft.page_limit < 1 or draft.page_limit > 5:
        raise ValidationError("page limit must be between 1 and 5")
    if draft.agent_configurations:
        kinds = {item.kind for item in draft.agent_configurations}
        if kinds != set(AgentKind) or len(draft.agent_configurations) != 3:
            raise ValidationError("configure exactly Scout, Reviewer, and Resume agents")
        if any(
            not item.model.strip()
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", item.model.strip()) is None
            for item in draft.agent_configurations
        ):
            raise ValidationError("agent model IDs must be non-empty safe identifiers")
        if any(
            item.reasoning_effort.strip().lower() not in {"low", "medium", "high", "xhigh"}
            for item in draft.agent_configurations
        ):
            raise ValidationError("agent reasoning effort is invalid")
        if any(item.provider is not draft.agent_provider for item in draft.agent_configurations):
            raise ValidationError("agent providers must match the profile provider")
    for blocker in draft.hard_blockers:
        if not isinstance(blocker.kind, HardBlockerKind) or not isinstance(
            blocker.operator, RuleOperator
        ):
            raise ValidationError("hard blocker kind or operator is invalid")
    return replace(
        draft,
        name=name,
        target_roles=target_roles,
        locations=cleaned(draft.locations),
        employment_types=cleaned(draft.employment_types),
        seniority=cleaned(draft.seniority),
        include_keywords=cleaned(draft.include_keywords),
        exclude_keywords=cleaned(draft.exclude_keywords),
        residence_country=residence_country,
        timezone=timezone,
        target_hq_countries=cleaned(draft.target_hq_countries),
        accepted_remote_arrangements=tuple(
            dict.fromkeys(
                token
                for value in draft.accepted_remote_arrangements
                if (token := _arrangement_token(value)) is not None
            )
        ),
        accepted_hiring_arrangements=tuple(
            dict.fromkeys(
                token
                for value in draft.accepted_hiring_arrangements
                if (token := _arrangement_token(value)) is not None
            )
        ),
        search_queries=cleaned(draft.search_queries) or target_roles,
        paper_size=paper_size,
        salary_currency=currency,
        constraints=draft.constraints.strip(),
        hard_blockers=tuple(
            replace(blocker, value=_arrangement_token(blocker.value) or "")
            if blocker.kind in {HardBlockerKind.REMOTE_ARRANGEMENT, HardBlockerKind.REMOTE_HIRING}
            and isinstance(blocker.value, str)
            else blocker
            for blocker in draft.hard_blockers
        ),
        agent_configurations=tuple(
            replace(
                item,
                model=item.model.strip(),
                reasoning_effort=item.reasoning_effort.strip().lower(),
            )
            for item in draft.agent_configurations
        ),
    )


def _validated_resume_source_draft(draft: ResumeSourceDraft) -> ResumeSourceDraft:
    if not isinstance(draft.kind, ResumeSourceKind):
        raise ValidationError("résumé source kind must be local_git or remote_git")
    if not draft.trust_repository:
        raise ValidationError("explicitly acknowledge trust for repository code and future commits")

    repository = draft.repository.strip()
    if not repository or "\x00" in repository or "\n" in repository or "\r" in repository:
        raise ValidationError("résumé source repository is required")
    if draft.kind is ResumeSourceKind.LOCAL_GIT:
        repository_path = Path(repository).expanduser()
        if not repository_path.is_absolute():
            raise ValidationError("a local Git résumé source must use an absolute path")
        repository = str(repository_path.resolve(strict=False))
    else:
        try:
            repository = validate_remote_git_repository(repository)
        except InvalidGitRemote as error:
            raise ValidationError(str(error)) from error

    document_path = draft.document_path.strip()
    if document_path != "roleloop_contract/v1/cli.py":
        raise ValidationError(
            "RoleLoop v1 uses the fixed roleloop_contract/v1/cli.py contract entrypoint"
        )
    relative_path = PurePosixPath(document_path)
    if (
        not document_path
        or "\x00" in document_path
        or "\\" in document_path
        or any(ord(character) < 32 for character in document_path)
        or relative_path.is_absolute()
        or not relative_path.parts
        or any(part in {"", ".", ".."} for part in relative_path.parts)
    ):
        raise ValidationError("résumé document path must be a safe repository-relative path")

    try:
        ref = validate_git_ref(draft.ref or _default_resume_source_ref(draft.kind))
    except InvalidGitRef as error:
        raise ValidationError(str(error)) from error
    return replace(
        draft,
        repository=repository,
        document_path=relative_path.as_posix(),
        ref=ref,
    )


def _validated_resume_source_snapshot(
    snapshot: ResumeSourceSnapshot,
) -> ResumeSourceSnapshot:
    if not isinstance(snapshot, ResumeSourceSnapshot):
        raise ArtifactError("résumé source synchronizer returned an invalid snapshot")
    if not isinstance(snapshot.source_bytes, bytes) or not snapshot.source_bytes:
        raise ArtifactError("the synchronized résumé source is empty")
    if not snapshot.extracted_text.strip():
        raise ArtifactError("no résumé text could be extracted from the synchronized source")
    source_revision = snapshot.source_revision.strip()
    if not source_revision or any(character.isspace() for character in source_revision):
        raise ArtifactError("résumé source synchronizer returned an invalid revision")
    source_name = snapshot.source_name.strip()
    if not source_name or "\x00" in source_name:
        raise ArtifactError("résumé source synchronizer returned an invalid source name")
    media_type = snapshot.media_type.strip()
    if not media_type or "\x00" in media_type:
        raise ArtifactError("résumé source synchronizer returned an invalid media type")
    extension = snapshot.extension.strip().lower()
    if not re.fullmatch(r"(?:\.[a-z0-9]+)?", extension):
        raise ArtifactError("résumé source synchronizer returned an unsafe extension")
    content_checksum = snapshot.content_checksum.strip().lower()
    actual_checksum = hashlib.sha256(snapshot.source_bytes).hexdigest()
    if content_checksum != actual_checksum:
        raise ArtifactError("synchronized résumé checksum does not match its content")
    contract_schema_version = (snapshot.contract_schema_version or "").strip()
    if not contract_schema_version:
        raise ArtifactError("master résumé contract schema version is missing")
    if not snapshot.canonical_evidence_bytes:
        raise ArtifactError("master résumé canonical evidence payload is missing")
    if not snapshot.source_bundle_bytes:
        raise ArtifactError("master résumé source bundle is missing")
    renderer_protocol_version = (snapshot.renderer_protocol_version or "").strip()
    renderer_version = (snapshot.renderer_version or "").strip()
    if not renderer_protocol_version or not renderer_version:
        raise ArtifactError("master résumé renderer metadata is incomplete")
    contract_checksum = (snapshot.contract_checksum or "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", contract_checksum):
        raise ArtifactError("master résumé contract checksum must be a SHA-256 digest")
    return replace(
        snapshot,
        source_name=source_name,
        media_type=media_type,
        extension=extension,
        source_revision=source_revision,
        content_checksum=content_checksum,
        contract_schema_version=contract_schema_version,
        renderer_protocol_version=renderer_protocol_version,
        renderer_version=renderer_version,
        contract_checksum=contract_checksum,
    )


def _matching_synced_evidence(
    uow: UnitOfWork,
    *,
    source: ResumeSource,
    snapshot: ResumeSourceSnapshot,
) -> ResumeEvidenceVersion | None:
    if (
        source.last_synced_revision != snapshot.source_revision
        or source.last_synced_checksum != snapshot.content_checksum
        or source.last_synced_evidence_version_id is None
    ):
        return None
    evidence = uow.evidence.get(source.last_synced_evidence_version_id)
    if (
        evidence is None
        or evidence.profile_id != source.profile_id
        or evidence.resume_source_id != source.id
        or evidence.source_revision != snapshot.source_revision
        or evidence.resume_source_kind is not source.kind
        or evidence.source_repository != source.repository
        or evidence.source_ref != source.ref
        or evidence.source_document_path != source.document_path
        or evidence.source_artifact.checksum != snapshot.content_checksum
        or evidence.source_artifact.media_type != snapshot.media_type
        or evidence.source_name != snapshot.source_name
        or evidence.extracted_text != snapshot.extracted_text
        or evidence.contract_schema_version != snapshot.contract_schema_version
        or evidence.renderer_protocol_version != snapshot.renderer_protocol_version
        or evidence.renderer_version != snapshot.renderer_version
        or evidence.contract_checksum != snapshot.contract_checksum
        or evidence.canonical_evidence_artifact is None
        or evidence.source_bundle_artifact is None
        or evidence.canonical_evidence_artifact.checksum
        != hashlib.sha256(snapshot.canonical_evidence_bytes or b"").hexdigest()
        or evidence.source_bundle_artifact.checksum
        != hashlib.sha256(snapshot.source_bundle_bytes or b"").hexdigest()
    ):
        return None
    return evidence


def _default_resume_source_ref(kind: ResumeSourceKind) -> str:
    return "HEAD" if kind is ResumeSourceKind.LOCAL_GIT else "main"


def _validate_evidence_import(request: EvidenceImport) -> None:
    if (request.path is None) == (request.text is None):
        raise ValidationError("provide exactly one evidence path or pasted text")
    if request.text is not None and not request.text.strip():
        raise ValidationError("pasted résumé evidence cannot be empty")


def _materialize_questions(
    questions: Sequence[AnalysisQuestion],
) -> tuple[ReviewQuestion, ...]:
    result: list[ReviewQuestion] = []
    seen: set[str] = set()
    for supplied in questions:
        if not isinstance(supplied.key, str):
            raise ValueError("review question identifiers must be strings")
        question_id = supplied.key.strip()
        if not question_id or question_id in seen:
            raise ValueError("review question identifiers must be unique and non-empty")
        prompt = supplied.prompt.strip()
        if not prompt:
            raise ValueError("review questions must have non-empty prompts")
        if not isinstance(supplied.category, QuestionCategory):
            raise ValueError("review question category is invalid")
        if (
            not isinstance(supplied.qualifying_answer, Answer)
            or supplied.qualifying_answer is Answer.UNKNOWN
        ):
            raise ValueError("review question qualifier must be yes or no")
        seen.add(question_id)
        result.append(
            ReviewQuestion(
                id=question_id,
                prompt=prompt,
                category=supplied.category,
                required=supplied.required,
                qualifying_answer=supplied.qualifying_answer,
                source_anchor=supplied.source_anchor.strip(),
            )
        )
    return tuple(result)


def _merge_review_questions(
    screens: Sequence[ScreenEvaluation],
    supplied: Sequence[AnalysisQuestion],
) -> tuple[ReviewQuestion, ...]:
    deterministic = tuple(
        ReviewQuestion(
            id=screen.rule_id,
            prompt=(f"Confirm that this hard-blocker requirement is satisfied: {screen.detail}"),
            category=QuestionCategory.ELIGIBILITY,
            required=True,
            qualifying_answer=Answer.YES,
            source_anchor=f"screen:{screen.id}",
        )
        for screen in screens
        if screen.result is ScreenResult.UNKNOWN
    )
    provider_questions = _materialize_questions(supplied)
    reserved = {item.id for item in deterministic}
    # Providers may echo the stable screen question they were given. The
    # deterministic version is authoritative, so ignore an echoed duplicate rather
    # than making a valid Reviewer response fail because its wording differs.
    return (
        *deterministic,
        *(item for item in provider_questions if item.id not in reserved),
    )


def _validated_findings(findings: Sequence[Finding], label: str) -> tuple[Finding, ...]:
    validated: list[Finding] = []
    for finding in findings:
        summary = finding.summary.strip()
        source_anchor = finding.source_anchor.strip()
        if not summary:
            raise ValueError(f"{label} summary cannot be empty")
        if not source_anchor:
            raise ValueError(f"{label} source anchor cannot be empty")
        validated.append(
            replace(
                finding,
                summary=summary,
                detail=finding.detail.strip(),
                source_anchor=source_anchor,
            )
        )
    return tuple(validated)


def _validated_review_requirements(
    requirements: Sequence[ReviewRequirement],
) -> tuple[ReviewRequirement, ...]:
    validated: list[ReviewRequirement] = []
    seen: set[str] = set()
    for requirement in requirements:
        key = requirement.key.strip()
        text = requirement.text.strip()
        evidence = requirement.evidence.strip()
        source_anchor = requirement.source_anchor.strip()
        if not key or len(key) > 200 or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", key) is None:
            raise ProviderFailureError(
                "Reviewer requirement keys must be stable, non-empty identifiers"
            )
        if key in seen:
            raise ProviderFailureError("Reviewer requirement keys must be unique")
        if not text or not evidence or not source_anchor:
            raise ProviderFailureError(
                "Reviewer requirements need text, evidence, and a source anchor"
            )
        if len(text) > 8_000 or len(evidence) > 16_000 or len(source_anchor) > 2_000:
            raise ProviderFailureError("Reviewer requirement fields exceed safe limits")
        seen.add(key)
        validated.append(
            replace(
                requirement,
                key=key,
                text=text,
                evidence=evidence,
                source_anchor=source_anchor,
            )
        )
    return tuple(validated)


def _matches_filters(item: JobInboxItem, filters: InboxFilters) -> bool:
    search = filters.search.strip().casefold()
    if (
        search
        and search
        not in " ".join((item.title, item.company, item.location, item.canonical_url)).casefold()
    ):
        return False
    return all(
        (
            not filters.review or item.review_status in filters.review,
            not filters.eligibility or item.eligibility_status in filters.eligibility,
            not filters.decision or item.decision in filters.decision,
            not filters.resume or item.resume_status in filters.resume,
            not filters.application or item.application_status in filters.application,
            not filters.outcome or item.outcome in filters.outcome,
        )
    )


def _validated_agent_descriptor(
    descriptor: AgentDescriptor,
    profile_version: SearchProfileVersion,
    kind: AgentKind,
) -> AgentDescriptor:
    if not isinstance(descriptor, AgentDescriptor):
        raise ProviderFailureError("agent returned an invalid descriptor")
    configured = next(
        (item for item in profile_version.agent_configurations if item.kind is kind),
        None,
    )
    if configured is None:
        raise InvalidTransitionError(f"profile does not configure the {kind.value} agent")
    if descriptor.provider is not configured.provider or descriptor.model != configured.model:
        raise ProviderFailureError("agent descriptor does not match the pinned profile version")
    if not descriptor.model.strip():
        raise ProviderFailureError("agent descriptor model is required")
    if not descriptor.prompt_version.strip() or not descriptor.output_schema_version.strip():
        raise ProviderFailureError("agent prompt and schema versions are required")
    if not re.fullmatch(r"[a-f0-9]{64}", descriptor.prompt_hash.lower()):
        raise ProviderFailureError("agent prompt hash must be a SHA-256 digest")
    if not re.fullmatch(r"[a-f0-9]{64}", descriptor.output_schema_hash.lower()):
        raise ProviderFailureError("agent schema hash must be a SHA-256 digest")
    return replace(
        descriptor,
        prompt_hash=descriptor.prompt_hash.lower(),
        output_schema_hash=descriptor.output_schema_hash.lower(),
    )


def _validate_agent_audit(audit: AgentAudit, descriptor: AgentDescriptor) -> None:
    if not isinstance(audit, AgentAudit):
        raise ProviderFailureError("agent returned invalid audit metadata")
    if audit.status is not AgentRunStatus.SUCCEEDED:
        raise ProviderFailureError(
            audit.sanitized_error_message or "agent did not report successful completion"
        )
    if audit.prompt_hash.lower() != descriptor.prompt_hash:
        raise ProviderFailureError("agent audit prompt hash differs from its descriptor")
    if audit.output_schema_hash.lower() != descriptor.output_schema_hash:
        raise ProviderFailureError("agent audit schema hash differs from its descriptor")
    tokens = (audit.input_tokens, audit.output_tokens, audit.total_tokens)
    if any(value is not None and value < 0 for value in tokens):
        raise ProviderFailureError("agent token usage cannot be negative")
    if (
        audit.total_tokens is not None
        and audit.input_tokens is not None
        and audit.output_tokens is not None
        and audit.total_tokens != audit.input_tokens + audit.output_tokens
    ):
        raise ProviderFailureError("agent token totals are inconsistent")
    for url in audit.source_urls:
        if not url.startswith(("https://", "http://")):
            raise ProviderFailureError("agent source URLs must use HTTP or HTTPS")


def _validated_resume_selection(selection: ResumeSelection) -> ResumeSelection:
    if not isinstance(selection, ResumeSelection):
        raise ProviderFailureError("Resume agent returned an invalid selection")
    headline = selection.headline.strip()
    if not headline or len(headline) > 180:
        raise ProviderFailureError("Resume headline must contain 1-180 characters")
    experience_ids = [item.experience_id.strip() for item in selection.experiences]
    if not experience_ids or any(not item for item in experience_ids):
        raise ProviderFailureError("Resume must select at least one experience")
    if len(experience_ids) != len(set(experience_ids)):
        raise ProviderFailureError("Resume experience selections must be unique")
    bullet_ids = [
        bullet.strip() for experience in selection.experiences for bullet in experience.bullet_ids
    ]
    if not bullet_ids or any(not item for item in bullet_ids):
        raise ProviderFailureError("Resume bullet selections must be non-empty IDs")
    if len(bullet_ids) != len(set(bullet_ids)):
        raise ProviderFailureError("Resume bullet selections must be unique")
    skill_ids = tuple(item.strip() for item in selection.skill_ids)
    if any(not item for item in skill_ids) or len(skill_ids) != len(set(skill_ids)):
        raise ProviderFailureError("Resume skill selections must be unique non-empty IDs")
    return replace(
        selection,
        headline=headline,
        experiences=tuple(
            ResumeExperienceSelection(
                experience_id=item.experience_id.strip(),
                bullet_ids=tuple(bullet.strip() for bullet in item.bullet_ids),
            )
            for item in selection.experiences
        ),
        skill_ids=skill_ids,
    )


def _evaluate_screen_rule(
    evaluation_id: str,
    case: JobCase,
    job: JobVersion,
    profile: SearchProfileVersion,
    rule: HardBlockerRule,
    created_at: Any,
) -> ScreenEvaluation:
    result = ScreenResult.UNKNOWN
    detail = f"{rule.kind.value} could not be determined from retained sources"
    if rule.kind is HardBlockerKind.CLOSED:
        if job.listing_closed is not None:
            result = ScreenResult.FAIL if job.listing_closed else ScreenResult.PASS
            detail = "listing is closed" if job.listing_closed else "listing is open"
    elif rule.kind is HardBlockerKind.HQ_COUNTRY:
        if job.hq_country:
            accepted = {item.casefold() for item in (rule.text_value or "").split("\u001f") if item}
            result = (
                ScreenResult.PASS if job.hq_country.casefold() in accepted else ScreenResult.FAIL
            )
            detail = f"headquarters country is {job.hq_country}"
    elif rule.kind is HardBlockerKind.STARTUP:
        if job.startup is not None:
            expected = bool(rule.boolean_value)
            result = ScreenResult.PASS if job.startup is expected else ScreenResult.FAIL
            detail = (
                "startup requirement matched" if result is ScreenResult.PASS else "not a startup"
            )
    elif rule.kind is HardBlockerKind.WORK_AUTHORIZATION:
        if job.work_authorization_required is True or job.us_only is True:
            result = ScreenResult.FAIL
            detail = "listing requires restricted work authorization or US presence"
        elif job.work_authorization_required is False and job.us_only is False:
            result = ScreenResult.PASS
            detail = "no restricted work-authorization requirement found"
    elif rule.kind is HardBlockerKind.REMOTE_HIRING:
        if job.remote_from_ecuador is False:
            result = ScreenResult.FAIL
            detail = "listing does not allow remote work from Ecuador"
        elif job.remote_from_ecuador is True and job.hiring_arrangement:
            accepted = {
                token
                for item in (rule.text_value or "").split("\u001f")
                if (token := _arrangement_token(item)) is not None
            }
            result = (
                ScreenResult.PASS
                if _arrangement_token(job.hiring_arrangement) in accepted
                else ScreenResult.FAIL
            )
            detail = f"hiring arrangement is {job.hiring_arrangement}"
    elif rule.kind is HardBlockerKind.REMOTE_ARRANGEMENT:
        if job.remote_arrangement:
            accepted = {
                token
                for item in (rule.text_value or "").split("\u001f")
                if (token := _arrangement_token(item)) is not None
            }
            result = (
                ScreenResult.PASS
                if _arrangement_token(job.remote_arrangement) in accepted
                else ScreenResult.FAIL
            )
            detail = f"remote arrangement is {job.remote_arrangement}"
    elif (
        rule.kind is HardBlockerKind.SALARY_MAXIMUM
        and job.salary_max is not None
        and job.salary_currency
        and job.salary_currency.casefold() == profile.salary_currency.casefold()
    ):
        floor = rule.integer_value or 0
        result = ScreenResult.PASS if job.salary_max >= floor else ScreenResult.FAIL
        detail = (
            f"advertised maximum {job.salary_max} {job.salary_currency}; "
            f"profile floor {floor} {profile.salary_currency}"
        )
    return ScreenEvaluation(
        id=evaluation_id,
        job_case_id=case.id,
        job_version_id=job.id,
        profile_version_id=rule.profile_version_id,
        rule_id=rule.id,
        result=result,
        detail=detail,
        created_at=created_at,
    )


def _job_details_fingerprint(
    job: Job,
    canonical_url: str,
    details: JobDetails,
    sources: Sequence[WebSourceDraft | WebSourceSnapshot],
) -> str:
    return stable_fingerprint(
        canonical_url=canonical_url,
        title=job.title,
        company=job.company,
        location=job.location,
        description=job.description,
        source=job.source,
        employment_type=details.employment_type.strip(),
        seniority=details.seniority.strip(),
        salary_min=details.salary_min,
        salary_max=details.salary_max,
        salary_currency=details.salary_currency,
        external_requisition_id=details.external_requisition_id,
        listing_closed=details.listing_closed,
        hq_country=details.hq_country,
        startup=details.startup,
        work_authorization_required=details.work_authorization_required,
        us_only=details.us_only,
        remote_from_ecuador=details.remote_from_ecuador,
        remote_arrangement=_arrangement_token(details.remote_arrangement),
        hiring_arrangement=_arrangement_token(details.hiring_arrangement),
        sources=tuple(
            (
                (item.canonical_url if isinstance(item, WebSourceSnapshot) else item.url),
                item.source_kind.value,
                (
                    item.content_checksum
                    if isinstance(item, WebSourceSnapshot)
                    else hashlib.sha256(
                        item.content
                        if item.content is not None
                        else (item.quoted_evidence or item.url).encode("utf-8")
                    ).hexdigest()
                ),
            )
            for item in sources
        ),
    )


def _merge_job_correction(
    job: Job,
    current: JobVersion,
    supplied: JobDetails,
) -> JobDetails:
    """Copy the pinned version and apply only explicitly supplied corrections."""

    source = supplied.source.strip()
    if source == "manual" and current.source and current.source != "manual":
        source = current.source
    return JobDetails(
        title=supplied.title.strip() or current.title,
        company=supplied.company.strip() or current.company,
        location=supplied.location.strip() or current.location,
        description=supplied.description.strip() or current.description,
        source=source or current.source or job.source,
        source_metadata={**job.source_metadata, **dict(supplied.source_metadata)},
        employment_type=supplied.employment_type.strip() or current.employment_type,
        seniority=supplied.seniority.strip() or current.seniority,
        salary_min=(current.salary_min if supplied.salary_min is None else supplied.salary_min),
        salary_max=(current.salary_max if supplied.salary_max is None else supplied.salary_max),
        salary_currency=(
            current.salary_currency
            if supplied.salary_currency is None
            else supplied.salary_currency.strip().upper()
        ),
        external_requisition_id=(
            current.external_requisition_id
            if supplied.external_requisition_id is None
            else supplied.external_requisition_id.strip()
        ),
        listing_closed=(
            current.listing_closed if supplied.listing_closed is None else supplied.listing_closed
        ),
        hq_country=(
            current.hq_country if supplied.hq_country is None else supplied.hq_country.strip()
        ),
        startup=current.startup if supplied.startup is None else supplied.startup,
        work_authorization_required=(
            current.work_authorization_required
            if supplied.work_authorization_required is None
            else supplied.work_authorization_required
        ),
        us_only=current.us_only if supplied.us_only is None else supplied.us_only,
        remote_from_ecuador=(
            current.remote_from_ecuador
            if supplied.remote_from_ecuador is None
            else supplied.remote_from_ecuador
        ),
        remote_arrangement=(
            current.remote_arrangement
            if supplied.remote_arrangement is None
            else _arrangement_token(supplied.remote_arrangement)
        ),
        hiring_arrangement=(
            current.hiring_arrangement
            if supplied.hiring_arrangement is None
            else _arrangement_token(supplied.hiring_arrangement)
        ),
    )


def _arrangement_token(value: object | None) -> str | None:
    if value is None:
        return None
    normalized = re.sub(r"[\s_-]+", "_", str(value).strip().casefold()).strip("_")
    return normalized or None


def _normalized_scout_details(details: JobDetails) -> JobDetails:
    return replace(
        details,
        title=" ".join(details.title.split()),
        company=" ".join(details.company.split()),
        location=" ".join(details.location.split()),
        description=" ".join(details.description.split()),
        source=details.source.strip() or "manual",
        source_metadata=dict(details.source_metadata),
        employment_type=" ".join(details.employment_type.split()),
        seniority=" ".join(details.seniority.split()),
        salary_currency=(
            None if details.salary_currency is None else details.salary_currency.strip().upper()
        ),
        external_requisition_id=(
            None
            if details.external_requisition_id is None
            else details.external_requisition_id.strip()
        ),
        hq_country=(None if details.hq_country is None else details.hq_country.strip()),
        remote_arrangement=(_arrangement_token(details.remote_arrangement)),
        hiring_arrangement=(_arrangement_token(details.hiring_arrangement)),
    )


@dataclass(frozen=True, slots=True)
class _PreparedScoutCandidate:
    candidate: DiscoveredJob
    identity_alias_urls: tuple[str, ...]


def _prepare_scout_candidates(
    candidates: Sequence[DiscoveredJob], limit: int
) -> dict[str, _PreparedScoutCandidate]:
    normalized: list[DiscoveredJob] = []
    identity_alias_urls: list[tuple[str, ...]] = []
    identity_keys: list[tuple[str, ...]] = []
    for item in candidates:
        try:
            canonical = canonicalize_job_url(item.url)
        except (InvalidJobUrl, UnicodeError) as exc:
            raise ProviderFailureError(f"Scout returned an invalid URL: {item.url!r}") from exc
        details = _normalized_scout_details(item.details)
        normalized_item = replace(
            item,
            url=canonical,
            details=details,
            sources=_merge_web_source_drafts((), item.sources),
        )
        aliases = _scout_identity_alias_urls(normalized_item)
        normalized.append(normalized_item)
        identity_alias_urls.append(aliases)
        identity_keys.append(
            tuple(
                dict.fromkeys(
                    (
                        *(key for key, _kind in _job_identity_specs(canonical, details)),
                        *(f"url:{alias_url}" for alias_url in aliases),
                    )
                )
            )
        )

    parents = list(range(len(normalized)))

    def root(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = root(left)
        right_root = root(right)
        if left_root == right_root:
            return
        first, second = sorted((left_root, right_root))
        parents[second] = first

    identity_owners: dict[str, int] = {}
    for position, keys in enumerate(identity_keys):
        for key in keys:
            owner = identity_owners.setdefault(key, position)
            union(position, owner)

    groups: dict[int, list[int]] = {}
    for position in range(len(normalized)):
        groups.setdefault(root(position), []).append(position)

    coalesced: list[_PreparedScoutCandidate] = []
    preferred_positions: dict[str, int] = {}
    for positions in groups.values():
        merged = normalized[positions[0]]
        for position in positions[1:]:
            merged = _merge_scout_candidates(merged.url, merged, normalized[position])
        reported_urls = tuple(sorted({normalized[position].url for position in positions}))
        aliases = tuple(
            sorted(
                {alias_url for position in positions for alias_url in identity_alias_urls[position]}
            )
        )
        preferred_url = _preferred_scout_url(merged.sources, reported_urls)
        prepared_item = _PreparedScoutCandidate(
            candidate=replace(merged, url=preferred_url),
            identity_alias_urls=aliases,
        )
        prior_position = preferred_positions.get(preferred_url)
        if prior_position is None:
            preferred_positions[preferred_url] = len(coalesced)
            coalesced.append(prepared_item)
            continue
        prior = coalesced[prior_position]
        coalesced[prior_position] = _PreparedScoutCandidate(
            candidate=_merge_scout_candidates(
                preferred_url,
                prior.candidate,
                prepared_item.candidate,
            ),
            identity_alias_urls=tuple(sorted(set(prior.identity_alias_urls) | set(aliases))),
        )

    return {item.candidate.url: item for item in coalesced[:limit]}


def _scout_identity_alias_urls(candidate: DiscoveredJob) -> tuple[str, ...]:
    aliases = {candidate.url}
    for source in candidate.sources:
        if source.source_kind not in {JobSourceKind.COMPANY, JobSourceKind.ATS}:
            continue
        try:
            aliases.add(canonicalize_job_url(source.url))
        except (InvalidJobUrl, UnicodeError):
            continue
    return tuple(sorted(aliases))


def _preferred_scout_url(sources: Sequence[WebSourceDraft], reported_urls: Sequence[str]) -> str:
    direct_urls: dict[JobSourceKind, set[str]] = {
        JobSourceKind.COMPANY: set(),
        JobSourceKind.ATS: set(),
    }
    for source in sources:
        if source.source_kind not in direct_urls:
            continue
        try:
            canonical = canonicalize_job_url(source.url)
        except (InvalidJobUrl, UnicodeError):
            continue
        direct_urls[source.source_kind].add(canonical)
    for kind in (JobSourceKind.COMPANY, JobSourceKind.ATS):
        if direct_urls[kind]:
            return min(direct_urls[kind])
    return min(reported_urls)


def _merge_scout_candidates(
    canonical_url: str,
    first: DiscoveredJob,
    second: DiscoveredJob,
) -> DiscoveredJob:
    left = _normalized_scout_details(first.details)
    right = _normalized_scout_details(second.details)

    def text_fact(name: str, left_value: str, right_value: str) -> str:
        if left_value and right_value and left_value.casefold() != right_value.casefold():
            raise ProviderFailureError(
                f"Scout returned conflicting {name} facts for {canonical_url}"
            )
        return left_value or right_value

    def optional_text_fact(
        name: str, left_value: str | None, right_value: str | None
    ) -> str | None:
        merged = text_fact(name, left_value or "", right_value or "")
        return merged or None

    def identity_fact(name: str, left_value: str, right_value: str) -> str:
        if (
            left_value
            and right_value
            and _identity_component(left_value) != _identity_component(right_value)
        ):
            raise ProviderFailureError(
                f"Scout returned conflicting {name} facts for {canonical_url}"
            )
        return left_value or right_value

    def scalar_fact(name: str, left_value: Any, right_value: Any) -> Any:
        if left_value is not None and right_value is not None and left_value != right_value:
            raise ProviderFailureError(
                f"Scout returned conflicting {name} facts for {canonical_url}"
            )
        return left_value if left_value is not None else right_value

    metadata = dict(left.source_metadata)
    for key, value in right.source_metadata.items():
        if key in metadata and metadata[key] != value:
            raise ProviderFailureError(
                f"Scout returned conflicting source metadata {key!r} for {canonical_url}"
            )
        metadata[key] = value
    merged = JobDetails(
        title=text_fact("title", left.title, right.title),
        company=identity_fact("company", left.company, right.company),
        location=text_fact("location", left.location, right.location),
        description=text_fact("description", left.description, right.description),
        source=text_fact("source", left.source, right.source),
        source_metadata=metadata,
        employment_type=text_fact("employment type", left.employment_type, right.employment_type),
        seniority=text_fact("seniority", left.seniority, right.seniority),
        salary_min=scalar_fact("salary minimum", left.salary_min, right.salary_min),
        salary_max=scalar_fact("salary maximum", left.salary_max, right.salary_max),
        salary_currency=optional_text_fact(
            "salary currency", left.salary_currency, right.salary_currency
        ),
        external_requisition_id=identity_fact(
            "external requisition ID",
            left.external_requisition_id or "",
            right.external_requisition_id or "",
        )
        or None,
        listing_closed=scalar_fact(
            "listing-closed status", left.listing_closed, right.listing_closed
        ),
        hq_country=optional_text_fact("headquarters country", left.hq_country, right.hq_country),
        startup=scalar_fact("startup status", left.startup, right.startup),
        work_authorization_required=scalar_fact(
            "work-authorization requirement",
            left.work_authorization_required,
            right.work_authorization_required,
        ),
        us_only=scalar_fact("US-only status", left.us_only, right.us_only),
        remote_from_ecuador=scalar_fact(
            "remote-from-Ecuador status",
            left.remote_from_ecuador,
            right.remote_from_ecuador,
        ),
        remote_arrangement=optional_text_fact(
            "remote arrangement",
            left.remote_arrangement,
            right.remote_arrangement,
        ),
        hiring_arrangement=optional_text_fact(
            "hiring arrangement",
            left.hiring_arrangement,
            right.hiring_arrangement,
        ),
    )
    return DiscoveredJob(
        url=canonical_url,
        details=merged,
        sources=_merge_web_source_drafts(first.sources, second.sources),
    )


def _merge_web_source_drafts(
    first: Sequence[WebSourceDraft],
    second: Sequence[WebSourceDraft],
) -> tuple[WebSourceDraft, ...]:
    merged: dict[tuple[str, str, str], WebSourceDraft] = {}
    for source in (*first, *second):
        try:
            source_url = canonicalize_job_url(source.url)
        except (InvalidJobUrl, UnicodeError):
            source_url = source.url.strip()
        checksum = hashlib.sha256(
            source.content
            if source.content is not None
            else (source.quoted_evidence or source.url).encode("utf-8")
        ).hexdigest()
        key = (source_url, source.source_kind.value, checksum)
        existing = merged.get(key)
        if existing is None:
            merged[key] = replace(source, url=source_url)
        else:
            merged[key] = replace(
                existing,
                title=existing.title.strip() or source.title.strip(),
                publisher=existing.publisher.strip() or source.publisher.strip(),
                quoted_evidence=(
                    existing.quoted_evidence.strip() or source.quoted_evidence.strip()
                ),
            )
    return tuple(merged.values())


def _job_identity_specs(
    canonical_url: str, details: JobDetails
) -> tuple[tuple[str, JobIdentityKind], ...]:
    identities: list[tuple[str, JobIdentityKind]] = [
        (f"url:{canonical_url}", JobIdentityKind.CANONICAL_URL)
    ]
    company = _identity_component(details.company)
    requisition = _identity_component(details.external_requisition_id or "")
    if company and requisition:
        identities.append((f"requisition:{company}:{requisition}", JobIdentityKind.REQUISITION))
    return tuple(identities)


def _identity_component(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")


def _canonical_request_value(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return _canonical_request_value(asdict(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): _canonical_request_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (tuple, list)):
        return tuple(_canonical_request_value(item) for item in value)
    return value


def _request_fingerprint(command_type: str, **payload: Any) -> str:
    return stable_fingerprint(
        command_type=command_type,
        request=_canonical_request_value(payload),
    )


def _validate_command_replay(
    receipt: CommandReceipt,
    command_type: str,
    request_fingerprint: str,
) -> None:
    if receipt.command_type != command_type or receipt.request_fingerprint != request_fingerprint:
        raise ValidationError("command ID was already used with a different target or payload")


def _validated_legacy_sources(
    sources: Sequence[LegacySourceManifest],
) -> tuple[LegacySourceManifest, ...]:
    expected_names = ("state.sqlite3", "state-v2.sqlite3")
    by_name: dict[str, LegacySourceManifest] = {}
    for source in sources:
        name = source.database_name.strip()
        checksum = source.source_checksum.strip().lower()
        if name not in expected_names or name in by_name:
            raise ValidationError(
                "legacy import requires one manifest for state.sqlite3 and one for state-v2.sqlite3"
            )
        if not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise ValidationError(f"legacy source checksum for {name} must be a SHA-256 digest")
        if min(source.size_bytes, source.job_count, source.event_count) < 0:
            raise ValidationError("legacy source sizes and row counts cannot be negative")
        by_name[name] = replace(
            source,
            database_name=name,
            source_checksum=checksum,
        )
    if set(by_name) != set(expected_names):
        raise ValidationError(
            "legacy import requires both state.sqlite3 and state-v2.sqlite3 manifests"
        )
    return tuple(by_name[name] for name in expected_names)


def _resume_source_runtime_checks(
    source: ResumeSource | None,
    evidence: ResumeEvidenceVersion | None,
) -> tuple[RuntimeCheck, ...]:
    configured = source is not None
    trusted = source is not None and source.trust_acknowledged_at is not None
    synced = bool(
        source is not None
        and evidence is not None
        and source.last_synced_revision
        and source.last_synced_evidence_version_id == evidence.id
        and source.last_synced_revision == evidence.source_revision
        and source.id == evidence.resume_source_id
        and source.kind == evidence.resume_source_kind
        and source.repository == evidence.source_repository
        and source.ref == evidence.source_ref
    )
    contract_v1 = bool(
        synced and evidence is not None and _version_major(evidence.contract_schema_version) == 1
    )
    renderer_compatible = bool(
        contract_v1
        and evidence is not None
        and _version_major(evidence.renderer_protocol_version) == 1
        and evidence.renderer_version
        and evidence.contract_checksum
        and re.fullmatch(r"[a-f0-9]{64}", evidence.contract_checksum)
    )
    return (
        RuntimeCheck(
            "resume_source_configured",
            configured,
            "Configured" if configured else "Configure a trusted master résumé repository",
        ),
        RuntimeCheck(
            "resume_source_trusted",
            trusted,
            (
                "Trust acknowledged for the current repository/ref"
                if trusted
                else "Acknowledge trust for repository code and future commits"
            ),
        ),
        RuntimeCheck(
            "resume_source_synced",
            synced,
            (
                f"Pinned at {source.last_synced_revision}"
                if synced and source is not None
                else "Synchronize the configured source to pin an exact clean revision"
            ),
        ),
        RuntimeCheck(
            "resume_contract_v1",
            contract_v1,
            "Contract major version 1" if contract_v1 else "Sync a v1 contract snapshot",
        ),
        RuntimeCheck(
            "resume_renderer_compatible",
            renderer_compatible,
            (
                "Renderer metadata is compatible and checksum-pinned"
                if renderer_compatible
                else "Sync a contract with compatible v1 renderer metadata"
            ),
        ),
    )


def _version_major(value: str | None) -> int | None:
    if value is None:
        return None
    match = re.search(r"(?:^|[^0-9])v?(\d+)(?:\.|$)", value.strip(), re.IGNORECASE)
    return None if match is None else int(match.group(1))


def _register_resume_run_artifacts(uow: UnitOfWork, run: ResumeRun) -> None:
    for artifact in (
        run.artifact,
        run.selection_artifact,
        run.tailored_source_bundle_artifact,
        run.render_receipt_artifact,
        run.review_file_artifact,
        run.compile_log_artifact,
        run.ats_text_artifact,
    ):
        if artifact is not None:
            uow.artifacts.add(artifact)


def _latest_answer_values(
    events: Sequence[VerificationAnswerEvent],
) -> dict[str, Answer]:
    return {item.question_key: item.answer for item in events}


def _latest_answers_for_review(
    uow: UnitOfWork,
    review: ReviewVersion,
    events: Sequence[VerificationAnswerEvent],
) -> dict[str, Answer]:
    """Reuse an answer only when its exact question semantics are unchanged."""

    current = {question.id: question for question in review.questions}
    latest = {event.question_key: event for event in events}
    answers: dict[str, Answer] = {}
    for key, event in latest.items():
        current_question = current.get(key)
        asked_review = uow.reviews.get(event.asked_by_review_version_id)
        if current_question is None or asked_review is None:
            continue
        asked_question = next(
            (question for question in asked_review.questions if question.id == key),
            None,
        )
        if asked_question is not None and _question_semantics(
            asked_question
        ) == _question_semantics(current_question):
            answers[key] = event.answer
    return answers


def _question_semantics(question: ReviewQuestion) -> tuple[object, ...]:
    return (
        question.prompt,
        question.category.value,
        question.required,
        question.qualifying_answer.value,
        question.source_anchor,
    )


def _sanitized_error(exc: BaseException) -> tuple[str, str]:
    if isinstance(exc, ApplicationError):
        code = exc.code
        message = exc.message
    else:
        code = type(exc).__name__.lower()
        message = str(exc) or type(exc).__name__
    message = re.sub(
        r"(?i)(?:api[_ -]?key|bearer|token|secret)(?:\s*[=:]\s*|/)?\S*",
        "[redacted]",
        message,
    )
    message = re.sub(
        r"(?<![:/])/(?:Users|home|private|tmp|var)(?:/[^\s,;:]+)+",
        "[path]",
        message,
    )
    return code[:80], message[:1000]


def _provider_is_available(provider: object | None) -> bool:
    return provider is not None and bool(getattr(provider, "available", True))
