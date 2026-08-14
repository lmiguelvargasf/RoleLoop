from __future__ import annotations

import sqlite3
from typing import Self

from roleloop.application.ports import (
    AgentRunsRepository,
    AnswerEventsRepository,
    ApplicationsRepository,
    ArtifactsRepository,
    CommandReceiptsRepository,
    DecisionEventsRepository,
    EventsRepository,
    EvidenceRepository,
    FollowUpsRepository,
    JobCasesRepository,
    JobsRepository,
    JobVersionsRepository,
    LegacyImportsRepository,
    ProfilesRepository,
    ProfileVersionsRepository,
    ResumeReviewsRepository,
    ResumeRunsRepository,
    ResumeSourcesRepository,
    ReviewsRepository,
    ScreenEvaluationsRepository,
    TrackedApplicationsRepository,
    UnitOfWork,
)

from .authoritative_repositories import (
    SQLiteAgentRunsRepository,
    SQLiteAnswerEventsRepository,
    SQLiteArtifactsRepository,
    SQLiteCommandReceiptsRepository,
    SQLiteDecisionEventsRepository,
    SQLiteFollowUpsRepository,
    SQLiteJobVersionsRepository,
    SQLiteLegacyImportsRepository,
    SQLiteProfileVersionsRepository,
    SQLiteResumeReviewsRepository,
    SQLiteScreenEvaluationsRepository,
    SQLiteTrackedApplicationsRepository,
)
from .database import SQLiteDatabase
from .repositories import (
    SQLiteApplicationsRepository,
    SQLiteEventsRepository,
    SQLiteEvidenceRepository,
    SQLiteJobCasesRepository,
    SQLiteJobsRepository,
    SQLiteProfilesRepository,
    SQLiteResumeRunsRepository,
    SQLiteResumeSourcesRepository,
    SQLiteReviewsRepository,
)


class SQLiteUnitOfWork:
    profiles: ProfilesRepository
    evidence: EvidenceRepository
    resume_sources: ResumeSourcesRepository
    jobs: JobsRepository
    cases: JobCasesRepository
    reviews: ReviewsRepository
    resume_runs: ResumeRunsRepository
    applications: ApplicationsRepository
    events: EventsRepository
    artifacts: ArtifactsRepository
    commands: CommandReceiptsRepository
    profile_versions: ProfileVersionsRepository
    job_versions: JobVersionsRepository
    agent_runs: AgentRunsRepository
    screens: ScreenEvaluationsRepository
    answer_events: AnswerEventsRepository
    decision_events: DecisionEventsRepository
    resume_reviews: ResumeReviewsRepository
    tracked_applications: TrackedApplicationsRepository
    follow_ups: FollowUpsRepository
    legacy_imports: LegacyImportsRepository

    def __init__(self, database: SQLiteDatabase) -> None:
        self._database = database
        self._connection: sqlite3.Connection | None = None

    def __enter__(self) -> Self:
        if self._connection is not None:
            raise RuntimeError("Unit of work is already active")
        connection = self._database.connect()
        # UoWs are short; reserving the writer slot here avoids WAL snapshot-upgrade
        # failures and makes cross-process optimistic checks deterministic.
        connection.execute("BEGIN IMMEDIATE")
        self._connection = connection
        self.profiles = SQLiteProfilesRepository(connection)
        self.evidence = SQLiteEvidenceRepository(connection)
        self.resume_sources = SQLiteResumeSourcesRepository(connection)
        self.jobs = SQLiteJobsRepository(connection)
        self.cases = SQLiteJobCasesRepository(connection)
        self.reviews = SQLiteReviewsRepository(connection)
        self.resume_runs = SQLiteResumeRunsRepository(connection)
        self.applications = SQLiteApplicationsRepository(connection)
        self.events = SQLiteEventsRepository(connection)
        self.artifacts = SQLiteArtifactsRepository(connection)
        self.commands = SQLiteCommandReceiptsRepository(connection)
        self.profile_versions = SQLiteProfileVersionsRepository(connection)
        self.job_versions = SQLiteJobVersionsRepository(connection)
        self.agent_runs = SQLiteAgentRunsRepository(connection)
        self.screens = SQLiteScreenEvaluationsRepository(connection)
        self.answer_events = SQLiteAnswerEventsRepository(connection)
        self.decision_events = SQLiteDecisionEventsRepository(connection)
        self.resume_reviews = SQLiteResumeReviewsRepository(connection)
        self.tracked_applications = SQLiteTrackedApplicationsRepository(connection)
        self.follow_ups = SQLiteFollowUpsRepository(connection)
        self.legacy_imports = SQLiteLegacyImportsRepository(connection)
        return self

    def __exit__(
        self,
        exc_type: object,
        exc: object,
        traceback: object,
    ) -> None:
        del exc_type, exc, traceback
        connection = self._connection
        if connection is None:
            return
        try:
            if connection.in_transaction:
                connection.rollback()
        finally:
            connection.close()
            self._connection = None

    def commit(self) -> None:
        self._require_connection().commit()

    def rollback(self) -> None:
        connection = self._require_connection()
        if connection.in_transaction:
            connection.rollback()

    @property
    def connection(self) -> sqlite3.Connection:
        return self._require_connection()

    def _require_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("Unit of work is not active")
        return self._connection


class SQLiteUnitOfWorkFactory:
    def __init__(self, database: SQLiteDatabase) -> None:
        self.database = database

    def __call__(self) -> UnitOfWork:
        return SQLiteUnitOfWork(self.database)
