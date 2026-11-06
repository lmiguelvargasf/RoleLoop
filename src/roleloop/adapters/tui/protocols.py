"""Adapter-facing contracts for the Textual interface.

The TUI deliberately depends on this small, structural protocol rather than on
SQLite repositories or concrete application-service classes.  A composition
root may pass an object that implements these methods directly, or a thin
facade over a command/query bus.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol, TypeAlias

MaybeAwaitable: TypeAlias = Any
ProgressSink: TypeAlias = Callable[[Any], None]


class RoleLoopFacade(Protocol):
    """Commands and queries consumed by :class:`RoleLoopApp`.

    Implementations may be synchronous or asynchronous.  The TUI dispatches
    synchronous methods away from Textual's event loop.
    """

    def list_profiles(self) -> MaybeAwaitable: ...

    def get_startup_defaults(self) -> MaybeAwaitable: ...

    def get_active_profile_summary(self) -> MaybeAwaitable: ...

    def create_profile(self, values: Mapping[str, Any]) -> MaybeAwaitable: ...

    def update_profile(self, profile_id: str, values: Mapping[str, Any]) -> MaybeAwaitable: ...

    def activate_profile(self, profile_id: str) -> MaybeAwaitable: ...

    def get_provider_status(self) -> MaybeAwaitable: ...

    def check_runtime(self) -> MaybeAwaitable: ...

    def list_jobs(self, filters: Mapping[str, Any]) -> MaybeAwaitable: ...

    def get_job_review(self, job_id: str) -> MaybeAwaitable: ...

    def get_resume(self, job_id: str) -> MaybeAwaitable: ...

    def list_applications(self, filters: Mapping[str, Any]) -> MaybeAwaitable: ...

    def add_job(
        self,
        url: str,
        details: Mapping[str, Any],
        progress: ProgressSink | None = None,
    ) -> MaybeAwaitable: ...

    def discover_jobs(self, progress: ProgressSink | None = None) -> MaybeAwaitable: ...

    def review_job(
        self,
        job_id: str,
        rerun: bool = False,
        progress: ProgressSink | None = None,
    ) -> MaybeAwaitable: ...

    def answer_verification(self, job_id: str, question_id: str, answer: str) -> MaybeAwaitable: ...

    def get_answer_history(self, job_id: str, question_id: str | None = None) -> MaybeAwaitable: ...

    def decide_job(
        self,
        job_id: str,
        decision: str,
        progress: ProgressSink | None = None,
    ) -> MaybeAwaitable: ...

    def generate_resume(
        self, job_id: str, progress: ProgressSink | None = None
    ) -> MaybeAwaitable: ...

    def retry_resume(self, job_id: str, progress: ProgressSink | None = None) -> MaybeAwaitable: ...

    def revise_resume(
        self,
        job_id: str,
        feedback: str,
        progress: ProgressSink | None = None,
    ) -> MaybeAwaitable: ...

    def approve_resume(self, job_id: str, resume_run_id: str) -> MaybeAwaitable: ...

    def reject_resume(
        self,
        job_id: str,
        resume_run_id: str,
        feedback: str = "",
    ) -> MaybeAwaitable: ...

    def export_artifact(self, artifact_id: str, destination: str) -> MaybeAwaitable: ...

    def open_artifact(self, artifact_id: str) -> MaybeAwaitable: ...

    def mark_applied(self, job_id: str) -> MaybeAwaitable: ...

    def record_outcome(self, job_id: str, outcome: str) -> MaybeAwaitable: ...

    def submit_application(
        self,
        job_id: str,
        follow_up_date: str,
        note: str = "",
    ) -> MaybeAwaitable: ...

    def record_application_stage(
        self,
        job_id: str,
        values: Mapping[str, Any],
    ) -> MaybeAwaitable: ...

    def get_application(self, job_id: str) -> MaybeAwaitable: ...

    def list_due_followups(self) -> MaybeAwaitable: ...

    def resolve_followup(self, follow_up_id: str, note: str = "") -> MaybeAwaitable:
        """Resolve a follow-up within the facade's active profile."""
        ...

    def reschedule_followup(
        self,
        follow_up_id: str,
        due_date: str,
        note: str = "",
    ) -> MaybeAwaitable:
        """Reschedule a follow-up within the facade's active profile."""
        ...

    def import_evidence(self, request: Mapping[str, str]) -> MaybeAwaitable: ...

    def configure_resume_source(
        self,
        values: Mapping[str, Any],
        expected_revision: int | None = None,
    ) -> MaybeAwaitable: ...

    def sync_resume_source(self, progress: ProgressSink | None = None) -> MaybeAwaitable: ...

    def preview_legacy_import(self) -> MaybeAwaitable: ...

    def apply_legacy_import(self) -> MaybeAwaitable: ...


ProfileCollection: TypeAlias = Sequence[Any]
