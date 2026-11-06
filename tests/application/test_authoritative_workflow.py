from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta

import pytest

from roleloop.application import (
    AgentAudit,
    AgentDescriptor,
    AnalysisQuestion,
    ApplicationStageDraft,
    DiscoveredJob,
    JobDetails,
    LegacyEventDraft,
    LegacyImportDraft,
    LegacyJobDraft,
    LegacySourceManifest,
    MasterResumeRenderResult,
    PdfInspection,
    ProfileDraft,
    ResumeSelection,
    ResumeSourceDraft,
    ResumeSourceSnapshot,
    ReviewerReport,
    RoleLoopService,
    ScoutReport,
    SubmitApplicationDraft,
    WebSourceDraft,
)
from roleloop.application.errors import (
    ArtifactError,
    InvalidTransitionError,
    NotFoundError,
    ProviderFailureError,
    RevisionConflictError,
    ValidationError,
)
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
    ArtifactRef,
    Decision,
    DecisionReason,
    EligibilityStatus,
    HardBlockerKind,
    JobSourceKind,
    Outcome,
    QuestionCategory,
    ResumeExperienceSelection,
    ResumeReviewDecision,
    ResumeSourceKind,
    ResumeStage,
    ReviewRequirement,
    ReviewStatus,
    TrackedApplication,
)

from .fakes import AdvancingClock, MemoryUnitOfWorkFactory, SequentialIds

_PROMPT_HASH = "1" * 64
_SCHEMA_HASH = "2" * 64


def _descriptor() -> AgentDescriptor:
    return AgentDescriptor(
        provider=AgentProvider.DEMO,
        model="gpt-5.6-terra",
        prompt_version="test-v1",
        output_schema_version="test-v1",
        prompt_hash=_PROMPT_HASH,
        output_schema_hash=_SCHEMA_HASH,
    )


def _audit() -> AgentAudit:
    return AgentAudit(
        prompt_hash=_PROMPT_HASH,
        output_schema_hash=_SCHEMA_HASH,
    )


class _Scout:
    descriptor = _descriptor()

    async def discover(self, context, *, progress):
        del context, progress
        return ScoutReport(
            (
                DiscoveredJob(
                    "https://jobs.example.test/role-1",
                    JobDetails(title="Platform Engineer", company="Example"),
                ),
            ),
            _audit(),
        )


class _Reviewer:
    descriptor = _descriptor()

    async def analyze(self, context, *, progress):
        del context, progress
        # Deliberately omit UNKNOWN-screen questions. The service must generate them.
        return ReviewerReport(
            match_evidence=(),
            skeptic_findings=(),
            questions=(),
            recommended_decision=Decision.TAILOR,
            confidence=0.9,
            positioning="Lead with platform reliability.",
            self_critique="Evidence is limited to the retained master résumé.",
            audit=_audit(),
        )


class _ChangingQuestionReviewer(_Reviewer):
    def __init__(self) -> None:
        self.calls = 0

    async def analyze(self, context, *, progress):
        del context, progress
        self.calls += 1
        return ReviewerReport(
            match_evidence=(),
            skeptic_findings=(),
            questions=(
                AnalysisQuestion(
                    prompt=(
                        "Do you have production Python experience?"
                        if self.calls == 1
                        else "Do you have production Rust experience?"
                    ),
                    category=QuestionCategory.VERIFICATION,
                    required=True,
                    qualifying_answer=Answer.YES,
                    key="experience.production",
                    source_anchor="job:description",
                ),
            ),
            recommended_decision=Decision.TAILOR,
            confidence=0.9,
            positioning="Lead with exact production evidence.",
            self_critique="The human must verify this claim.",
            audit=_audit(),
        )


class _BadRequirementReviewer(_Reviewer):
    async def analyze(self, context, *, progress):
        del context, progress
        duplicate = ReviewRequirement(
            key="requirement.python",
            text="Production Python",
            evidence="The listing requires Python.",
            source_anchor="job:description",
        )
        return ReviewerReport(
            match_evidence=(),
            skeptic_findings=(),
            questions=(),
            requirements=(duplicate, duplicate),
            recommended_decision=Decision.TAILOR,
            confidence=0.9,
            positioning="Lead with exact evidence.",
            self_critique="Duplicate output is invalid.",
            audit=_audit(),
        )


class _MutatingReviewer(_Reviewer):
    def __init__(self) -> None:
        self.mutate = None

    async def analyze(self, context, *, progress):
        report = await super().analyze(context, progress=progress)
        assert self.mutate is not None
        self.mutate()
        return report


class _SalaryScout:
    descriptor = _descriptor()

    async def discover(self, context, *, progress):
        del context, progress
        return ScoutReport(
            (
                DiscoveredJob(
                    "https://jobs.example.test/under-floor",
                    JobDetails(
                        title="Platform Engineer",
                        company="Example",
                        salary_max=90_000,
                        salary_currency="USD",
                        listing_closed=False,
                        work_authorization_required=False,
                        us_only=False,
                    ),
                ),
            ),
            _audit(),
        )


class _ArrangementScout:
    descriptor = _descriptor()

    async def discover(self, context, *, progress):
        del context, progress
        return ScoutReport(
            (
                DiscoveredJob(
                    "https://jobs.example.test/contractor-role",
                    JobDetails(
                        title="Platform Engineer",
                        company="Example",
                        remote_from_ecuador=True,
                        remote_arrangement="fully-remote",
                        hiring_arrangement="international_contractor",
                    ),
                ),
            ),
            _audit(),
        )


class _Registry:
    def __init__(self) -> None:
        self._scout = _Scout()
        self._reviewer = _Reviewer()

    def scout(self, profile_version):
        del profile_version
        return self._scout

    def reviewer(self, profile_version):
        del profile_version
        return self._reviewer

    def resume(self, profile_version):
        del profile_version
        raise AssertionError("Resume should not run in this gate test")


class _SalaryRegistry(_Registry):
    def __init__(self) -> None:
        super().__init__()
        self._scout = _SalaryScout()


class _Resume:
    descriptor = _descriptor()

    def __init__(
        self,
        *,
        fail_on_call: int | None = None,
        audit: AgentAudit | None = None,
    ) -> None:
        self.calls = 0
        self.fail_on_call = fail_on_call
        self.audit = audit or _audit()

    async def select(self, context, *, progress):
        del context, progress
        self.calls += 1
        if self.calls == self.fail_on_call:
            raise RuntimeError("provider transport included /private/secret/token")
        return ResumeSelection(
            headline="Platform Engineer",
            experiences=(ResumeExperienceSelection("experience.one", ("bullet.one",)),),
            skill_ids=("skill.python",),
            audit=self.audit,
        )


class _FullRegistry(_Registry):
    def __init__(
        self,
        *,
        scout=None,
        reviewer=None,
        resume: _Resume | None = None,
    ) -> None:
        super().__init__()
        if scout is not None:
            self._scout = scout
        if reviewer is not None:
            self._reviewer = reviewer
        self._resume = resume or _Resume()

    def resume(self, profile_version):
        del profile_version
        return self._resume


class _Renderer:
    protocol_version = "v1"

    async def render(self, request, *, progress):
        del progress
        pdf = b"%PDF-1.4\n% RoleLoop test\n%%EOF\n"
        selection_file = json.dumps(
            {
                "headline": request.selection.headline,
                "experiences": [
                    {
                        "experience_id": item.experience_id,
                        "bullet_ids": list(item.bullet_ids),
                    }
                    for item in request.selection.experiences
                ],
                "skill_ids": list(request.selection.skill_ids),
            },
            sort_keys=True,
        ).encode()
        source = b"tailored source bundle"
        return MasterResumeRenderResult(
            pdf=pdf,
            receipt=b"{}",
            renderer_version="test-renderer-v1",
            tailored_source_bundle=source,
            selection_file=selection_file,
            review_file=b"review",
            compile_log=b"compiled",
            page_count=1,
            ats_text="Platform Engineer",
            tool_versions={"latex": "test"},
            output_checksums={
                "resume.pdf": hashlib.sha256(pdf).hexdigest(),
                "tailoring-selection.json": hashlib.sha256(selection_file).hexdigest(),
                "render-source.tar": hashlib.sha256(source).hexdigest(),
            },
            renderer_source_revision=request.evidence.source_revision or "",
        )


class _BlockingRenderer(_Renderer):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def render(self, request, *, progress):
        self.started.set()
        await self.release.wait()
        return await super().render(request, progress=progress)


class _FailingOnceRenderer(_Renderer):
    def __init__(self) -> None:
        self.calls = 0

    async def render(self, request, *, progress):
        self.calls += 1
        if self.calls == 1:
            raise ArtifactError("latexmk failed after selection")
        return await super().render(request, progress=progress)


class _Inspector:
    def inspect(self, pdf):
        return PdfInspection(pdf.startswith(b"%PDF-"), 1, "application/pdf")


class _DuplicateScout:
    descriptor = _descriptor()

    async def discover(self, context, *, progress):
        del context, progress
        first = JobDetails(
            title="Platform Engineer",
            company="Example",
            external_requisition_id="REQ-1",
        )
        second = JobDetails(
            title="  Platform Engineer ",
            company="example",
            external_requisition_id="req-1",
            listing_closed=False,
        )
        return ScoutReport(
            (
                DiscoveredJob(
                    "https://jobs.example.test/role-duplicate?utm_source=one",
                    first,
                    (
                        WebSourceDraft(
                            "https://example.test/careers/role-duplicate",
                            JobSourceKind.COMPANY,
                            quoted_evidence="company evidence",
                        ),
                    ),
                ),
                DiscoveredJob(
                    "https://jobs.example.test/role-duplicate?utm_source=two",
                    second,
                    (
                        WebSourceDraft(
                            "https://ats.example.test/roles/role-duplicate",
                            JobSourceKind.ATS,
                            quoted_evidence="ATS evidence",
                        ),
                    ),
                ),
            ),
            _audit(),
        )


class _FailingScout:
    descriptor = _descriptor()

    async def discover(self, context, *, progress):
        del context, progress
        raise RuntimeError("Scout transport failed")


class _Synchronizer:
    def __init__(self) -> None:
        self.calls = 0

    async def sync(self, source, *, progress):
        del source, progress
        self.calls += 1
        payload = b"canonical resume"
        return ResumeSourceSnapshot(
            source_bytes=payload,
            extracted_text="canonical resume",
            source_name="evidence.json",
            media_type="application/json",
            extension=".json",
            source_revision="a" * 40,
            content_checksum=hashlib.sha256(payload).hexdigest(),
            contract_schema_version="v1",
            canonical_evidence_bytes=b"{}",
            source_bundle_bytes=b"source tar",
            renderer_protocol_version="v1",
            renderer_version="test-renderer-v1",
            contract_checksum="3" * 64,
        )


class _ArtifactStore:
    def __init__(self) -> None:
        self._counter = 0
        self._data: dict[str, bytes] = {}

    async def put_bytes(self, data, *, media_type, extension):
        del extension
        self._counter += 1
        artifact = ArtifactRef(
            id=f"artifact-{self._counter}",
            checksum=hashlib.sha256(data).hexdigest(),
            uri=f"managed/artifact-{self._counter}",
            media_type=media_type,
            size_bytes=len(data),
        )
        self._data[artifact.id] = data
        return artifact

    async def read_bytes(self, artifact):
        return self._data[artifact.id]


class _FailingFinalizationFactory(MemoryUnitOfWorkFactory):
    def __init__(self) -> None:
        super().__init__()
        self.fail_success_update = True

    def __call__(self):
        uow = super().__call__()
        update = uow.resume_runs.update

        def fail_once(run):
            if self.fail_success_update and run.stage is ResumeStage.READY:
                self.fail_success_update = False
                raise RuntimeError("injected finalization failure")
            update(run)

        uow.resume_runs.update = fail_once
        return uow


@pytest.mark.asyncio
async def test_unknown_screens_survive_reviewer_omission_and_answers_survive_rerun() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=_Registry(),
        resume_source_synchronizer=_Synchronizer(),
        artifact_store=artifacts,
        artifact_reader=artifacts,
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            accepted_remote_arrangements=("remote",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository="https://example.test/master-resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            trust_repository=True,
        ),
    )
    (case,) = await service.discover_jobs(profile.id)

    first = await service.review_job(profile.id, case.job_id)

    assert first.review_status is ReviewStatus.CURRENT
    assert first.review is not None
    assert first.review.questions
    assert all(question.required for question in first.review.questions)
    assert {question.id for question in first.review.questions} == {
        evaluation.rule_id
        for evaluation in first.screen_evaluations
        if evaluation.result.value == "unknown"
    }
    summary = service.get_active_profile_summary()
    assert summary is not None and summary.evidence is not None
    payload = await service.get_artifact(summary.evidence.source_artifact.id)
    assert payload.data == b"canonical resume"
    for question in first.review.questions:
        service.answer_verification(
            profile.id,
            case.job_id,
            question.id,
            Answer.YES,
        )

    rerun = await service.review_job(profile.id, case.job_id, rerun=True)

    assert rerun.review is not None
    assert rerun.review.id != first.review.id
    assert rerun.eligibility_status is EligibilityStatus.ELIGIBLE
    assert set(rerun.answers) == {question.id for question in rerun.review.questions}
    with pytest.raises(InvalidTransitionError, match="decide_and_tailor"):
        service.decide_job(profile.id, case.job_id, Decision.TAILOR)
    with factory() as uow:
        assert tuple(uow.decision_events.list_for_case(case.id)) == ()
        assert tuple(uow.resume_runs.list_for_case(case.id)) == ()


@pytest.mark.asyncio
async def test_known_salary_maximum_below_profile_floor_auto_skips() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=_SalaryRegistry(),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            annual_salary_floor=100_000,
            salary_currency="USD",
            agent_provider=AgentProvider.DEMO,
        )
    )

    (case,) = await service.discover_jobs(profile.id)

    assert case.decision is Decision.SKIP
    with factory() as uow:
        profile_version = uow.profile_versions.get_current(profile.id)
        assert profile_version is not None
        rules = {rule.id: rule for rule in uow.profile_versions.list_rules(profile_version.id)}
        job_version = uow.job_versions.get_current(case.job_id)
        assert job_version is not None
        screens = uow.screens.list_current(case.id, job_version.id, profile_version.id)
        failed_kinds = {
            rules[screen.rule_id].kind.value for screen in screens if screen.result.value == "fail"
        }
        assert failed_kinds == {"salary_maximum"}


@pytest.mark.asyncio
async def test_arrangement_tokens_match_across_spaces_hyphens_and_underscores() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=_FullRegistry(scout=_ArrangementScout()),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            accepted_remote_arrangements=("fully remote",),
            accepted_hiring_arrangements=("international contractor",),
            agent_provider=AgentProvider.DEMO,
        )
    )

    (case,) = await service.discover_jobs(profile.id)

    assert case.decision is Decision.UNDECIDED
    with factory() as uow:
        version = uow.profile_versions.get_current(profile.id)
        job_version = uow.job_versions.get_current(case.job_id)
        assert version is not None and job_version is not None
        assert version.accepted_remote_arrangements == ("fully_remote",)
        assert version.accepted_hiring_arrangements == ("international_contractor",)
        screen_by_kind = {
            rule.kind: screen.result
            for rule in uow.profile_versions.list_rules(version.id)
            for screen in uow.screens.list_current(case.id, job_version.id, version.id)
            if screen.rule_id == rule.id
        }
        assert screen_by_kind[HardBlockerKind.REMOTE_ARRANGEMENT].value == "pass"
        assert screen_by_kind[HardBlockerKind.REMOTE_HIRING].value == "pass"


def test_interview_stage_repeats_append_and_no_followup_clears_queue() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(factory, AdvancingClock(), SequentialIds())
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    case = service.add_job_url(profile.id, "https://jobs.example.test/role-2")
    submitted_at = datetime(2026, 1, 1, tzinfo=UTC)
    application = TrackedApplication(
        id="application",
        command_id="submission",
        job_id=case.job_id,
        job_case_id=case.id,
        current_stage=ApplicationStage.SUBMITTED,
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
    with factory() as uow:
        uow.tracked_applications.add(application)
        uow.tracked_applications.add_stage(
            ApplicationStageEvent(
                id="submitted-stage",
                command_id="submission-stage",
                application_id=application.id,
                stage=ApplicationStage.SUBMITTED,
                actor=ActorKind.HUMAN,
                occurred_at=submitted_at,
                recorded_at=submitted_at,
            )
        )
        uow.follow_ups.add(
            ApplicationFollowUp(
                id="first-follow-up",
                command_id="submission-follow-up",
                application_id=application.id,
                due_at=submitted_at + timedelta(days=1),
                created_at=submitted_at,
            )
        )
        uow.commit()

    service.record_application_stage(
        profile.id,
        case.job_id,
        ApplicationStageDraft(
            ApplicationStage.TECHNICAL_INTERVIEW,
            follow_up_at=submitted_at + timedelta(days=2),
        ),
    )
    service.record_application_stage(
        profile.id,
        case.job_id,
        ApplicationStageDraft(
            ApplicationStage.TECHNICAL_INTERVIEW,
            follow_up_at=submitted_at + timedelta(days=3),
        ),
    )
    view = service.record_application_stage(
        profile.id,
        case.job_id,
        ApplicationStageDraft(
            ApplicationStage.TECHNICAL_INTERVIEW,
            no_follow_up=True,
        ),
    )

    assert [event.stage for event in view.stages] == [
        ApplicationStage.SUBMITTED,
        ApplicationStage.TECHNICAL_INTERVIEW,
        ApplicationStage.TECHNICAL_INTERVIEW,
        ApplicationStage.TECHNICAL_INTERVIEW,
    ]
    assert view.open_follow_up is None


def test_followup_mutations_are_scoped_to_the_owning_profile_before_replay() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(factory, AdvancingClock(), SequentialIds())
    first = service.create_profile(
        ProfileDraft(
            name="First",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    second = service.create_profile(
        ProfileDraft(
            name="Second",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    first_case = service.add_job_url(first.id, "https://jobs.example.test/shared")
    second_case = service.add_job_url(second.id, "https://jobs.example.test/shared")
    now = datetime(2026, 1, 1, tzinfo=UTC)
    application = TrackedApplication(
        id="second-application",
        command_id="second-submission",
        job_id=second_case.job_id,
        job_case_id=second_case.id,
        current_stage=ApplicationStage.SUBMITTED,
        approved_resume_review_event_id=None,
        resume_run_id=None,
        pdf_artifact_id=None,
        pdf_checksum=None,
        job_version_id=None,
        profile_version_id=None,
        evidence_version_id=None,
        review_version_id=None,
        gate_decision_event_id=None,
        submitted_at=now,
        legacy=True,
        created_at=now,
        updated_at=now,
    )
    resolve_candidate = ApplicationFollowUp(
        id="second-resolve",
        command_id="second-resolve-create",
        application_id=application.id,
        due_at=now + timedelta(days=1),
        created_at=now,
    )
    reschedule_candidate = ApplicationFollowUp(
        id="second-reschedule",
        command_id="second-reschedule-create",
        application_id=application.id,
        due_at=now + timedelta(days=2),
        created_at=now,
    )
    with factory() as uow:
        uow.tracked_applications.add(application)
        uow.follow_ups.add(resolve_candidate)
        uow.follow_ups.add(reschedule_candidate)
        uow.commit()

    with pytest.raises(NotFoundError, match="follow-up was not found"):
        service.resolve_followup(
            first.id,
            resolve_candidate.id,
            command_id="cross-profile-resolve",
        )
    with pytest.raises(NotFoundError, match="follow-up was not found"):
        service.reschedule_followup(
            first.id,
            reschedule_candidate.id,
            now + timedelta(days=3),
            command_id="cross-profile-reschedule",
        )
    with factory() as uow:
        assert uow.commands.get("cross-profile-resolve") is None
        assert uow.commands.get("cross-profile-reschedule") is None
        assert uow.follow_ups.list_resolutions(resolve_candidate.id) == ()
        assert uow.follow_ups.list_resolutions(reschedule_candidate.id) == ()

    resolution = service.resolve_followup(
        second.id,
        resolve_candidate.id,
        command_id="second-profile-resolve",
    )
    assert (
        service.resolve_followup(
            second.id,
            resolve_candidate.id,
            command_id="second-profile-resolve",
        )
        == resolution
    )
    replacement = service.reschedule_followup(
        second.id,
        reschedule_candidate.id,
        now + timedelta(days=3),
        command_id="second-profile-reschedule",
    )
    assert (
        service.reschedule_followup(
            second.id,
            reschedule_candidate.id,
            now + timedelta(days=3),
            command_id="second-profile-reschedule",
        )
        == replacement
    )

    with pytest.raises(NotFoundError, match="follow-up was not found"):
        service.resolve_followup(
            first.id,
            resolve_candidate.id,
            command_id="second-profile-resolve",
        )
    with pytest.raises(NotFoundError, match="follow-up was not found"):
        service.reschedule_followup(
            first.id,
            reschedule_candidate.id,
            now + timedelta(days=3),
            command_id="second-profile-reschedule",
        )
    assert first_case.job_id == second_case.job_id


def _full_service(
    factory: MemoryUnitOfWorkFactory,
    artifacts: _ArtifactStore,
    *,
    registry: _FullRegistry | None = None,
    synchronizer: _Synchronizer | None = None,
    renderer: _Renderer | None = None,
) -> RoleLoopService:
    return RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=registry or _FullRegistry(),
        resume_source_synchronizer=synchronizer or _Synchronizer(),
        master_resume_renderer=renderer or _Renderer(),
        pdf_inspector=_Inspector(),
        artifact_store=artifacts,
        artifact_reader=artifacts,
    )


async def _reviewed_case(service: RoleLoopService):
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository="https://example.test/master-resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            trust_repository=True,
        ),
    )
    (case,) = await service.discover_jobs(profile.id)
    first = await service.review_job(profile.id, case.job_id)
    assert first.review is not None
    for question in first.review.questions:
        service.answer_verification(
            profile.id,
            case.job_id,
            question.id,
            Answer.YES,
        )
    reviewed = await service.review_job(profile.id, case.job_id, rerun=True)
    assert reviewed.eligibility_status is EligibilityStatus.ELIGIBLE
    return profile, case, reviewed


@pytest.mark.asyncio
async def test_tailor_and_revision_queue_atomically_and_replay_exact_runs() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    resume = _Resume()
    service = _full_service(
        factory,
        artifacts,
        registry=_FullRegistry(resume=resume),
    )
    profile, case, _ = await _reviewed_case(service)

    tailored = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
        command_id="tailor-command",
    )
    assert tailored.resume_run is not None
    assert tailored.resume_run.stage is ResumeStage.READY
    replay = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
        command_id="tailor-command",
    )
    assert replay.resume_run == tailored.resume_run
    assert resume.calls == 1
    with pytest.raises(InvalidTransitionError, match="current résumé chain is ready"):
        await service.decide_and_tailor(
            profile.id,
            case.job_id,
            Decision.TAILOR,
            command_id="second-root-is-forbidden",
        )

    child = await service.revise_resume(
        profile.id,
        case.job_id,
        "Lead with the strongest exact evidence.",
        command_id="revise-command",
    )
    child_replay = await service.revise_resume(
        profile.id,
        case.job_id,
        "Lead with the strongest exact evidence.",
        command_id="revise-command",
    )
    assert child.stage is ResumeStage.READY
    assert child.parent_resume_run_id == tailored.resume_run.id
    assert child_replay == child
    assert resume.calls == 2
    assert len(service.get_resume(profile.id, case.job_id).runs) == 2
    assert len(service.get_resume_review_history(profile.id, case.job_id)) == 1

    with pytest.raises(InvalidTransitionError, match="latest résumé run"):
        await service.approve_resume(
            profile.id,
            case.job_id,
            tailored.resume_run.id,
        )
    with pytest.raises(InvalidTransitionError, match="latest résumé run"):
        service.reject_resume(
            profile.id,
            case.job_id,
            tailored.resume_run.id,
        )

    with pytest.raises(InvalidTransitionError, match="initial RoleLoop"):
        await service.generate_resume(profile.id, case.job_id)


@pytest.mark.asyncio
async def test_failed_tailor_replay_returns_same_failed_run_without_duplicate() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    resume = _Resume(fail_on_call=1)
    service = _full_service(
        factory,
        artifacts,
        registry=_FullRegistry(resume=resume),
    )
    profile, case, _ = await _reviewed_case(service)

    with pytest.raises(ProviderFailureError):
        await service.decide_and_tailor(
            profile.id,
            case.job_id,
            Decision.TAILOR,
            command_id="failed-tailor",
        )
    replay = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
        command_id="failed-tailor",
    )

    assert replay.resume_run is not None
    assert replay.resume_run.stage is ResumeStage.FAILED
    assert "secret" not in replay.resume_run.error_message.lower()
    assert resume.calls == 1
    with factory() as uow:
        assert len(tuple(uow.resume_runs.list_for_case(case.id))) == 1
        assert len(tuple(uow.decision_events.list_for_case(case.id))) == 1

    with pytest.raises(InvalidTransitionError, match="resume retry"):
        await service.decide_and_tailor(
            profile.id,
            case.job_id,
            Decision.TAILOR,
            command_id="failed-tailor-new-root",
        )

    with factory() as uow:
        job = uow.jobs.get(case.job_id)
        assert job is not None
    service.update_job_details(
        profile.id,
        case.job_id,
        JobDetails(title="Refreshed role facts"),
        expected_revision=job.revision,
    )
    refreshed_review = await service.review_job(profile.id, case.job_id, rerun=True)
    assert refreshed_review.review is not None
    for question in refreshed_review.review.questions:
        service.answer_verification(
            profile.id,
            case.job_id,
            question.id,
            Answer.YES,
        )
    await service.review_job(profile.id, case.job_id, rerun=True)
    refreshed = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
        command_id="tailor-after-refresh",
    )
    assert refreshed.resume_run is not None
    assert refreshed.resume_run.stage is ResumeStage.READY
    assert refreshed.resume_run.review_version_id != replay.resume_run.review_version_id
    assert resume.calls == 2


@pytest.mark.asyncio
async def test_renderer_failure_preserves_successful_resume_agent_audit_and_can_retry() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    audit = AgentAudit(
        provider_response_id="resp-resume-1",
        response_model="gpt-5.6-terra",
        input_tokens=11,
        output_tokens=7,
        total_tokens=18,
        source_urls=("https://example.test/evidence", "https://example.test/evidence"),
        prompt_hash=_PROMPT_HASH,
        output_schema_hash=_SCHEMA_HASH,
        status_detail="selection completed",
    )
    resume = _Resume(audit=audit)
    renderer = _FailingOnceRenderer()
    service = _full_service(
        factory,
        artifacts,
        registry=_FullRegistry(resume=resume),
        renderer=renderer,
    )
    profile, case, _ = await _reviewed_case(service)

    with pytest.raises(ArtifactError, match="latexmk failed after selection"):
        await service.decide_and_tailor(
            profile.id,
            case.job_id,
            Decision.TAILOR,
            command_id="tailor-render-fails",
        )

    replay = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
        command_id="tailor-render-fails",
    )
    assert replay.resume_run is not None
    assert replay.resume_run.stage is ResumeStage.FAILED
    assert replay.resume_run.headline == "Platform Engineer"
    assert replay.resume_run.selected_bullet_ids == ("bullet.one",)
    assert replay.resume_run.selected_skill_ids == ("skill.python",)
    with factory() as uow:
        agent_run = uow.agent_runs.get(replay.resume_run.agent_run_id)
        assert agent_run is not None
        assert agent_run.status is AgentRunStatus.SUCCEEDED
        assert agent_run.provider_response_id == "resp-resume-1"
        assert agent_run.response_model == "gpt-5.6-terra"
        assert (agent_run.input_tokens, agent_run.output_tokens, agent_run.total_tokens) == (
            11,
            7,
            18,
        )
        assert agent_run.source_urls == ("https://example.test/evidence",)
        assert agent_run.prompt_hash == _PROMPT_HASH
        assert agent_run.output_schema_hash == _SCHEMA_HASH
        assert agent_run.status_detail == "selection completed"
        receipt = uow.commands.get("tailor-render-fails:resume")
        assert receipt is not None
        assert receipt.result_id == replay.resume_run.id

    retried = await service.retry_resume(
        profile.id,
        case.job_id,
        command_id="retry-render",
    )
    retried_replay = await service.retry_resume(
        profile.id,
        case.job_id,
        command_id="retry-render",
    )
    assert retried.stage is ResumeStage.READY
    assert retried.id != replay.resume_run.id
    assert retried_replay == retried
    assert resume.calls == 2
    assert renderer.calls == 2


@pytest.mark.asyncio
async def test_resume_finalization_failure_cannot_publish_a_ready_run() -> None:
    factory = _FailingFinalizationFactory()
    artifacts = _ArtifactStore()
    service = _full_service(factory, artifacts)
    profile, case, _ = await _reviewed_case(service)

    with pytest.raises(ProviderFailureError, match="finalization failure"):
        await service.decide_and_tailor(
            profile.id,
            case.job_id,
            Decision.TAILOR,
        )

    with factory() as uow:
        run = uow.resume_runs.get_latest(case.id)
        assert run is not None
        assert run.stage is ResumeStage.FAILED
        assert run.artifact is None
        assert run.agent_run_id is not None
        agent_run = uow.agent_runs.get(run.agent_run_id)
        assert agent_run is not None
        assert agent_run.status is AgentRunStatus.SUCCEEDED
        catalogued = set(uow.artifacts.state.artifacts)
    rendered_ids = {artifact_id for artifact_id in artifacts._data if artifact_id not in catalogued}
    assert rendered_ids

    restarted = _full_service(factory, artifacts)
    assert restarted.recover_interrupted_runs() == 0
    with factory() as uow:
        assert uow.resume_runs.get(run.id).stage is ResumeStage.FAILED


@pytest.mark.parametrize("mutation", ["job", "answer", "gate"])
@pytest.mark.asyncio
async def test_resume_finalization_rejects_inputs_changed_during_render(
    mutation: str,
) -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    renderer = _BlockingRenderer()
    service = _full_service(factory, artifacts, renderer=renderer)
    profile, case, reviewed = await _reviewed_case(service)
    assert reviewed.review is not None
    assert reviewed.review.questions
    with factory() as uow:
        job = uow.jobs.get(case.job_id)
        assert job is not None
        artifacts_before = dict(uow.artifacts.state.artifacts)

    generation = asyncio.create_task(
        service.decide_and_tailor(
            profile.id,
            case.job_id,
            Decision.TAILOR,
        )
    )
    await renderer.started.wait()
    if mutation == "job":
        service.update_job_details(
            profile.id,
            case.job_id,
            JobDetails(title="Changed during render"),
            expected_revision=job.revision,
        )
    elif mutation == "answer":
        question = reviewed.review.questions[0]
        service.answer_verification(
            profile.id,
            case.job_id,
            question.id,
            question.qualifying_answer,
        )
    else:
        service.decide_job(
            profile.id,
            case.job_id,
            Decision.SKIP,
        )
    renderer.release.set()
    with pytest.raises(RevisionConflictError, match="inputs changed"):
        await generation

    with factory() as uow:
        run = uow.resume_runs.get_latest(case.id)
        assert run is not None
        assert run.stage is ResumeStage.FAILED
        assert run.artifact is None
        assert run.selection_artifact is None
        assert run.render_receipt_artifact is None
        assert run.agent_run_id is not None
        agent_run = uow.agent_runs.get(run.agent_run_id)
        assert agent_run is not None
        assert agent_run.status is AgentRunStatus.SUCCEEDED
        assert uow.artifacts.state.artifacts == artifacts_before


@pytest.mark.asyncio
async def test_approval_and_submission_verify_managed_pdf_bytes() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    service = _full_service(factory, artifacts)
    profile, case, _ = await _reviewed_case(service)
    decision = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
    )
    run = decision.resume_run
    assert run is not None and run.artifact is not None
    original = artifacts._data[run.artifact.id]
    artifacts._data[run.artifact.id] = b"%PDF-tampered"

    with pytest.raises(ArtifactError):
        await service.approve_resume(profile.id, case.job_id, run.id)
    assert service.get_resume_review_history(profile.id, case.job_id) == ()

    artifacts._data[run.artifact.id] = original
    await service.approve_resume(profile.id, case.job_id, run.id)
    artifacts._data[run.artifact.id] = b"%PDF-tampered-after-approval"
    with pytest.raises(ArtifactError):
        await service.submit_application(
            profile.id,
            case.job_id,
            SubmitApplicationDraft(
                submitted_at=datetime(2026, 1, 5, tzinfo=UTC),
                follow_up_at=datetime(2026, 1, 10, tzinfo=UTC),
            ),
        )
    assert service.get_application(profile.id, case.job_id) is None


@pytest.mark.asyncio
async def test_post_submission_screen_refresh_never_projects_system_skip() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    service = _full_service(factory, artifacts)
    profile, case, _ = await _reviewed_case(service)
    result = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
    )
    run = result.resume_run
    assert run is not None
    await service.approve_resume(profile.id, case.job_id, run.id)
    submitted = await service.submit_application(
        profile.id,
        case.job_id,
        SubmitApplicationDraft(
            follow_up_at=datetime(2030, 1, 15, tzinfo=UTC),
        ),
    )
    with factory() as uow:
        job = uow.jobs.get(case.job_id)
        assert job is not None

    service.update_job_details(
        profile.id,
        case.job_id,
        JobDetails(listing_closed=True),
        expected_revision=job.revision,
    )

    refreshed = service.get_job_case(profile.id, case.job_id)
    assert any(evaluation.result.value == "fail" for evaluation in refreshed.screen_evaluations)
    assert refreshed.case.decision is Decision.TAILOR
    persisted = service.get_application(profile.id, case.job_id)
    assert persisted is not None
    assert persisted.application.id == submitted.application.id


@pytest.mark.asyncio
async def test_scout_merges_duplicate_sources_and_job_correction_versions_inputs() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    service = _full_service(
        factory,
        artifacts,
        registry=_FullRegistry(scout=_DuplicateScout()),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    cases = await service.discover_jobs(profile.id)
    assert len(cases) == 1
    case = cases[0]
    with factory() as uow:
        first_version = uow.job_versions.get_current(case.job_id)
        assert first_version is not None
        assert len(tuple(uow.job_versions.list_sources(first_version.id))) == 2
        job = uow.jobs.get(case.job_id)
        assert job is not None

    corrected = service.update_job_details(
        profile.id,
        case.job_id,
        JobDetails(remote_arrangement="remote", salary_max=150_000),
        expected_revision=job.revision,
    )
    with factory() as uow:
        versions = tuple(uow.job_versions.list_for_job(case.job_id))
        current = uow.job_versions.get_current(case.job_id)
        profile_version = uow.profile_versions.get_current(profile.id)
        assert current is not None and profile_version is not None
        assert len(versions) == 2
        assert current.remote_arrangement == "remote"
        assert current.salary_max == 150_000
        assert len(tuple(uow.job_versions.list_sources(current.id))) == 2
        assert uow.screens.list_current(case.id, current.id, profile_version.id)
    assert corrected.current_version_id == current.id


def test_command_fingerprint_rejects_payload_reuse_and_recovery_covers_orphan_agent() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(factory, AdvancingClock(), SequentialIds())
    first = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        ),
        command_id="profile-command",
    )
    assert (
        service.create_profile(
            ProfileDraft(
                name="Primary",
                target_roles=("Platform Engineer",),
                agent_provider=AgentProvider.DEMO,
            ),
            command_id="profile-command",
        )
        == first
    )
    with pytest.raises(ValidationError, match="different target or payload"):
        service.create_profile(
            ProfileDraft(
                name="Different",
                target_roles=("Designer",),
                agent_provider=AgentProvider.DEMO,
            ),
            command_id="profile-command",
        )

    with factory() as uow:
        uow.agent_runs.add(
            AgentRun(
                id="orphan-agent",
                command_id="orphan-command",
                kind=AgentKind.SCOUT,
                provider=AgentProvider.DEMO,
                model="gpt-5.6-terra",
                prompt_version="v1",
                output_schema_version="v1",
                profile_id=first.id,
                job_case_id=None,
                input_fingerprint="0" * 64,
                status=AgentRunStatus.RUNNING,
                prompt_hash="1" * 64,
                output_schema_hash="2" * 64,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        uow.commit()
    assert service.recover_interrupted_runs() == 1
    with factory() as uow:
        recovered = uow.agent_runs.get("orphan-agent")
        assert recovered is not None
        assert recovered.status is AgentRunStatus.INTERRUPTED


def test_application_queries_are_scoped_to_the_profile_case() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(factory, AdvancingClock(), SequentialIds())
    first = service.create_profile(
        ProfileDraft(
            name="First",
            target_roles=("Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    second = service.create_profile(
        ProfileDraft(
            name="Second",
            target_roles=("Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    first_case = service.add_job_url(first.id, "https://jobs.example.test/shared")
    second_case = service.add_job_url(second.id, "https://jobs.example.test/shared")
    now = datetime(2026, 1, 1, tzinfo=UTC)
    application = TrackedApplication(
        id="first-application",
        command_id="submission",
        job_id=first_case.job_id,
        job_case_id=first_case.id,
        current_stage=ApplicationStage.SUBMITTED,
        approved_resume_review_event_id=None,
        resume_run_id=None,
        pdf_artifact_id=None,
        pdf_checksum=None,
        job_version_id=None,
        profile_version_id=None,
        evidence_version_id=None,
        review_version_id=None,
        gate_decision_event_id=None,
        submitted_at=now,
        legacy=True,
        created_at=now,
        updated_at=now,
    )
    with factory() as uow:
        uow.tracked_applications.add(application)
        uow.commit()

    assert service.get_application(second.id, second_case.job_id) is None
    with pytest.raises(InvalidTransitionError):
        service.record_application_stage(
            second.id,
            second_case.job_id,
            ApplicationStageDraft(
                ApplicationStage.ACKNOWLEDGED,
                no_follow_up=True,
            ),
        )


@pytest.mark.asyncio
async def test_review_command_replay_does_not_sync_a_new_source_revision() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    synchronizer = _Synchronizer()
    service = _full_service(factory, artifacts, synchronizer=synchronizer)
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository="https://example.test/master-resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            trust_repository=True,
        ),
    )
    (case,) = await service.discover_jobs(profile.id)

    first = await service.review_job(
        profile.id,
        case.job_id,
        command_id="review-command",
    )
    replay = await service.review_job(
        profile.id,
        case.job_id,
        command_id="review-command",
    )

    assert replay.review == first.review
    assert synchronizer.calls == 1
    with pytest.raises(ValidationError, match="different target or payload"):
        await service.review_job(
            profile.id,
            case.job_id,
            rerun=True,
            command_id="review-command",
        )
    assert synchronizer.calls == 1


@pytest.mark.asyncio
async def test_failed_scout_command_is_closed_and_requires_a_new_command_id() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    service = _full_service(
        factory,
        artifacts,
        registry=_FullRegistry(scout=_FailingScout()),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )

    with pytest.raises(RuntimeError, match="transport failed"):
        await service.discover_jobs(profile.id, command_id="failed-scout")
    with pytest.raises(InvalidTransitionError, match="new command ID"):
        await service.discover_jobs(profile.id, command_id="failed-scout")

    scout_runs = [run for run in factory.state.agent_runs.values() if run.kind is AgentKind.SCOUT]
    assert len(scout_runs) == 1
    assert scout_runs[0].status is AgentRunStatus.FAILED


@pytest.mark.asyncio
async def test_changed_question_semantics_require_a_new_human_answer() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    reviewer = _ChangingQuestionReviewer()
    service = _full_service(
        factory,
        artifacts,
        registry=_FullRegistry(reviewer=reviewer),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    service.configure_resume_source(
        profile.id,
        ResumeSourceDraft(
            repository="https://example.test/master-resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            trust_repository=True,
        ),
    )
    (case,) = await service.discover_jobs(profile.id)
    first = await service.review_job(profile.id, case.job_id)
    assert first.review is not None
    service.answer_verification(
        profile.id,
        case.job_id,
        "experience.production",
        Answer.YES,
    )

    rerun = await service.review_job(profile.id, case.job_id, rerun=True)

    assert rerun.review is not None
    changed = next(
        question for question in rerun.review.questions if question.id == "experience.production"
    )
    assert changed.prompt == "Do you have production Rust experience?"
    assert rerun.answers == {}
    assert rerun.eligibility_status is EligibilityStatus.UNRESOLVED
    with pytest.raises(InvalidTransitionError, match="required questions"):
        await service.decide_and_tailor(profile.id, case.job_id, Decision.TAILOR)


@pytest.mark.asyncio
async def test_bad_reviewer_requirements_and_stale_inputs_close_agent_runs() -> None:
    bad_factory = MemoryUnitOfWorkFactory()
    bad_artifacts = _ArtifactStore()
    bad_service = _full_service(
        bad_factory,
        bad_artifacts,
        registry=_FullRegistry(reviewer=_BadRequirementReviewer()),
    )
    bad_profile = bad_service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    bad_service.configure_resume_source(
        bad_profile.id,
        ResumeSourceDraft(
            repository="https://example.test/master-resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            trust_repository=True,
        ),
    )
    (bad_case,) = await bad_service.discover_jobs(bad_profile.id)

    with pytest.raises(ProviderFailureError, match="must be unique"):
        await bad_service.review_job(bad_profile.id, bad_case.job_id)
    reviewer_runs = [
        run for run in bad_factory.state.agent_runs.values() if run.kind is AgentKind.REVIEWER
    ]
    assert len(reviewer_runs) == 1
    assert reviewer_runs[0].status is AgentRunStatus.FAILED

    stale_factory = MemoryUnitOfWorkFactory()
    stale_artifacts = _ArtifactStore()
    mutating = _MutatingReviewer()
    stale_service = _full_service(
        stale_factory,
        stale_artifacts,
        registry=_FullRegistry(reviewer=mutating),
    )
    stale_profile = stale_service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    stale_service.configure_resume_source(
        stale_profile.id,
        ResumeSourceDraft(
            repository="https://example.test/master-resume.git",
            kind=ResumeSourceKind.REMOTE_GIT,
            trust_repository=True,
        ),
    )
    (stale_case,) = await stale_service.discover_jobs(stale_profile.id)
    with stale_factory() as uow:
        stale_job = uow.jobs.get(stale_case.job_id)
        assert stale_job is not None
    mutating.mutate = lambda: stale_service.update_job_details(
        stale_profile.id,
        stale_case.job_id,
        JobDetails(title="Corrected title"),
        expected_revision=stale_job.revision,
    )

    with pytest.raises(RevisionConflictError, match="inputs changed"):
        await stale_service.review_job(stale_profile.id, stale_case.job_id)
    stale_reviewer_runs = [
        run for run in stale_factory.state.agent_runs.values() if run.kind is AgentKind.REVIEWER
    ]
    assert len(stale_reviewer_runs) == 1
    assert stale_reviewer_runs[0].status is AgentRunStatus.FAILED


@pytest.mark.asyncio
async def test_rejected_resume_is_terminal_for_review_and_revision() -> None:
    factory = MemoryUnitOfWorkFactory()
    artifacts = _ArtifactStore()
    service = _full_service(factory, artifacts)
    profile, case, _ = await _reviewed_case(service)
    result = await service.decide_and_tailor(
        profile.id,
        case.job_id,
        Decision.TAILOR,
    )
    run = result.resume_run
    assert run is not None
    rejected = service.reject_resume(profile.id, case.job_id, run.id)
    assert rejected.decision is ResumeReviewDecision.REJECTED

    with pytest.raises(InvalidTransitionError, match="closed"):
        await service.approve_resume(profile.id, case.job_id, run.id)
    with pytest.raises(InvalidTransitionError, match="closed"):
        await service.revise_resume(
            profile.id,
            case.job_id,
            "Try a different emphasis.",
        )

    approved_factory = MemoryUnitOfWorkFactory()
    approved_artifacts = _ArtifactStore()
    approved_service = _full_service(approved_factory, approved_artifacts)
    approved_profile, approved_case, _ = await _reviewed_case(approved_service)
    approved_result = await approved_service.decide_and_tailor(
        approved_profile.id,
        approved_case.job_id,
        Decision.TAILOR,
    )
    approved_run = approved_result.resume_run
    assert approved_run is not None
    approved = await approved_service.approve_resume(
        approved_profile.id,
        approved_case.job_id,
        approved_run.id,
        command_id="approve-terminal",
    )
    assert approved.decision is ResumeReviewDecision.APPROVED
    assert (
        await approved_service.approve_resume(
            approved_profile.id,
            approved_case.job_id,
            approved_run.id,
            command_id="approve-terminal",
        )
        == approved
    )
    with pytest.raises(InvalidTransitionError, match="closed"):
        approved_service.reject_resume(
            approved_profile.id,
            approved_case.job_id,
            approved_run.id,
        )
    with pytest.raises(InvalidTransitionError, match="closed"):
        await approved_service.revise_resume(
            approved_profile.id,
            approved_case.job_id,
            "Try a different emphasis.",
        )


def test_profile_agent_models_are_configurable_but_reasoning_is_runtime_safe() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(factory, AdvancingClock(), SequentialIds())
    configurations = tuple(
        AgentConfiguration(
            kind=kind,
            provider=AgentProvider.DEMO,
            model=f"custom-{kind.value}-model",
            reasoning_effort="xhigh",
        )
        for kind in AgentKind
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
            agent_configurations=configurations,
        )
    )
    with factory() as uow:
        version = uow.profile_versions.get_current(profile.id)
        assert version is not None
        assert version.agent_configurations == configurations

    invalid = tuple(
        AgentConfiguration(
            kind=kind,
            provider=AgentProvider.DEMO,
            model="gpt-5.6-terra",
            reasoning_effort="max",
        )
        for kind in AgentKind
    )
    with pytest.raises(ValidationError, match="reasoning effort"):
        service.create_profile(
            ProfileDraft(
                name="Invalid",
                target_roles=("Platform Engineer",),
                agent_provider=AgentProvider.DEMO,
                agent_configurations=invalid,
            )
        )


def test_authoritative_mode_rejects_legacy_application_bypasses() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=_FullRegistry(),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    case = service.add_job_url(profile.id, "https://jobs.example.test/bypass")

    with pytest.raises(InvalidTransitionError, match="submit_application"):
        service.mark_applied(profile.id, case.job_id)
    with pytest.raises(InvalidTransitionError, match="record_application_stage"):
        service.record_outcome(profile.id, case.job_id, Outcome.REJECTED)


def test_legacy_manifest_counts_must_bind_to_detailed_rows() -> None:
    service = RoleLoopService(
        MemoryUnitOfWorkFactory(),
        AdvancingClock(),
        SequentialIds(),
    )
    draft = LegacyImportDraft(
        source_checksum="",
        jobs=(),
        source_job_count=1,
        source_event_count=0,
        sources=(
            LegacySourceManifest("state.sqlite3", "1" * 64, 100, 1, 0),
            LegacySourceManifest("state-v2.sqlite3", "2" * 64, 100, 0, 0),
        ),
    )

    with pytest.raises(ValidationError, match="detailed job rows"):
        service.preview_legacy_import(draft)


def test_legacy_import_receipts_bind_commands_even_when_checksum_exists() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(factory, AdvancingClock(), SequentialIds())
    profile = service.create_profile(
        ProfileDraft(
            name="Legacy history",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    sources = (
        LegacySourceManifest("state.sqlite3", "1" * 64, 100, 0, 0),
        LegacySourceManifest("state-v2.sqlite3", "2" * 64, 100, 0, 0),
    )
    draft = LegacyImportDraft(
        source_checksum="",
        jobs=(),
        source_job_count=0,
        source_event_count=0,
        sources=sources,
    )

    first = service.apply_legacy_import(profile.id, draft, command_id="legacy-command-a")
    second = service.apply_legacy_import(profile.id, draft, command_id="legacy-command-b")

    assert second == first
    with factory() as uow:
        receipt = uow.commands.get("legacy-command-b")
        assert receipt is not None
        assert receipt.result_id == first.id

    changed_request = LegacyImportDraft(
        source_checksum="",
        jobs=(),
        source_job_count=0,
        source_event_count=0,
        duplicate_urls=("https://jobs.example.test/already-seen",),
        sources=sources,
    )
    with pytest.raises(ValidationError, match="different target or payload"):
        service.apply_legacy_import(
            profile.id,
            changed_request,
            command_id="legacy-command-a",
        )


def test_legacy_duplicate_appends_history_without_replacing_native_job_or_decision() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=_FullRegistry(),
    )
    profile = service.create_profile(
        ProfileDraft(
            name="Primary",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    case = service.add_job_url(profile.id, "https://jobs.example.test/native-role")
    with factory() as uow:
        initial_job = uow.jobs.get(case.job_id)
        assert initial_job is not None
    native_job = service.update_job_details(
        profile.id,
        case.job_id,
        JobDetails(
            title="Native Platform Engineer",
            company="Native Co",
            description="Authoritative native listing",
            source="company",
            external_requisition_id="REQ-42",
        ),
        expected_revision=initial_job.revision,
    )
    native_case = service.decide_job(
        profile.id,
        case.job_id,
        Decision.SKIP,
        command_id="native-skip",
    )
    with factory() as uow:
        native_version = uow.job_versions.get_current(native_job.id)
        native_versions = tuple(uow.job_versions.list_for_job(native_job.id))
        native_decision = uow.decision_events.get(native_case.current_decision_event_id or "")
        assert native_version is not None
        assert native_decision is not None

    occurred_at = datetime(2025, 1, 2, tzinfo=UTC)
    legacy_key = "state.sqlite3:legacy-42"
    draft = LegacyImportDraft(
        source_checksum="",
        jobs=(
            LegacyJobDraft(
                legacy_key=legacy_key,
                url="https://jobs.example.test/native-role?utm_source=prototype",
                details=JobDetails(
                    title="Legacy title must not win",
                    company="Native Co",
                    description="Legacy description must remain historical",
                    source="legacy:state.sqlite3",
                    external_requisition_id="REQ-42",
                ),
                decision=Decision.TAILOR,
                event_at=occurred_at,
            ),
        ),
        source_job_count=1,
        source_event_count=1,
        sources=(
            LegacySourceManifest("state.sqlite3", "1" * 64, 100, 1, 1),
            LegacySourceManifest("state-v2.sqlite3", "2" * 64, 100, 0, 0),
        ),
        events=(
            LegacyEventDraft(
                source_key="state.sqlite3:event:1",
                job_key=legacy_key,
                occurred_at=occurred_at,
                node="reviewer",
                event_type="job_assessed",
                detail='{"legacy":true}',
            ),
        ),
    )

    batch = service.apply_legacy_import(profile.id, draft, command_id="legacy-import")

    with factory() as uow:
        assert uow.jobs.get(native_job.id) == native_job
        assert uow.job_versions.get_current(native_job.id) == native_version
        assert tuple(uow.job_versions.list_for_job(native_job.id)) == native_versions
        assert uow.cases.get(native_case.id) == native_case
        assert uow.decision_events.get(native_case.current_decision_event_id or "") == (
            native_decision
        )
        decisions = tuple(uow.decision_events.list_for_case(native_case.id))
        legacy_decision = next(
            item for item in decisions if item.reason is DecisionReason.LEGACY_UNPINNED
        )
        assert legacy_decision.decision is Decision.TAILOR
        assert legacy_decision.supersedes_decision_event_id is None
        history = tuple(uow.events.list_for_case(native_case.id))
        snapshot = next(item for item in history if item.event_type == "legacy.job_snapshot")
        assert snapshot.metadata["job_projection_applied"] is False
        assert snapshot.metadata["case_projection_applied"] is False
        assert "Legacy title must not win" in snapshot.metadata["snapshot_json"]
        assert any(item.event_type == "legacy.job_assessed" for item in history)
        items = tuple(uow.legacy_imports.list_items(batch.id))
        assert {item.entity_type for item in items} >= {
            "job",
            "job_case",
            "decision",
            "workflow_event",
        }


def test_legacy_import_can_create_a_projected_case_for_an_existing_native_job() -> None:
    factory = MemoryUnitOfWorkFactory()
    service = RoleLoopService(
        factory,
        AdvancingClock(),
        SequentialIds(),
        agent_registry=_FullRegistry(),
    )
    native_profile = service.create_profile(
        ProfileDraft(
            name="Native",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    import_profile = service.create_profile(
        ProfileDraft(
            name="Legacy history",
            target_roles=("Platform Engineer",),
            agent_provider=AgentProvider.DEMO,
        )
    )
    native_case = service.add_job_url(
        native_profile.id,
        "https://company.example.test/jobs/native-role",
    )
    with factory() as uow:
        initial_job = uow.jobs.get(native_case.job_id)
        assert initial_job is not None
    native_job = service.update_job_details(
        native_profile.id,
        native_case.job_id,
        JobDetails(
            title="Native title",
            company="Example",
            source="company",
            external_requisition_id="REQ-99",
        ),
        expected_revision=initial_job.revision,
    )
    with factory() as uow:
        native_version = uow.job_versions.get_current(native_job.id)
        native_versions = tuple(uow.job_versions.list_for_job(native_job.id))
        assert native_version is not None

    draft = LegacyImportDraft(
        source_checksum="",
        jobs=(
            LegacyJobDraft(
                legacy_key="state-v2.sqlite3:legacy-99",
                url="https://ats.example.test/openings/legacy-99",
                details=JobDetails(
                    title="Legacy title",
                    company="Example",
                    source="legacy:state-v2.sqlite3",
                    external_requisition_id="req-99",
                ),
                decision=Decision.WATCH,
                event_at=datetime(2025, 2, 3, tzinfo=UTC),
            ),
        ),
        source_job_count=1,
        source_event_count=0,
        sources=(
            LegacySourceManifest("state.sqlite3", "3" * 64, 100, 0, 0),
            LegacySourceManifest("state-v2.sqlite3", "4" * 64, 100, 1, 0),
        ),
    )

    service.apply_legacy_import(import_profile.id, draft)

    with factory() as uow:
        assert uow.jobs.get(native_job.id) == native_job
        assert uow.job_versions.get_current(native_job.id) == native_version
        assert tuple(uow.job_versions.list_for_job(native_job.id)) == native_versions
        assert uow.cases.get(native_case.id) == native_case
        imported_case = uow.cases.get_for_profile_job(import_profile.id, native_job.id)
        assert imported_case is not None
        assert imported_case.decision is Decision.WATCH
        imported_decision = uow.decision_events.get(imported_case.current_decision_event_id or "")
        assert imported_decision is not None
        assert imported_decision.reason is DecisionReason.LEGACY_UNPINNED
        snapshot = next(
            item
            for item in uow.events.list_for_case(imported_case.id)
            if item.event_type == "legacy.job_snapshot"
        )
        assert snapshot.metadata["job_projection_applied"] is False
        assert snapshot.metadata["case_projection_applied"] is True
