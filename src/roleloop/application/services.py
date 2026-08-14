"""Framework-independent RoleLoop use cases."""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

from roleloop.domain import (
    Answer,
    ApplicationStatus,
    ApplicationSubmission,
    Decision,
    EligibilityStatus,
    EvidenceSourceKind,
    Finding,
    Job,
    JobCase,
    Outcome,
    OutcomeEvent,
    QuestionCategory,
    ResumeEvidenceVersion,
    ResumeRun,
    ResumeSource,
    ResumeSourceKind,
    ResumeStage,
    ResumeStatus,
    ReviewQuestion,
    ReviewStatus,
    ReviewVersion,
    SearchProfile,
    ValidationSeverity,
    VerificationAnswer,
    WorkflowEvent,
    canonicalize_job_url,
    derive_eligibility,
    resume_input_fingerprint,
    resume_status,
    review_fingerprint,
    review_status,
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
    AnalysisQuestion,
    EvidenceImport,
    GenerationContext,
    InboxFilters,
    JobDetails,
    JobHistoryView,
    JobInboxItem,
    JobReviewView,
    Page,
    ProfileDraft,
    ProgressUpdate,
    ResumeSourceDraft,
    ResumeSourceSnapshot,
    ReviewContext,
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
    ArtifactStore,
    Clock,
    DiscoveryProvider,
    EvidenceExtractor,
    IdGenerator,
    NullProgressReporter,
    PdfCompiler,
    ProgressReporter,
    ResumeGenerator,
    ResumeSourceSynchronizer,
    ResumeValidator,
    ReviewAnalyzer,
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

    @property
    def provider_capabilities(self) -> dict[str, bool]:
        return {
            "discovery": _provider_is_available(self._discovery),
            "review": _provider_is_available(self._analyzer),
            "resume_generation": _provider_is_available(self._generator),
            "resume_validation": _provider_is_available(self._validator),
            "pdf_compilation": _provider_is_available(self._compiler),
            "evidence_extraction": _provider_is_available(self._evidence_extractor),
            "artifact_storage": _provider_is_available(self._artifact_store),
            "resume_source_sync": _provider_is_available(self._resume_source_synchronizer)
            and _provider_is_available(self._artifact_store),
        }

    # Profiles and evidence -------------------------------------------------

    def create_profile(self, draft: ProfileDraft) -> SearchProfile:
        draft = _validated_profile_draft(draft)
        now = self._clock.now()
        with self._uow_factory() as uow:
            first_profile = uow.profiles.get_active() is None
            profile = SearchProfile(
                id=self._ids.new(),
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
                is_active=first_profile,
                created_at=now,
                updated_at=now,
            )
            uow.profiles.add(profile)
            self._event(
                uow,
                profile.id,
                "profile.created",
                metadata={"name": profile.name, "active": first_profile},
            )
            uow.commit()
            return profile

    def update_profile(
        self,
        profile_id: str,
        draft: ProfileDraft,
        *,
        expected_revision: int,
    ) -> SearchProfile:
        draft = _validated_profile_draft(draft)
        with self._uow_factory() as uow:
            current = self._require_profile(uow, profile_id)
            self._check_revision(current.revision, expected_revision, "profile")
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
                revision=current.revision + 1,
                updated_at=self._clock.now(),
            )
            if not uow.profiles.update(updated, expected_revision=expected_revision):
                raise RevisionConflictError("profile was changed by another operation")
            self._event(uow, profile_id, "profile.updated")
            uow.commit()
            return updated

    def list_profiles(self) -> tuple[SearchProfile, ...]:
        with self._uow_factory() as uow:
            return tuple(uow.profiles.list())

    def activate_profile(self, profile_id: str) -> SearchProfile:
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
            if not uow.profiles.set_active(profile_id, at=self._clock.now()):
                raise RevisionConflictError("profile could not be activated")
            self._event(uow, profile_id, "profile.activated")
            active = self._require_profile(uow, profile_id)
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
    ) -> ResumeSource:
        """Create or update the one master-résumé source assigned to a profile."""

        draft = _validated_resume_source_draft(draft)
        now = self._clock.now()
        with self._uow_factory() as uow:
            self._require_profile(uow, profile_id)
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
                if configured_values == current_values:
                    return current
                source = replace(
                    current,
                    kind=configured_values[0],
                    repository=configured_values[1],
                    ref=configured_values[2],
                    document_path=configured_values[3],
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
        progress: ProgressReporter | None = None,
    ) -> ResumeEvidenceVersion:
        """Resolve a pinned Git snapshot and activate it as immutable evidence."""

        synchronizer = self._require_provider(
            self._resume_source_synchronizer, "résumé source synchronization"
        )
        store = self._require_provider(self._artifact_store, "artifact storage")
        reporter = progress or NullProgressReporter()
        with self._uow_factory() as uow:
            profile = self._require_profile(uow, profile_id)
            source = uow.resume_sources.get_for_profile(profile_id)
            if source is None:
                raise InvalidTransitionError(
                    "configure a master résumé source before synchronizing it"
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
                if current_profile.active_evidence_version_id == existing_evidence.id:
                    reporter.report(
                        ProgressUpdate(
                            operation="resume_source_sync",
                            stage="complete",
                            message="Master résumé is already current",
                        )
                    )
                    return existing_evidence
                now = self._clock.now()
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
        progress: ProgressReporter | None = None,
    ) -> tuple[JobCase, ...]:
        if limit <= 0:
            raise ValidationError("discovery limit must be positive")
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

    # Review ---------------------------------------------------------------

    async def review_job(
        self,
        profile_id: str,
        job_id: str,
        *,
        progress: ProgressReporter | None = None,
    ) -> JobReviewView:
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
            questions = _materialize_questions(analysis.questions, self._ids)
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
    ) -> JobReviewView:
        if not isinstance(answer, Answer):
            raise ValidationError("answer must be yes, no, or unknown")
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

    # Human decisions and résumé generation -------------------------------

    def decide_job(self, profile_id: str, job_id: str, decision: Decision) -> JobCase:
        if not isinstance(decision, Decision) or decision is Decision.UNDECIDED:
            raise ValidationError("decision must be tailor, watch, or skip")
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

    async def generate_resume(
        self,
        profile_id: str,
        job_id: str,
        *,
        progress: ProgressReporter | None = None,
    ) -> ResumeRun:
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
            self._fail_run(run, str(exc))
            raise ProviderFailureError(
                f"résumé generation failed during {run.stage.value}: {exc}"
            ) from exc

    def recover_interrupted_runs(self) -> int:
        """Mark runs abandoned by a prior process as interrupted and retryable."""

        with self._uow_factory() as uow:
            runs = tuple(uow.resume_runs.list_in_progress())
            if not runs:
                return 0
            now = self._clock.now()
            for run in runs:
                updated = replace(
                    run,
                    stage=ResumeStage.INTERRUPTED,
                    error_message="process stopped before generation completed",
                    updated_at=now,
                )
                uow.resume_runs.update(updated)
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
            uow.commit()
            return len(runs)

    # Applications and outcomes -------------------------------------------

    def mark_applied(self, profile_id: str, job_id: str) -> JobCase:
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

    def record_outcome(self, profile_id: str, job_id: str, outcome: Outcome) -> JobCase:
        if not isinstance(outcome, Outcome):
            raise ValidationError("outcome is not supported")
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

    def _add_job_case(
        self,
        uow: UnitOfWork,
        profile_id: str,
        canonical_url: str,
        details: JobDetails,
    ) -> tuple[Job, JobCase, bool]:
        now = self._clock.now()
        job = uow.jobs.get_by_canonical_url(canonical_url)
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
            self._expected_review_fingerprint(profile, job, review) if review is not None else None
        )
        review_state = review_status(review, expected_fingerprint=expected_review)
        answers = (
            {answer.question_id: answer.answer for answer in uow.reviews.list_answers(review.id)}
            if review is not None
            else {}
        )
        eligibility = (
            derive_eligibility(review.questions, answers)
            if review is not None
            else EligibilityStatus.UNRESOLVED
        )
        latest_run = uow.resume_runs.get_latest(case.id)
        expected_resume = self._expected_resume_fingerprint(
            profile, review, review_state, latest_run
        )
        return JobReviewView(
            job=job,
            case=case,
            review_status=review_state,
            review=review,
            answers=answers,
            eligibility_status=eligibility,
            latest_resume_run=latest_run,
            resume_status=resume_status(latest_run, expected_fingerprint=expected_resume),
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
            canonical_url=job.canonical_url,
            title=job.title,
            company=job.company,
            location=job.location,
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
        self, profile: SearchProfile, job: Job, review: ReviewVersion
    ) -> str:
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
    return replace(
        draft,
        name=name,
        target_roles=target_roles,
        locations=cleaned(draft.locations),
        employment_types=cleaned(draft.employment_types),
        seniority=cleaned(draft.seniority),
        include_keywords=cleaned(draft.include_keywords),
        exclude_keywords=cleaned(draft.exclude_keywords),
        salary_currency=currency,
        constraints=draft.constraints.strip(),
    )


def _validated_resume_source_draft(draft: ResumeSourceDraft) -> ResumeSourceDraft:
    if not isinstance(draft.kind, ResumeSourceKind):
        raise ValidationError("résumé source kind must be local_git or remote_git")

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
    return replace(
        snapshot,
        source_name=source_name,
        media_type=media_type,
        extension=extension,
        source_revision=source_revision,
        content_checksum=content_checksum,
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
    questions: Sequence[AnalysisQuestion], ids: IdGenerator
) -> tuple[ReviewQuestion, ...]:
    result: list[ReviewQuestion] = []
    seen: set[str] = set()
    for supplied in questions:
        if supplied.key is not None and not isinstance(supplied.key, str):
            raise ValueError("review question identifiers must be strings")
        question_id = (supplied.key or ids.new()).strip()
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
            )
        )
    return tuple(result)


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


def _provider_is_available(provider: object | None) -> bool:
    return provider is not None and bool(getattr(provider, "available", True))
