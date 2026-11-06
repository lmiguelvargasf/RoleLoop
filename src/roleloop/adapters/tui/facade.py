"""Concrete adapter from ``RoleLoopService`` to the TUI's ergonomic facade."""

from __future__ import annotations

import tempfile
import webbrowser
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from roleloop.adapters.inputs import (
    local_date_time,
    profile_draft_from_mapping,
    resume_source_draft_from_mapping,
)
from roleloop.application.dto import (
    ApplicationStageDraft,
    EvidenceImport,
    InboxFilters,
    JobDetails,
    Page,
    ProgressUpdate,
    SubmitApplicationDraft,
)
from roleloop.application.errors import ValidationError
from roleloop.domain import (
    Answer,
    ApplicationStage,
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    EvidenceSourceKind,
    Outcome,
    ResumeSourceKind,
    ResumeStatus,
    ReviewStatus,
)
from roleloop.infrastructure.legacy import LegacyMasterStateReader, LegacyStateError

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

    def __init__(
        self,
        service: RoleLoopService,
        *,
        startup_defaults: Mapping[str, Any] | None = None,
    ) -> None:
        self.service = service
        self._startup_defaults = dict(startup_defaults or {})

    def get_startup_defaults(self) -> Mapping[str, Any]:
        """Return non-secret environment seeds for explicit onboarding review."""

        return self._startup_defaults

    def close(self) -> None:
        """Release resources owned by the composed application service."""

        close = getattr(self.service, "close", None)
        if callable(close):
            close()

    def _active_profile_id(self) -> str:
        summary = self.service.get_active_profile_summary()
        if summary is None:
            raise ValidationError("Create or activate a search profile first.")
        return summary.profile.id

    @staticmethod
    def _profile_draft(values: Mapping[str, Any]) -> Any:
        return profile_draft_from_mapping(values)

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

    async def get_provider_status(self) -> Any:
        return await self.service.get_provider_status(self._active_profile_id())

    async def check_runtime(self) -> Any:
        return await self.service.check_runtime(self._active_profile_id())

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

    def get_resume(self, job_id: str) -> Any:
        return self.service.get_resume(self._active_profile_id(), job_id)

    def get_job_history(self, job_id: str) -> Any:
        method = (
            self.service.get_unified_history
            if hasattr(self.service, "get_unified_history")
            else self.service.get_history
        )
        return method(self._active_profile_id(), job_id)

    def list_applications(self, filters: Mapping[str, Any]) -> Any:
        if hasattr(self.service, "list_applications"):
            # The authoritative application ledger has its own query and does not
            # share the inbox's legacy filter vocabulary.
            del filters
            return self.service.list_applications(self._active_profile_id())
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

    async def add_job(
        self,
        url: str,
        details: Mapping[str, Any],
        progress: Callable[[Any], None] | None = None,
    ) -> Any:
        profile_id = self._active_profile_id()
        view = await self.service.inspect_job_url(
            profile_id,
            url,
            progress=CallbackProgressReporter(progress),
        )
        if any(str(value or "").strip() for value in details.values()):
            job = view.job
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
        return view

    async def discover_jobs(self, progress: Callable[[Any], None] | None = None) -> Any:
        return await self.service.discover_jobs(
            self._active_profile_id(),
            limit=20,
            progress=CallbackProgressReporter(progress),
        )

    async def review_job(
        self,
        job_id: str,
        rerun: bool = False,
        progress: Callable[[Any], None] | None = None,
    ) -> Any:
        return await self.service.review_job(
            self._active_profile_id(),
            job_id,
            rerun=rerun,
            progress=CallbackProgressReporter(progress),
        )

    def answer_verification(self, job_id: str, question_id: str, answer: str) -> Any:
        return self.service.answer_verification(
            self._active_profile_id(), job_id, question_id, Answer(answer)
        )

    def get_answer_history(self, job_id: str, question_id: str | None = None) -> Any:
        return self.service.get_answer_history(
            self._active_profile_id(),
            job_id,
            question_id,
        )

    async def decide_job(
        self,
        job_id: str,
        decision: str,
        progress: Callable[[Any], None] | None = None,
    ) -> Any:
        return await self.service.decide_and_tailor(
            self._active_profile_id(),
            job_id,
            Decision(decision),
            progress=CallbackProgressReporter(progress),
        )

    async def generate_resume(
        self, job_id: str, progress: Callable[[Any], None] | None = None
    ) -> Any:
        return await self.service.generate_resume(
            self._active_profile_id(),
            job_id,
            progress=CallbackProgressReporter(progress),
        )

    async def retry_resume(
        self,
        job_id: str,
        progress: Callable[[Any], None] | None = None,
    ) -> Any:
        return await self.service.retry_resume(
            self._active_profile_id(),
            job_id,
            progress=CallbackProgressReporter(progress),
        )

    async def revise_resume(
        self,
        job_id: str,
        feedback: str,
        progress: Callable[[Any], None] | None = None,
    ) -> Any:
        return await self.service.revise_resume(
            self._active_profile_id(),
            job_id,
            feedback,
            progress=CallbackProgressReporter(progress),
        )

    def approve_resume(self, job_id: str, resume_run_id: str) -> Any:
        return self.service.approve_resume(
            self._active_profile_id(),
            job_id,
            resume_run_id,
        )

    def reject_resume(self, job_id: str, resume_run_id: str, feedback: str = "") -> Any:
        return self.service.reject_resume(
            self._active_profile_id(),
            job_id,
            resume_run_id,
            feedback=feedback,
        )

    async def export_artifact(self, artifact_id: str, destination: str) -> Any:
        return await self.service.export_artifact(artifact_id, Path(destination))

    async def open_artifact(self, artifact_id: str) -> Any:
        temporary_root = Path(tempfile.mkdtemp(prefix="roleloop-resume-open-"))
        destination = temporary_root / f"{artifact_id}.pdf"
        exported = await self.service.export_artifact(artifact_id, destination)
        webbrowser.open(Path(exported).resolve().as_uri())
        return exported

    def mark_applied(self, job_id: str) -> Any:
        return self.service.mark_applied(self._active_profile_id(), job_id)

    def record_outcome(self, job_id: str, outcome: str) -> Any:
        return self.service.record_outcome(self._active_profile_id(), job_id, Outcome(outcome))

    def _date(self, value: str) -> Any:
        summary = self.service.get_active_profile_summary()
        if summary is None:
            raise ValidationError("Create or activate a search profile first.")
        return local_date_time(value, summary.profile.timezone)

    def submit_application(self, job_id: str, follow_up_date: str, note: str = "") -> Any:
        return self.service.submit_application(
            self._active_profile_id(),
            job_id,
            SubmitApplicationDraft(
                follow_up_at=self._date(follow_up_date),
                follow_up_note=note,
            ),
        )

    def record_application_stage(self, job_id: str, values: Mapping[str, Any]) -> Any:
        follow_up = values.get("follow_up")
        return self.service.record_application_stage(
            self._active_profile_id(),
            job_id,
            ApplicationStageDraft(
                stage=ApplicationStage(str(values.get("stage", ""))),
                note=str(values.get("note", "") or ""),
                follow_up_at=self._date(str(follow_up)) if follow_up else None,
                no_follow_up=bool(values.get("no_follow_up", False)),
            ),
        )

    def get_application(self, job_id: str) -> Any:
        return self.service.get_application(self._active_profile_id(), job_id)

    def list_due_followups(self) -> Any:
        return self.service.list_due_followups(self._active_profile_id())

    def resolve_followup(self, follow_up_id: str, note: str = "") -> Any:
        return self.service.resolve_followup(
            self._active_profile_id(),
            follow_up_id,
            note=note,
        )

    def reschedule_followup(self, follow_up_id: str, due_date: str, note: str = "") -> Any:
        return self.service.reschedule_followup(
            self._active_profile_id(),
            follow_up_id,
            self._date(due_date),
            note=note,
        )

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
            resume_source_draft_from_mapping(values),
            expected_revision=expected_revision,
        )

    async def sync_resume_source(self, progress: Callable[[Any], None] | None = None) -> Any:
        return await self.service.sync_resume_source(
            self._active_profile_id(),
            progress=CallbackProgressReporter(progress),
        )

    def _legacy_import_draft(self) -> Any:
        profile_id = self._active_profile_id()
        source = self.service.get_resume_source(profile_id)
        if source is None or source.kind is not ResumeSourceKind.LOCAL_GIT:
            raise ValidationError(
                "Configure a local master résumé repository before importing legacy history."
            )
        try:
            return LegacyMasterStateReader().to_import_draft(Path(source.repository))
        except LegacyStateError as error:
            raise ValidationError(str(error)) from error

    def preview_legacy_import(self) -> Any:
        return self.service.preview_legacy_import(self._legacy_import_draft())

    def apply_legacy_import(self) -> Any:
        return self.service.apply_legacy_import(
            self._active_profile_id(),
            self._legacy_import_draft(),
        )
