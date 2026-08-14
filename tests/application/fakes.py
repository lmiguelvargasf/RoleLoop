from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta

from roleloop.domain import (
    ApplicationSubmission,
    Job,
    JobCase,
    OutcomeEvent,
    ResumeEvidenceVersion,
    ResumeRun,
    ReviewVersion,
    SearchProfile,
    VerificationAnswer,
    WorkflowEvent,
)


@dataclass
class MemoryState:
    profiles: dict[str, SearchProfile] = field(default_factory=dict)
    evidence: dict[str, ResumeEvidenceVersion] = field(default_factory=dict)
    jobs: dict[str, Job] = field(default_factory=dict)
    cases: dict[str, JobCase] = field(default_factory=dict)
    reviews: dict[str, ReviewVersion] = field(default_factory=dict)
    answers: dict[tuple[str, str], VerificationAnswer] = field(default_factory=dict)
    runs: dict[str, ResumeRun] = field(default_factory=dict)
    submissions: dict[str, ApplicationSubmission] = field(default_factory=dict)
    outcomes: list[OutcomeEvent] = field(default_factory=list)
    events: list[WorkflowEvent] = field(default_factory=list)


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


class MemoryUnitOfWork:
    def __init__(self, factory: MemoryUnitOfWorkFactory) -> None:
        self.factory = factory
        self.state = deepcopy(factory.state)
        self.profiles = ProfilesRepo(self.state)
        self.evidence = EvidenceRepo(self.state)
        self.jobs = JobsRepo(self.state)
        self.cases = CasesRepo(self.state)
        self.reviews = ReviewsRepo(self.state)
        self.resume_runs = RunsRepo(self.state)
        self.applications = ApplicationsRepo(self.state)
        self.events = EventsRepo(self.state)

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
