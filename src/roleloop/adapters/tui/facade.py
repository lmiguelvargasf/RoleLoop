"""Concrete adapter from ``RoleLoopService`` to the TUI's ergonomic facade."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from roleloop.application.dto import (
    EvidenceImport,
    InboxFilters,
    JobDetails,
    Page,
    ProfileDraft,
    ProgressUpdate,
    ResumeSourceDraft,
)
from roleloop.application.errors import ValidationError
from roleloop.domain import (
    Answer,
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    EvidenceSourceKind,
    Outcome,
    RemotePreference,
    ResumeSourceKind,
    ResumeStatus,
    ReviewStatus,
)

if TYPE_CHECKING:
    from roleloop.application.services import RoleLoopService


class CallbackProgressReporter:
    """Translate an application progress port into a plain callback."""

    def __init__(self, callback: Callable[[Any], None] | None) -> None:
        self.callback = callback

    def report(self, update: ProgressUpdate) -> None:
        if self.callback is not None:
            self.callback(update)


class ApplicationServiceFacade:
    """Map TUI form values and active-profile context to ``RoleLoopService``."""

    def __init__(self, service: RoleLoopService) -> None:
        self.service = service

    def _active_profile_id(self) -> str:
        summary = self.service.get_active_profile_summary()
        if summary is None:
            raise ValidationError("Create or activate a search profile first.")
        return summary.profile.id

    @staticmethod
    def _profile_draft(values: Mapping[str, Any]) -> ProfileDraft:
        return ProfileDraft(
            name=str(values.get("name", "")).strip(),
            target_roles=tuple(values.get("target_roles", ()) or ()),
            locations=tuple(values.get("locations", ()) or ()),
            remote_preference=RemotePreference(str(values.get("remote_preference", "any"))),
            employment_types=tuple(values.get("employment_types", ()) or ()),
            seniority=tuple(values.get("seniority", ()) or ()),
            annual_salary_floor=values.get("annual_salary_floor"),
            salary_currency=str(values.get("salary_currency", "USD") or "USD"),
            include_keywords=tuple(values.get("include_keywords", ()) or ()),
            exclude_keywords=tuple(values.get("exclude_keywords", ()) or ()),
            constraints=str(values.get("constraints", "") or ""),
        )

    def list_profiles(self) -> Any:
        return self.service.list_profiles()

    def get_active_profile_summary(self) -> Any:
        return self.service.get_active_profile_summary()

    def create_profile(self, values: Mapping[str, Any]) -> Any:
        return self.service.create_profile(self._profile_draft(values))

    def update_profile(self, profile_id: str, values: Mapping[str, Any]) -> Any:
        profile = next(
            profile for profile in self.service.list_profiles() if profile.id == profile_id
        )
        return self.service.update_profile(
            profile_id,
            self._profile_draft(values),
            expected_revision=profile.revision,
        )

    def activate_profile(self, profile_id: str) -> Any:
        return self.service.activate_profile(profile_id)

    @staticmethod
    def _filters(values: Mapping[str, Any]) -> InboxFilters:
        outcome_value = values.get("outcome")
        outcomes: frozenset[Outcome | None]
        if outcome_value == "none":
            outcomes = frozenset({None})
        elif outcome_value:
            outcomes = frozenset({Outcome(str(outcome_value))})
        else:
            outcomes = frozenset()
        return InboxFilters(
            search=str(values.get("search", "") or ""),
            review=frozenset({ReviewStatus(str(values["review"]))})
            if values.get("review")
            else frozenset(),
            eligibility=frozenset({EligibilityStatus(str(values["eligibility"]))})
            if values.get("eligibility")
            else frozenset(),
            decision=frozenset({Decision(str(values["decision"]))})
            if values.get("decision")
            else frozenset(),
            resume=frozenset({ResumeStatus(str(values["resume"]))})
            if values.get("resume")
            else frozenset(),
            application=frozenset({ApplicationStatus(str(values["application"]))})
            if values.get("application")
            else frozenset(),
            outcome=outcomes,
        )

    def list_jobs(self, filters: Mapping[str, Any]) -> Any:
        return self.service.list_inbox(
            self._active_profile_id(), filters=self._filters(filters), page=Page(limit=500)
        )

    def get_job_review(self, job_id: str) -> Any:
        return self.service.get_job_case(self._active_profile_id(), job_id)

    def get_job_history(self, job_id: str) -> Any:
        return self.service.get_history(self._active_profile_id(), job_id)

    def list_applications(self, filters: Mapping[str, Any]) -> Any:
        values = dict(filters)
        values["application"] = ApplicationStatus.SUBMITTED.value
        profile_id = self._active_profile_id()
        items = self.service.list_inbox(
            profile_id, filters=self._filters(values), page=Page(limit=500)
        )
        rows: list[dict[str, Any]] = []
        for item in items:
            case = self.service.get_job_case(profile_id, item.job_id).case
            rows.append(
                {
                    "job_id": item.job_id,
                    "title": item.title,
                    "company": item.company,
                    "submitted_at": case.submitted_at,
                    "submitted_artifact_id": case.submitted_artifact_id,
                    "outcome": item.outcome,
                    "updated_at": item.updated_at,
                }
            )
        return rows

    def add_job(self, url: str, details: Mapping[str, Any]) -> Any:
        profile_id = self._active_profile_id()
        case = self.service.add_job_url(profile_id, url)
        if any(str(value or "").strip() for value in details.values()):
            job = self.service.get_job_case(profile_id, case.job_id).job
            return self.service.update_job_details(
                profile_id,
                job.id,
                JobDetails(
                    title=str(details.get("title", "") or ""),
                    company=str(details.get("company", "") or ""),
                    location=str(details.get("location", "") or ""),
                    description=str(details.get("description", "") or ""),
                    source=job.source,
                    source_metadata=job.source_metadata,
                ),
                expected_revision=job.revision,
            )
        return case

    async def discover_jobs(self, progress: Callable[[Any], None] | None = None) -> Any:
        return await self.service.discover_jobs(
            self._active_profile_id(),
            limit=20,
            progress=CallbackProgressReporter(progress),
        )

    async def review_job(self, job_id: str, progress: Callable[[Any], None] | None = None) -> Any:
        return await self.service.review_job(
            self._active_profile_id(),
            job_id,
            progress=CallbackProgressReporter(progress),
        )

    def answer_verification(self, job_id: str, question_id: str, answer: str) -> Any:
        return self.service.answer_verification(
            self._active_profile_id(), job_id, question_id, Answer(answer)
        )

    def decide_job(self, job_id: str, decision: str) -> Any:
        return self.service.decide_job(self._active_profile_id(), job_id, Decision(decision))

    async def generate_resume(
        self, job_id: str, progress: Callable[[Any], None] | None = None
    ) -> Any:
        return await self.service.generate_resume(
            self._active_profile_id(),
            job_id,
            progress=CallbackProgressReporter(progress),
        )

    def mark_applied(self, job_id: str) -> Any:
        return self.service.mark_applied(self._active_profile_id(), job_id)

    def record_outcome(self, job_id: str, outcome: str) -> Any:
        return self.service.record_outcome(self._active_profile_id(), job_id, Outcome(outcome))

    async def import_evidence(self, request: Mapping[str, str]) -> Any:
        if request.get("kind") == "text":
            evidence_import = EvidenceImport(
                source_kind=EvidenceSourceKind.PASTED_TEXT,
                text=request.get("text", ""),
                source_name=request.get("source_name") or "pasted-resume.txt",
            )
        else:
            source_path = Path(request.get("path", ""))
            source_kind = (
                EvidenceSourceKind.PDF
                if source_path.suffix.lower() == ".pdf"
                else EvidenceSourceKind.TEXT_FILE
            )
            evidence_import = EvidenceImport(
                source_kind=source_kind,
                path=source_path,
            )
        return await self.service.import_evidence(
            self._active_profile_id(),
            evidence_import,
        )

    def configure_resume_source(
        self,
        values: Mapping[str, Any],
        expected_revision: int | None = None,
    ) -> Any:
        return self.service.configure_resume_source(
            self._active_profile_id(),
            ResumeSourceDraft(
                repository=str(values.get("repository", "")).strip(),
                kind=ResumeSourceKind(str(values.get("kind", ""))),
                document_path=str(values.get("document_path", "")).strip(),
                ref=str(values.get("ref", "")).strip() or None,
            ),
            expected_revision=expected_revision,
        )

    async def sync_resume_source(self, progress: Callable[[Any], None] | None = None) -> Any:
        return await self.service.sync_resume_source(
            self._active_profile_id(),
            progress=CallbackProgressReporter(progress),
        )
