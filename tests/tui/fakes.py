"""DTO-shaped test facade for headless Textual interaction tests."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from roleloop.application.dto import (
    ActiveProfileSummary,
    JobHistoryView,
    JobInboxItem,
    JobReviewView,
    ProgressUpdate,
)
from roleloop.application.errors import ProviderUnavailableError
from roleloop.domain import (
    Answer,
    ApplicationStatus,
    ArtifactRef,
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
    ResumeStage,
    ResumeStatus,
    ReviewQuestion,
    ReviewStatus,
    ReviewVersion,
    SearchProfile,
    ValidationFinding,
    ValidationSeverity,
    WorkflowEvent,
)

NOW = datetime(2026, 8, 13, 18, 0, tzinfo=UTC)


class FakeFacade:
    def __init__(
        self,
        *,
        decision: Decision = Decision.UNDECIDED,
        eligibility: EligibilityStatus = EligibilityStatus.ELIGIBLE,
        review_status: ReviewStatus = ReviewStatus.CURRENT,
    ) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.generate_error: BaseException | None = None
        self.review_error: BaseException | None = None
        self.profile = SearchProfile(
            id="profile-1",
            name="Senior backend search",
            target_roles=("Senior Python Engineer",),
            locations=("Quito", "Remote"),
            remote_preference=RemotePreference.REMOTE,
            employment_types=("full-time",),
            seniority=("senior", "staff"),
            annual_salary_floor=120_000,
            salary_currency="USD",
            include_keywords=("python", "distributed systems"),
            exclude_keywords=("onsite only",),
            constraints="No relocation.",
            is_active=True,
            active_evidence_version_id="evidence-1",
            created_at=NOW,
            updated_at=NOW,
        )
        artifact = ArtifactRef(
            id="artifact-evidence",
            checksum="evidence-checksum",
            uri="file:///evidence/resume.pdf",
            media_type="application/pdf",
            size_bytes=2000,
        )
        self.evidence = ResumeEvidenceVersion(
            id="evidence-1",
            profile_id=self.profile.id,
            source_kind=EvidenceSourceKind.PDF,
            source_name="base-resume.pdf",
            source_artifact=artifact,
            extracted_text="Python systems engineer",
            created_at=NOW,
        )
        self.job = Job(
            id="job-1",
            canonical_url="https://jobs.example.test/backend",
            title="Senior Backend Engineer",
            company="Example Labs",
            location="Remote",
            description="Build reliable Python services and distributed systems.",
            source="manual",
            created_at=NOW,
            updated_at=NOW,
        )
        self.case = JobCase(
            id="case-1",
            profile_id=self.profile.id,
            job_id=self.job.id,
            decision=decision,
            created_at=NOW,
            updated_at=NOW,
        )
        self.question = ReviewQuestion(
            id="question-1",
            prompt="Are you authorized to work in the hiring country?",
            category=QuestionCategory.ELIGIBILITY,
            required=True,
            qualifying_answer=Answer.YES,
        )
        self.review = ReviewVersion(
            id="review-1",
            job_case_id=self.case.id,
            fingerprint="review-fingerprint",
            analyzer_version="fake-analyzer/1",
            match_evidence=(
                Finding(
                    "Strong Python background",
                    "The résumé shows seven years building Python services.",
                    "experience.python",
                ),
            ),
            skeptic_findings=(
                Finding(
                    "Scale is not quantified",
                    "The résumé does not state request volume.",
                    "experience.scale",
                ),
            ),
            questions=(self.question,),
            created_at=NOW,
        )
        self.answers: dict[str, Answer] = (
            {} if eligibility is EligibilityStatus.UNRESOLVED else {self.question.id: Answer.YES}
        )
        self.eligibility = eligibility
        self.review_status = review_status
        self.resume_status = ResumeStatus.NONE
        self.resume_run: ResumeRun | None = None
        self.events: list[WorkflowEvent] = []
        self.imported_paths: list[str] = []
        self.imported_requests: list[dict[str, str]] = []
        self.generation_gate: asyncio.Event | None = None
        self.generation_started: asyncio.Event | None = None
        self.generation_returns_failed = False

    def _summary(self) -> ActiveProfileSummary:
        return ActiveProfileSummary(
            profile=self.profile,
            evidence=self.evidence,
            provider_capabilities={
                "discovery": False,
                "review": True,
                "resume": True,
                "pdf": True,
            },
        )

    def _inbox_item(self) -> JobInboxItem:
        return JobInboxItem(
            case_id=self.case.id,
            job_id=self.job.id,
            canonical_url=self.job.canonical_url,
            title=self.job.title,
            company=self.job.company,
            location=self.job.location,
            review_status=self.review_status,
            eligibility_status=self.eligibility,
            decision=self.case.decision,
            resume_status=self.resume_status,
            application_status=self.case.application_status,
            outcome=self.case.current_outcome,
            updated_at=self.case.updated_at,
            submitted_at=self.case.submitted_at,
            submitted_artifact_id=self.case.submitted_artifact_id,
        )

    def _review_view(self) -> JobReviewView:
        return JobReviewView(
            job=self.job,
            case=self.case,
            review_status=self.review_status,
            review=self.review if self.review_status is not ReviewStatus.MISSING else None,
            answers=self.answers,
            eligibility_status=self.eligibility,
            latest_resume_run=self.resume_run,
            resume_status=self.resume_status,
        )

    def list_profiles(self) -> list[SearchProfile]:
        self.calls.append(("list_profiles",))
        return [self.profile]

    def get_active_profile_summary(self) -> ActiveProfileSummary:
        self.calls.append(("get_active_profile_summary",))
        return self._summary()

    def create_profile(self, values: dict[str, Any]) -> SearchProfile:
        self.calls.append(("create_profile", values))
        self.profile = replace(
            self.profile,
            name=values["name"],
            target_roles=tuple(values["target_roles"]),
        )
        return self.profile

    def update_profile(self, profile_id: str, values: dict[str, Any]) -> SearchProfile:
        self.calls.append(("update_profile", profile_id, values))
        self.profile = replace(
            self.profile,
            name=values["name"],
            target_roles=tuple(values["target_roles"]),
            revision=self.profile.revision + 1,
        )
        return self.profile

    def activate_profile(self, profile_id: str) -> SearchProfile:
        self.calls.append(("activate_profile", profile_id))
        self.profile = replace(self.profile, is_active=True)
        return self.profile

    def list_jobs(self, filters: dict[str, Any]) -> list[JobInboxItem]:
        self.calls.append(("list_jobs", dict(filters)))
        item = self._inbox_item()
        for name in ("review", "eligibility", "decision", "resume", "application"):
            expected = filters.get(name)
            if (
                expected
                and getattr(getattr(item, f"{name}_status", None), "value", None) != expected
                and getattr(getattr(item, name, None), "value", None) != expected
            ):
                return []
        return [item]

    def get_job_review(self, job_id: str) -> JobReviewView:
        self.calls.append(("get_job_review", job_id))
        return self._review_view()

    def get_job_history(self, job_id: str) -> JobHistoryView:
        self.calls.append(("get_job_history", job_id))
        return JobHistoryView(job=self.job, case=self.case, events=tuple(self.events))

    def list_applications(self, filters: dict[str, Any]) -> list[JobInboxItem]:
        self.calls.append(("list_applications", dict(filters)))
        if self.case.application_status is not ApplicationStatus.SUBMITTED:
            return []
        return [self._inbox_item()]

    def add_job(self, url: str, details: dict[str, Any]) -> Job:
        self.calls.append(("add_job", url, details))
        return self.job

    async def discover_jobs(self, progress: Any = None) -> list[Job]:
        self.calls.append(("discover_jobs",))
        if progress:
            progress(ProgressUpdate("discover", "fetching", "Checking configured sources"))
        return [self.job]

    async def review_job(self, job_id: str, progress: Any = None) -> JobReviewView:
        self.calls.append(("review_job", job_id))
        if self.review_error:
            raise self.review_error
        if progress:
            progress(ProgressUpdate("review", "analyzing", "Building evidence ledger"))
        self.review_status = ReviewStatus.CURRENT
        return self._review_view()

    def answer_verification(self, job_id: str, question_id: str, answer: str) -> None:
        self.calls.append(("answer_verification", job_id, question_id, answer))
        self.answers[question_id] = Answer(answer)
        self.eligibility = (
            EligibilityStatus.ELIGIBLE
            if self.answers[question_id] is Answer.YES
            else EligibilityStatus.INELIGIBLE
        )

    def decide_job(self, job_id: str, decision: str) -> JobCase:
        self.calls.append(("decide_job", job_id, decision))
        self.case = replace(self.case, decision=Decision(decision), revision=self.case.revision + 1)
        return self.case

    async def generate_resume(self, job_id: str, progress: Any = None) -> ResumeRun:
        self.calls.append(("generate_resume", job_id))
        if self.generate_error:
            raise self.generate_error
        if progress:
            progress(ProgressUpdate("resume", "drafting", "Drafting from cited evidence"))
        if self.generation_started is not None:
            self.generation_started.set()
        if self.generation_gate is not None:
            await self.generation_gate.wait()
        if progress:
            progress(ProgressUpdate("resume", "validating", "Checking unsupported claims"))
        if self.generation_returns_failed:
            self.resume_run = ResumeRun(
                id="run-failed",
                job_case_id=self.case.id,
                review_version_id=self.review.id,
                evidence_version_id=self.evidence.id,
                input_fingerprint="resume-fingerprint",
                stage=ResumeStage.FAILED,
                generator_version="fake-generator/1",
                validator_version="fake-validator/1",
                compiler_version="fake-compiler/1",
                validation_findings=(
                    ValidationFinding(
                        ValidationSeverity.ERROR,
                        "A generated claim is not supported by imported evidence.",
                    ),
                ),
                error_message="Blocking validation findings prevented PDF compilation.",
                created_at=NOW,
                updated_at=NOW,
            )
            self.resume_status = ResumeStatus.FAILED
            return self.resume_run
        if progress:
            progress(ProgressUpdate("resume", "compiling", "Compiling PDF"))
        pdf = ArtifactRef(
            id="artifact-resume",
            checksum="resume-checksum",
            uri="file:///artifacts/tailored.pdf",
            media_type="application/pdf",
            size_bytes=4000,
        )
        self.resume_run = ResumeRun(
            id="run-1",
            job_case_id=self.case.id,
            review_version_id=self.review.id,
            evidence_version_id=self.evidence.id,
            input_fingerprint="resume-fingerprint",
            stage=ResumeStage.READY,
            generator_version="fake-generator/1",
            validator_version="fake-validator/1",
            compiler_version="fake-compiler/1",
            validation_findings=(
                ValidationFinding(ValidationSeverity.INFO, "All claims have evidence."),
            ),
            artifact=pdf,
            created_at=NOW,
            updated_at=NOW,
        )
        self.resume_status = ResumeStatus.READY
        return self.resume_run

    def mark_applied(self, job_id: str) -> JobCase:
        self.calls.append(("mark_applied", job_id))
        self.case = replace(
            self.case,
            application_status=ApplicationStatus.SUBMITTED,
            submitted_at=NOW,
            submitted_artifact_id=(
                self.resume_run.artifact.id
                if self.resume_run is not None and self.resume_run.artifact is not None
                else None
            ),
            updated_at=NOW,
        )
        return self.case

    def record_outcome(self, job_id: str, outcome: str) -> JobCase:
        self.calls.append(("record_outcome", job_id, outcome))
        self.case = replace(self.case, current_outcome=Outcome(outcome), updated_at=NOW)
        return self.case

    async def import_evidence(self, request: dict[str, str]) -> ResumeEvidenceVersion:
        self.calls.append(("import_evidence", request))
        self.imported_requests.append(request)
        source_name = (
            Path(request["path"]).name if request["kind"] == "path" else request["source_name"]
        )
        if request["kind"] == "path":
            self.imported_paths.append(request["path"])
        self.evidence = replace(
            self.evidence,
            id=f"evidence-{len(self.imported_requests) + 1}",
            source_name=source_name,
        )
        return self.evidence


class OnboardingFacade(FakeFacade):
    def __init__(self) -> None:
        super().__init__()
        self.configured = False

    def list_profiles(self) -> list[SearchProfile]:
        self.calls.append(("list_profiles",))
        return [self.profile] if self.configured else []

    def get_active_profile_summary(self) -> ActiveProfileSummary | None:
        self.calls.append(("get_active_profile_summary",))
        return self._summary() if self.configured else None

    def create_profile(self, values: dict[str, Any]) -> SearchProfile:
        profile = super().create_profile(values)
        self.configured = True
        return profile


class ProfileManagementFacade(FakeFacade):
    """A small multi-profile fake for the Settings workflow."""

    def __init__(self) -> None:
        super().__init__()
        secondary = replace(
            self.profile,
            id="profile-2",
            name="ML platform search",
            target_roles=("ML Platform Engineer",),
            is_active=False,
            active_evidence_version_id=None,
        )
        self.profile_list = [self.profile, secondary]

    def _summary(self) -> ActiveProfileSummary:
        summary = super()._summary()
        return replace(
            summary,
            profile=self.profile,
            evidence=self.evidence if self.profile.id == "profile-1" else None,
        )

    def list_profiles(self) -> list[SearchProfile]:
        self.calls.append(("list_profiles",))
        return list(self.profile_list)

    def create_profile(self, values: dict[str, Any]) -> SearchProfile:
        self.calls.append(("create_profile", values))
        created = replace(
            self.profile,
            id=f"profile-{len(self.profile_list) + 1}",
            name=values["name"],
            target_roles=tuple(values["target_roles"]),
            locations=tuple(values["locations"]),
            remote_preference=RemotePreference(values["remote_preference"]),
            employment_types=tuple(values["employment_types"]),
            seniority=tuple(values["seniority"]),
            annual_salary_floor=values["annual_salary_floor"],
            salary_currency=values["salary_currency"],
            include_keywords=tuple(values["include_keywords"]),
            exclude_keywords=tuple(values["exclude_keywords"]),
            constraints=values["constraints"],
            is_active=False,
            active_evidence_version_id=None,
            revision=1,
        )
        self.profile_list.append(created)
        return created

    def update_profile(self, profile_id: str, values: dict[str, Any]) -> SearchProfile:
        self.calls.append(("update_profile", profile_id, values))
        profile = next(item for item in self.profile_list if item.id == profile_id)
        updated = replace(
            profile,
            name=values["name"],
            target_roles=tuple(values["target_roles"]),
            revision=profile.revision + 1,
        )
        self.profile_list = [
            updated if item.id == profile_id else item for item in self.profile_list
        ]
        if self.profile.id == profile_id:
            self.profile = updated
        return updated

    def activate_profile(self, profile_id: str) -> SearchProfile:
        self.calls.append(("activate_profile", profile_id))
        self.profile_list = [
            replace(item, is_active=item.id == profile_id) for item in self.profile_list
        ]
        self.profile = next(item for item in self.profile_list if item.id == profile_id)
        return self.profile


def provider_error(message: str = "Résumé provider is not configured.") -> BaseException:
    return ProviderUnavailableError(message)
