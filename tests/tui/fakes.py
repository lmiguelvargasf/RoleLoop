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
    AgentConfiguration,
    AgentKind,
    AgentProvider,
    Answer,
    ApplicationStatus,
    ArtifactRef,
    Decision,
    EligibilityStatus,
    EvidenceSourceKind,
    Finding,
    Job,
    JobCase,
    QuestionCategory,
    RemotePreference,
    ResumeApprovalStatus,
    ResumeEvidenceVersion,
    ResumeExperienceSelection,
    ResumeRun,
    ResumeSource,
    ResumeSourceKind,
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
        self.closed = False
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
            agent_configurations=tuple(
                AgentConfiguration(kind, AgentProvider.DEMO, "gpt-5.6-terra", "medium")
                for kind in AgentKind
            ),
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
        self.resume_runs: list[ResumeRun] = []
        self.approval_status = ResumeApprovalStatus.NONE
        self.application: dict[str, Any] | None = None
        self.open_follow_up: dict[str, Any] | None = None
        self.follow_up_history: list[dict[str, Any]] = []
        self.stage_events: list[dict[str, Any]] = []
        self.events: list[WorkflowEvent] = []
        self.imported_paths: list[str] = []
        self.imported_requests: list[dict[str, str]] = []
        self.resume_source: ResumeSource | None = None
        self.resume_source_requests: list[dict[str, Any]] = []
        self.generation_gate: asyncio.Event | None = None
        self.generation_started: asyncio.Event | None = None
        self.generation_returns_failed = False
        self._run_counter = 0

    def close(self) -> None:
        self.closed = True

    def _summary(self) -> ActiveProfileSummary:
        return ActiveProfileSummary(
            profile=self.profile,
            evidence=self.evidence,
            provider_capabilities={
                "discovery": False,
                "review": True,
                "resume": True,
                "pdf": True,
                "resume_source_sync": True,
            },
            resume_source=self.resume_source,
        )

    @staticmethod
    def _agent_configurations(values: dict[str, Any]) -> tuple[AgentConfiguration, ...]:
        configurations = values.get("agent_configurations", ())
        return tuple(
            AgentConfiguration(
                AgentKind(str(item["kind"])),
                AgentProvider(str(item["provider"])),
                str(item["model"]),
                str(item["reasoning_effort"]),
            )
            for item in configurations
        )

    def _resume_case(self) -> dict[str, Any]:
        return {
            "runs": tuple(self.resume_runs),
            "review_events": (),
            "latest_run": self.resume_run,
            "latest_artifact_id": (
                self.resume_run.artifact.id
                if self.resume_run is not None and self.resume_run.artifact is not None
                else None
            ),
            "approval_status": self.approval_status,
        }

    def _application_view(self) -> dict[str, Any]:
        assert self.application is not None
        return {
            "application": self.application,
            "job": self.job,
            "case": self.case,
            "stages": tuple(self.stage_events),
            "open_follow_up": self.open_follow_up,
            "follow_up_history": tuple(self.follow_up_history),
            "follow_up_resolutions": (),
        }

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

    def get_startup_defaults(self) -> dict[str, Any]:
        self.calls.append(("get_startup_defaults",))
        return {}

    def get_active_profile_summary(self) -> ActiveProfileSummary:
        self.calls.append(("get_active_profile_summary",))
        return self._summary()

    def create_profile(self, values: dict[str, Any]) -> SearchProfile:
        self.calls.append(("create_profile", values))
        self.profile = replace(
            self.profile,
            name=values["name"],
            target_roles=tuple(values["target_roles"]),
            agent_configurations=self._agent_configurations(values),
        )
        return self.profile

    def update_profile(self, profile_id: str, values: dict[str, Any]) -> SearchProfile:
        self.calls.append(("update_profile", profile_id, values))
        self.profile = replace(
            self.profile,
            name=values["name"],
            target_roles=tuple(values["target_roles"]),
            agent_configurations=self._agent_configurations(values),
            revision=self.profile.revision + 1,
        )
        return self.profile

    def get_provider_status(self) -> dict[str, Any]:
        self.calls.append(("get_provider_status",))
        return {
            "profile_version": None,
            "capabilities": self._summary().provider_capabilities,
            "agent_configurations": self.profile.agent_configurations,
        }

    def check_runtime(self) -> dict[str, Any]:
        self.calls.append(("check_runtime",))
        return {"ready": True, "checks": ()}

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

    def get_resume(self, job_id: str) -> dict[str, Any]:
        self.calls.append(("get_resume", job_id))
        return self._resume_case()

    def get_job_history(self, job_id: str) -> JobHistoryView:
        self.calls.append(("get_job_history", job_id))
        return JobHistoryView(job=self.job, case=self.case, events=tuple(self.events))

    def list_applications(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        self.calls.append(("list_applications", dict(filters)))
        if self.application is None:
            return []
        return [self._application_view()]

    def get_application(self, job_id: str) -> dict[str, Any] | None:
        self.calls.append(("get_application", job_id))
        return self._application_view() if self.application is not None else None

    def list_due_followups(self) -> list[dict[str, Any]]:
        self.calls.append(("list_due_followups",))
        return [self.open_follow_up] if self.open_follow_up is not None else []

    def add_job(self, url: str, details: dict[str, Any]) -> Job:
        self.calls.append(("add_job", url, details))
        return self.job

    async def discover_jobs(self, progress: Any = None) -> list[Job]:
        self.calls.append(("discover_jobs",))
        if progress:
            progress(ProgressUpdate("discover", "fetching", "Checking configured sources"))
        return [self.job]

    async def review_job(
        self,
        job_id: str,
        rerun: bool = False,
        progress: Any = None,
    ) -> JobReviewView:
        self.calls.append(("review_job", job_id, rerun))
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
        self.review_status = ReviewStatus.STALE

    def get_answer_history(
        self,
        job_id: str,
        question_id: str | None = None,
    ) -> tuple[dict[str, Any], ...]:
        self.calls.append(("get_answer_history", job_id, question_id))
        if question_id is None or question_id in self.answers:
            return tuple(
                {
                    "id": f"answer-{key}",
                    "question_id": key,
                    "answer": value,
                    "created_at": NOW,
                }
                for key, value in self.answers.items()
                if question_id is None or key == question_id
            )
        return ()

    async def decide_job(
        self,
        job_id: str,
        decision: str,
        progress: Any = None,
    ) -> dict[str, Any]:
        self.calls.append(("decide_job", job_id, decision))
        self.case = replace(self.case, decision=Decision(decision), revision=self.case.revision + 1)
        run = None
        if decision == Decision.TAILOR.value:
            run = await self.generate_resume(job_id, progress=progress)
        return {"case": self.case, "resume_run": run}

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
        self._run_counter += 1
        run_id = f"run-{self._run_counter}"
        pdf = ArtifactRef(
            id=f"artifact-{run_id}",
            checksum=f"resume-checksum-{self._run_counter}",
            uri=f"file:///artifacts/{run_id}.pdf",
            media_type="application/pdf",
            size_bytes=4000,
        )
        self.resume_run = ResumeRun(
            id=run_id,
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
            headline="Applied AI Engineer",
            selected_bullet_ids=("sample.claim.reliable",),
            selected_skill_ids=("skill.python",),
            selected_experiences=(
                ResumeExperienceSelection(
                    experience_id="sample",
                    bullet_ids=("sample.claim.reliable",),
                ),
            ),
            renderer_source_revision="a" * 40,
            rendered_page_count=1,
            created_at=NOW,
            updated_at=NOW,
        )
        self.resume_runs.append(self.resume_run)
        self.resume_status = ResumeStatus.READY
        self.approval_status = ResumeApprovalStatus.NEEDS_REVIEW
        return self.resume_run

    async def retry_resume(self, job_id: str, progress: Any = None) -> ResumeRun:
        self.calls.append(("retry_resume", job_id))
        self.generation_returns_failed = False
        return await self.generate_resume(job_id, progress=progress)

    async def revise_resume(
        self,
        job_id: str,
        feedback: str,
        progress: Any = None,
    ) -> ResumeRun:
        self.calls.append(("revise_resume", job_id, feedback))
        parent = self.resume_run.id if self.resume_run is not None else None
        run = await self.generate_resume(job_id, progress=progress)
        self.resume_run = replace(run, parent_resume_run_id=parent)
        self.resume_runs[-1] = self.resume_run
        return self.resume_run

    def approve_resume(self, job_id: str, resume_run_id: str) -> dict[str, Any]:
        self.calls.append(("approve_resume", job_id, resume_run_id))
        self.approval_status = ResumeApprovalStatus.APPROVED
        return {"decision": "approved", "resume_run_id": resume_run_id}

    def reject_resume(
        self,
        job_id: str,
        resume_run_id: str,
        feedback: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("reject_resume", job_id, resume_run_id, feedback))
        self.approval_status = ResumeApprovalStatus.REJECTED
        return {"decision": "rejected", "resume_run_id": resume_run_id}

    def open_artifact(self, artifact_id: str) -> Path:
        self.calls.append(("open_artifact", artifact_id))
        return Path("/tmp") / f"{artifact_id}.pdf"

    def export_artifact(self, artifact_id: str, destination: str) -> Path:
        self.calls.append(("export_artifact", artifact_id, destination))
        return Path(destination)

    def submit_application(
        self,
        job_id: str,
        follow_up_date: str,
        note: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("submit_application", job_id, follow_up_date, note))
        assert self.resume_run is not None and self.resume_run.artifact is not None
        self.case = replace(
            self.case,
            application_status=ApplicationStatus.SUBMITTED,
            submitted_at=NOW,
            submitted_artifact_id=self.resume_run.artifact.id,
            updated_at=NOW,
        )
        self.application = {
            "id": "application-1",
            "job_id": job_id,
            "current_stage": "submitted",
            "submitted_at": NOW,
            "pdf_artifact_id": self.resume_run.artifact.id,
            "updated_at": NOW,
        }
        self.open_follow_up = {
            "id": "follow-up-1",
            "application_id": "application-1",
            "due_at": datetime.fromisoformat(f"{follow_up_date}T12:00:00+00:00"),
            "note": note,
        }
        self.follow_up_history.append(self.open_follow_up)
        return self._application_view()

    def record_application_stage(
        self,
        job_id: str,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        self.calls.append(("record_application_stage", job_id, dict(values)))
        assert self.application is not None
        self.application = {
            **self.application,
            "current_stage": values["stage"],
            "updated_at": NOW,
        }
        self.stage_events.append(
            {
                "id": f"stage-{len(self.stage_events) + 1}",
                "stage": values["stage"],
                "occurred_at": NOW,
                "note": values.get("note", ""),
            }
        )
        if values.get("follow_up"):
            self.open_follow_up = {
                "id": f"follow-up-{len(self.follow_up_history) + 1}",
                "application_id": "application-1",
                "due_at": datetime.fromisoformat(f"{values['follow_up']}T12:00:00+00:00"),
                "note": values.get("note", ""),
            }
            self.follow_up_history.append(self.open_follow_up)
        elif values.get("no_follow_up") or values["stage"] in {
            "offer",
            "rejected",
            "withdrawn",
            "no_response",
        }:
            self.open_follow_up = None
        return self._application_view()

    def resolve_followup(self, follow_up_id: str, note: str = "") -> dict[str, Any]:
        self.calls.append(("resolve_followup", follow_up_id, note))
        self.open_follow_up = None
        return {"follow_up_id": follow_up_id, "disposition": "completed"}

    def reschedule_followup(
        self,
        follow_up_id: str,
        due_date: str,
        note: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("reschedule_followup", follow_up_id, due_date, note))
        self.open_follow_up = {
            "id": f"follow-up-{len(self.follow_up_history) + 1}",
            "application_id": "application-1",
            "due_at": datetime.fromisoformat(f"{due_date}T12:00:00+00:00"),
            "note": note,
        }
        self.follow_up_history.append(self.open_follow_up)
        return self.open_follow_up

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

    def configure_resume_source(
        self,
        values: dict[str, Any],
        expected_revision: int | None = None,
    ) -> ResumeSource:
        self.calls.append(("configure_resume_source", dict(values), expected_revision))
        self.resume_source_requests.append(dict(values))
        current_revision = self.resume_source.revision if self.resume_source is not None else 0
        kind = ResumeSourceKind(str(values["kind"]))
        self.resume_source = ResumeSource(
            id="resume-source-1",
            profile_id=self.profile.id,
            kind=kind,
            repository=str(values["repository"]),
            ref=str(
                values.get("ref") or ("HEAD" if kind is ResumeSourceKind.LOCAL_GIT else "main")
            ),
            document_path="roleloop_contract/v1/cli.py",
            trust_acknowledged_at=NOW if values.get("trust_repository") else None,
            revision=current_revision + 1,
            created_at=NOW,
            updated_at=NOW,
        )
        return self.resume_source

    async def sync_resume_source(self, progress: Any = None) -> ResumeEvidenceVersion:
        self.calls.append(("sync_resume_source",))
        if progress:
            progress(
                ProgressUpdate(
                    "resume_source_sync",
                    "resolving",
                    "Resolving master résumé snapshot",
                )
            )
        assert self.resume_source is not None
        self.evidence = replace(
            self.evidence,
            id="evidence-git-1",
            source_name="evidence-catalog.json",
            resume_source_id=self.resume_source.id,
            source_revision="abc123",
        )
        self.profile = replace(
            self.profile,
            active_evidence_version_id=self.evidence.id,
        )
        self.resume_source = replace(
            self.resume_source,
            last_synced_revision="abc123",
            last_synced_checksum=self.evidence.source_artifact.checksum,
            last_synced_evidence_version_id=self.evidence.id,
            last_synced_at=NOW,
            revision=self.resume_source.revision + 1,
            updated_at=NOW,
        )
        if progress:
            progress(
                ProgressUpdate(
                    "resume_source_sync",
                    "complete",
                    "Master résumé snapshot synchronized",
                )
            )
        return self.evidence

    def preview_legacy_import(self) -> dict[str, Any]:
        self.calls.append(("preview_legacy_import",))
        return {
            "source_job_count": 2,
            "source_event_count": 3,
            "deduplicated_job_count": 1,
            "sources": (),
        }

    def apply_legacy_import(self) -> dict[str, Any]:
        self.calls.append(("apply_legacy_import",))
        return {"id": "legacy-batch-1", "imported_jobs": 1, "imported_events": 3}


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
            agent_configurations=self._agent_configurations(values),
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
            agent_configurations=self._agent_configurations(values),
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
