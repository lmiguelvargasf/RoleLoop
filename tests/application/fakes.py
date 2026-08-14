from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta

from roleloop.domain import (
    AgentRun,
    AgentRunStatus,
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
    VerificationAnswer,
    VerificationAnswerEvent,
    WebSourceSnapshot,
    WorkflowEvent,
)


@dataclass
class MemoryState:
    profiles: dict[str, SearchProfile] = field(default_factory=dict)
    evidence: dict[str, ResumeEvidenceVersion] = field(default_factory=dict)
    resume_sources: dict[str, ResumeSource] = field(default_factory=dict)
    jobs: dict[str, Job] = field(default_factory=dict)
    job_identity_keys: dict[str, JobIdentityKey] = field(default_factory=dict)
    cases: dict[str, JobCase] = field(default_factory=dict)
    reviews: dict[str, ReviewVersion] = field(default_factory=dict)
    answers: dict[tuple[str, str], VerificationAnswer] = field(default_factory=dict)
    runs: dict[str, ResumeRun] = field(default_factory=dict)
    submissions: dict[str, ApplicationSubmission] = field(default_factory=dict)
    outcomes: list[OutcomeEvent] = field(default_factory=list)
    events: list[WorkflowEvent] = field(default_factory=list)
    artifacts: dict[str, ArtifactRef] = field(default_factory=dict)
    commands: dict[str, CommandReceipt] = field(default_factory=dict)
    profile_versions: dict[str, SearchProfileVersion] = field(default_factory=dict)
    profile_rules: dict[str, tuple[HardBlockerRule, ...]] = field(default_factory=dict)
    job_versions: dict[str, JobVersion] = field(default_factory=dict)
    job_sources: dict[str, tuple[WebSourceSnapshot, ...]] = field(default_factory=dict)
    agent_runs: dict[str, AgentRun] = field(default_factory=dict)
    scout_runs: dict[str, ScoutRun] = field(default_factory=dict)
    scout_candidates: dict[str, tuple[ScoutCandidate, ...]] = field(default_factory=dict)
    screens: list[ScreenEvaluation] = field(default_factory=list)
    answer_events: dict[str, VerificationAnswerEvent] = field(default_factory=dict)
    decision_events: dict[str, CaseDecisionEvent] = field(default_factory=dict)
    resume_reviews: dict[str, ResumeReviewEvent] = field(default_factory=dict)
    tracked_applications: dict[str, TrackedApplication] = field(default_factory=dict)
    application_stages: list[ApplicationStageEvent] = field(default_factory=list)
    follow_ups: dict[str, ApplicationFollowUp] = field(default_factory=dict)
    follow_up_resolutions: dict[str, FollowUpResolution] = field(default_factory=dict)
    legacy_imports: dict[str, LegacyImportBatch] = field(default_factory=dict)
    legacy_import_items: list[LegacyImportItem] = field(default_factory=list)


class ProfilesRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, profile: SearchProfile) -> None:
        self.state.profiles[profile.id] = profile

    def get(self, profile_id: str) -> SearchProfile | None:
        return self.state.profiles.get(profile_id)

    def get_active(self) -> SearchProfile | None:
        return next(
            (profile for profile in self.state.profiles.values() if profile.is_active),
            None,
        )

    def list(self) -> tuple[SearchProfile, ...]:
        return tuple(self.state.profiles.values())

    def update(self, profile: SearchProfile, *, expected_revision: int) -> bool:
        current = self.get(profile.id)
        if current is None or current.revision != expected_revision:
            return False
        self.state.profiles[profile.id] = profile
        return True

    def set_active(self, profile_id: str, *, at: datetime) -> bool:
        if profile_id not in self.state.profiles:
            return False
        self.state.profiles = {
            key: replace(value, is_active=key == profile_id, updated_at=at)
            for key, value in self.state.profiles.items()
        }
        return True


class EvidenceRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, evidence: ResumeEvidenceVersion) -> None:
        self.state.evidence[evidence.id] = evidence

    def get(self, evidence_id: str) -> ResumeEvidenceVersion | None:
        return self.state.evidence.get(evidence_id)

    def list_for_profile(self, profile_id: str) -> tuple[ResumeEvidenceVersion, ...]:
        return tuple(item for item in self.state.evidence.values() if item.profile_id == profile_id)


class ResumeSourcesRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, source: ResumeSource) -> None:
        self.state.resume_sources[source.id] = source

    def get(self, source_id: str) -> ResumeSource | None:
        return self.state.resume_sources.get(source_id)

    def get_for_profile(self, profile_id: str) -> ResumeSource | None:
        return next(
            (
                source
                for source in self.state.resume_sources.values()
                if source.profile_id == profile_id
            ),
            None,
        )

    def update(self, source: ResumeSource, *, expected_revision: int) -> bool:
        current = self.get(source.id)
        if current is None or current.revision != expected_revision:
            return False
        self.state.resume_sources[source.id] = source
        return True


class JobsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, job: Job) -> None:
        self.state.jobs[job.id] = job

    def get(self, job_id: str) -> Job | None:
        return self.state.jobs.get(job_id)

    def get_by_canonical_url(self, canonical_url: str) -> Job | None:
        return next(
            (job for job in self.state.jobs.values() if job.canonical_url == canonical_url),
            None,
        )

    def get_by_identity_key(self, key: str) -> Job | None:
        identity = self.state.job_identity_keys.get(key)
        return None if identity is None else self.get(identity.job_id)

    def add_identity_key(self, identity: JobIdentityKey) -> bool:
        existing = self.state.job_identity_keys.get(identity.key)
        if existing is not None:
            return existing.job_id == identity.job_id
        self.state.job_identity_keys[identity.key] = identity
        return True

    def list_identity_keys(self, job_id: str) -> tuple[JobIdentityKey, ...]:
        return tuple(
            item for item in self.state.job_identity_keys.values() if item.job_id == job_id
        )

    def update(self, job: Job, *, expected_revision: int) -> bool:
        current = self.get(job.id)
        if current is None or current.revision != expected_revision:
            return False
        self.state.jobs[job.id] = job
        return True


class CasesRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, case: JobCase) -> None:
        self.state.cases[case.id] = case

    def get(self, case_id: str) -> JobCase | None:
        return self.state.cases.get(case_id)

    def get_for_profile_job(self, profile_id: str, job_id: str) -> JobCase | None:
        return next(
            (
                case
                for case in self.state.cases.values()
                if case.profile_id == profile_id and case.job_id == job_id
            ),
            None,
        )

    def list_for_profile(self, profile_id: str) -> tuple[JobCase, ...]:
        return tuple(case for case in self.state.cases.values() if case.profile_id == profile_id)

    def update(self, case: JobCase, *, expected_revision: int) -> bool:
        current = self.get(case.id)
        if current is None or current.revision != expected_revision:
            return False
        self.state.cases[case.id] = case
        return True


class ReviewsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, review: ReviewVersion) -> None:
        self.state.reviews[review.id] = review

    def get(self, review_id: str) -> ReviewVersion | None:
        return self.state.reviews.get(review_id)

    def get_latest(self, case_id: str) -> ReviewVersion | None:
        return next(
            reversed(
                [review for review in self.state.reviews.values() if review.job_case_id == case_id]
            ),
            None,
        )

    def list_for_case(self, case_id: str) -> tuple[ReviewVersion, ...]:
        return tuple(
            review for review in self.state.reviews.values() if review.job_case_id == case_id
        )

    def upsert_answer(self, answer: VerificationAnswer) -> None:
        self.state.answers[(answer.review_version_id, answer.question_id)] = answer

    def list_answers(self, review_id: str) -> tuple[VerificationAnswer, ...]:
        return tuple(
            answer
            for (stored_review_id, _), answer in self.state.answers.items()
            if stored_review_id == review_id
        )


class RunsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, run: ResumeRun) -> None:
        self.state.runs[run.id] = run

    def get(self, run_id: str) -> ResumeRun | None:
        return self.state.runs.get(run_id)

    def get_latest(self, case_id: str) -> ResumeRun | None:
        return next(
            reversed([run for run in self.state.runs.values() if run.job_case_id == case_id]),
            None,
        )

    def list_for_case(self, case_id: str) -> tuple[ResumeRun, ...]:
        return tuple(run for run in self.state.runs.values() if run.job_case_id == case_id)

    def list_in_progress(self) -> tuple[ResumeRun, ...]:
        return tuple(run for run in self.state.runs.values() if run.stage.is_in_progress)

    def update(self, run: ResumeRun) -> None:
        if run.id not in self.state.runs:
            raise KeyError(run.id)
        self.state.runs[run.id] = run


class ApplicationsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add_submission(self, submission: ApplicationSubmission) -> None:
        self.state.submissions[submission.job_case_id] = submission

    def get_submission(self, case_id: str) -> ApplicationSubmission | None:
        return self.state.submissions.get(case_id)

    def add_outcome(self, outcome: OutcomeEvent) -> None:
        self.state.outcomes.append(outcome)

    def list_outcomes(self, case_id: str) -> tuple[OutcomeEvent, ...]:
        return tuple(item for item in self.state.outcomes if item.job_case_id == case_id)


class EventsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, event: WorkflowEvent) -> None:
        self.state.events.append(event)

    def list_for_case(self, case_id: str) -> tuple[WorkflowEvent, ...]:
        return tuple(event for event in self.state.events if event.job_case_id == case_id)


class ArtifactsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, artifact: ArtifactRef) -> None:
        existing = self.state.artifacts.get(artifact.id)
        if existing is not None and existing != artifact:
            raise ValueError(
                f"artifact ID {artifact.id!r} was reused with different immutable metadata"
            )
        self.state.artifacts.setdefault(artifact.id, artifact)

    def get(self, artifact_id: str) -> ArtifactRef | None:
        return self.state.artifacts.get(artifact_id)


class CommandsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, receipt: CommandReceipt) -> None:
        if receipt.command_id in self.state.commands:
            raise ValueError(f"duplicate command: {receipt.command_id}")
        self.state.commands[receipt.command_id] = receipt

    def get(self, command_id: str) -> CommandReceipt | None:
        return self.state.commands.get(command_id)


class ProfileVersionsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(
        self,
        version: SearchProfileVersion,
        rules: tuple[HardBlockerRule, ...] = (),
    ) -> None:
        self.state.profile_versions[version.id] = version
        self.state.profile_rules[version.id] = tuple(rules)
        profile = self.state.profiles[version.profile_id]
        self.state.profiles[version.profile_id] = replace(profile, current_version_id=version.id)

    def get(self, version_id: str) -> SearchProfileVersion | None:
        return self.state.profile_versions.get(version_id)

    def get_current(self, profile_id: str) -> SearchProfileVersion | None:
        profile = self.state.profiles.get(profile_id)
        if profile is None or profile.current_version_id is None:
            return None
        return self.get(profile.current_version_id)

    def list_for_profile(self, profile_id: str) -> tuple[SearchProfileVersion, ...]:
        return tuple(
            version
            for version in self.state.profile_versions.values()
            if version.profile_id == profile_id
        )

    def list_rules(self, version_id: str) -> tuple[HardBlockerRule, ...]:
        return self.state.profile_rules.get(version_id, ())


class JobVersionsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(
        self,
        version: JobVersion,
        sources: tuple[WebSourceSnapshot, ...] = (),
    ) -> None:
        self.state.job_versions[version.id] = version
        self.state.job_sources[version.id] = tuple(sources)
        job = self.state.jobs[version.job_id]
        self.state.jobs[version.job_id] = replace(job, current_version_id=version.id)

    def get(self, version_id: str) -> JobVersion | None:
        return self.state.job_versions.get(version_id)

    def get_current(self, job_id: str) -> JobVersion | None:
        job = self.state.jobs.get(job_id)
        if job is None or job.current_version_id is None:
            return None
        return self.get(job.current_version_id)

    def get_by_fingerprint(self, job_id: str, fingerprint: str) -> JobVersion | None:
        return next(
            (
                version
                for version in self.state.job_versions.values()
                if version.job_id == job_id and version.content_fingerprint == fingerprint
            ),
            None,
        )

    def list_for_job(self, job_id: str) -> tuple[JobVersion, ...]:
        return tuple(
            version for version in self.state.job_versions.values() if version.job_id == job_id
        )

    def list_sources(self, version_id: str) -> tuple[WebSourceSnapshot, ...]:
        return self.state.job_sources.get(version_id, ())


class AgentRunsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, run: AgentRun) -> None:
        self.state.agent_runs[run.id] = run

    def get(self, run_id: str) -> AgentRun | None:
        return self.state.agent_runs.get(run_id)

    def get_by_command_id(self, command_id: str) -> AgentRun | None:
        return next(
            (run for run in self.state.agent_runs.values() if run.command_id == command_id),
            None,
        )

    def update(self, run: AgentRun) -> None:
        if run.id not in self.state.agent_runs:
            raise KeyError(run.id)
        self.state.agent_runs[run.id] = run

    def list_for_case(self, case_id: str) -> tuple[AgentRun, ...]:
        return tuple(run for run in self.state.agent_runs.values() if run.job_case_id == case_id)

    def list_in_progress(self) -> tuple[AgentRun, ...]:
        return tuple(
            run
            for run in self.state.agent_runs.values()
            if run.status in {AgentRunStatus.QUEUED, AgentRunStatus.RUNNING}
        )

    def add_scout_run(self, run: ScoutRun, candidates: tuple[ScoutCandidate, ...]) -> None:
        self.state.scout_runs[run.id] = run
        self.state.scout_candidates[run.id] = tuple(candidates)

    def get_scout_run(self, scout_run_id: str) -> ScoutRun | None:
        return self.state.scout_runs.get(scout_run_id)

    def list_scout_candidates(self, scout_run_id: str) -> tuple[ScoutCandidate, ...]:
        return self.state.scout_candidates.get(scout_run_id, ())


class ScreensRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add_all(self, evaluations: tuple[ScreenEvaluation, ...]) -> None:
        self.state.screens.extend(evaluations)

    def list_current(
        self,
        case_id: str,
        job_version_id: str,
        profile_version_id: str,
    ) -> tuple[ScreenEvaluation, ...]:
        return tuple(
            item
            for item in self.state.screens
            if item.job_case_id == case_id
            and item.job_version_id == job_version_id
            and item.profile_version_id == profile_version_id
        )


class AnswerEventsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, event: VerificationAnswerEvent) -> None:
        self.state.answer_events[event.id] = event

    def get(self, event_id: str) -> VerificationAnswerEvent | None:
        return self.state.answer_events.get(event_id)

    def list_for_case(self, case_id: str) -> tuple[VerificationAnswerEvent, ...]:
        return tuple(
            item for item in self.state.answer_events.values() if item.job_case_id == case_id
        )


class DecisionEventsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, event: CaseDecisionEvent) -> None:
        self.state.decision_events[event.id] = event

    def get(self, event_id: str) -> CaseDecisionEvent | None:
        return self.state.decision_events.get(event_id)

    def list_for_case(self, case_id: str) -> tuple[CaseDecisionEvent, ...]:
        return tuple(
            item for item in self.state.decision_events.values() if item.job_case_id == case_id
        )


class ResumeReviewsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, event: ResumeReviewEvent) -> None:
        self.state.resume_reviews[event.id] = event

    def get(self, event_id: str) -> ResumeReviewEvent | None:
        return self.state.resume_reviews.get(event_id)

    def get_latest(self, resume_run_id: str) -> ResumeReviewEvent | None:
        return next(
            reversed(
                [
                    item
                    for item in self.state.resume_reviews.values()
                    if item.resume_run_id == resume_run_id
                ]
            ),
            None,
        )

    def list_for_run(self, resume_run_id: str) -> tuple[ResumeReviewEvent, ...]:
        return tuple(
            item
            for item in self.state.resume_reviews.values()
            if item.resume_run_id == resume_run_id
        )


class TrackedApplicationsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, application: TrackedApplication) -> None:
        self.state.tracked_applications[application.id] = application

    def get(self, application_id: str) -> TrackedApplication | None:
        return self.state.tracked_applications.get(application_id)

    def get_for_job(self, job_id: str) -> TrackedApplication | None:
        return next(
            (item for item in self.state.tracked_applications.values() if item.job_id == job_id),
            None,
        )

    def get_for_case(self, case_id: str) -> TrackedApplication | None:
        return next(
            (
                item
                for item in self.state.tracked_applications.values()
                if item.job_case_id == case_id
            ),
            None,
        )

    def update(self, application: TrackedApplication, *, expected_revision: int) -> bool:
        current = self.get(application.id)
        if current is None or current.revision != expected_revision:
            return False
        self.state.tracked_applications[application.id] = application
        return True

    def add_stage(self, event: ApplicationStageEvent) -> None:
        self.state.application_stages.append(event)

    def list_stages(self, application_id: str) -> tuple[ApplicationStageEvent, ...]:
        return tuple(
            item for item in self.state.application_stages if item.application_id == application_id
        )


class FollowUpsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, follow_up: ApplicationFollowUp) -> None:
        self.state.follow_ups[follow_up.id] = follow_up

    def get(self, follow_up_id: str) -> ApplicationFollowUp | None:
        return self.state.follow_ups.get(follow_up_id)

    def get_open_for_application(self, application_id: str) -> ApplicationFollowUp | None:
        resolved = {item.follow_up_id for item in self.state.follow_up_resolutions.values()}
        return next(
            reversed(
                [
                    item
                    for item in self.state.follow_ups.values()
                    if item.application_id == application_id and item.id not in resolved
                ]
            ),
            None,
        )

    def list_for_application(self, application_id: str) -> tuple[ApplicationFollowUp, ...]:
        return tuple(
            item for item in self.state.follow_ups.values() if item.application_id == application_id
        )

    def list_due(
        self, *, at: datetime, profile_id: str | None = None
    ) -> tuple[ApplicationFollowUp, ...]:
        resolved = {item.follow_up_id for item in self.state.follow_up_resolutions.values()}
        due: list[ApplicationFollowUp] = []
        for item in self.state.follow_ups.values():
            if item.id in resolved or item.due_at > at:
                continue
            if profile_id is not None:
                application = self.state.tracked_applications[item.application_id]
                case = self.state.cases[application.job_case_id]
                if case.profile_id != profile_id:
                    continue
            due.append(item)
        return tuple(sorted(due, key=lambda item: (item.due_at, item.id)))

    def add_resolution(self, resolution: FollowUpResolution) -> None:
        self.state.follow_up_resolutions[resolution.id] = resolution

    def list_resolutions(self, follow_up_id: str) -> tuple[FollowUpResolution, ...]:
        return tuple(
            item
            for item in self.state.follow_up_resolutions.values()
            if item.follow_up_id == follow_up_id
        )


class LegacyImportsRepo:
    def __init__(self, state: MemoryState) -> None:
        self.state = state

    def add(self, batch: LegacyImportBatch) -> None:
        self.state.legacy_imports[batch.id] = batch

    def add_item(self, item: LegacyImportItem) -> None:
        self.state.legacy_import_items.append(item)

    def list_items(self, batch_id: str) -> tuple[LegacyImportItem, ...]:
        return tuple(item for item in self.state.legacy_import_items if item.batch_id == batch_id)

    def list_sources(self, batch_id: str) -> tuple[LegacyImportSource, ...]:
        batch = self.state.legacy_imports.get(batch_id)
        return () if batch is None else batch.sources

    def get_by_checksum(self, profile_id: str, source_checksum: str) -> LegacyImportBatch | None:
        return next(
            (
                item
                for item in self.state.legacy_imports.values()
                if item.profile_id == profile_id and item.source_checksum == source_checksum
            ),
            None,
        )


class MemoryUnitOfWork:
    def __init__(self, factory: MemoryUnitOfWorkFactory) -> None:
        self.factory = factory
        self.state = deepcopy(factory.state)
        self.profiles = ProfilesRepo(self.state)
        self.evidence = EvidenceRepo(self.state)
        self.resume_sources = ResumeSourcesRepo(self.state)
        self.jobs = JobsRepo(self.state)
        self.cases = CasesRepo(self.state)
        self.reviews = ReviewsRepo(self.state)
        self.resume_runs = RunsRepo(self.state)
        self.applications = ApplicationsRepo(self.state)
        self.events = EventsRepo(self.state)
        self.artifacts = ArtifactsRepo(self.state)
        self.commands = CommandsRepo(self.state)
        self.profile_versions = ProfileVersionsRepo(self.state)
        self.job_versions = JobVersionsRepo(self.state)
        self.agent_runs = AgentRunsRepo(self.state)
        self.screens = ScreensRepo(self.state)
        self.answer_events = AnswerEventsRepo(self.state)
        self.decision_events = DecisionEventsRepo(self.state)
        self.resume_reviews = ResumeReviewsRepo(self.state)
        self.tracked_applications = TrackedApplicationsRepo(self.state)
        self.follow_ups = FollowUpsRepo(self.state)
        self.legacy_imports = LegacyImportsRepo(self.state)

    def __enter__(self) -> MemoryUnitOfWork:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback

    def commit(self) -> None:
        self.factory.state = self.state

    def rollback(self) -> None:
        pass


class MemoryUnitOfWorkFactory:
    def __init__(self) -> None:
        self.state = MemoryState()

    def __call__(self) -> MemoryUnitOfWork:
        return MemoryUnitOfWork(self)


class SequentialIds:
    def __init__(self) -> None:
        self.value = 0

    def new(self) -> str:
        self.value += 1
        return f"id-{self.value}"


class AdvancingClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 1, 1, tzinfo=UTC)

    def now(self) -> datetime:
        current = self.value
        self.value += timedelta(seconds=1)
        return current
