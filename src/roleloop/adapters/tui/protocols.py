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

    def get_active_profile_summary(self) -> MaybeAwaitable: ...

    def create_profile(self, values: Mapping[str, Any]) -> MaybeAwaitable: ...

    def update_profile(self, profile_id: str, values: Mapping[str, Any]) -> MaybeAwaitable: ...

    def activate_profile(self, profile_id: str) -> MaybeAwaitable: ...

    def list_jobs(self, filters: Mapping[str, Any]) -> MaybeAwaitable: ...

    def get_job_review(self, job_id: str) -> MaybeAwaitable: ...

    def list_applications(self, filters: Mapping[str, Any]) -> MaybeAwaitable: ...

    def add_job(self, url: str, details: Mapping[str, Any]) -> MaybeAwaitable: ...

    def discover_jobs(self, progress: ProgressSink | None = None) -> MaybeAwaitable: ...

    def review_job(self, job_id: str, progress: ProgressSink | None = None) -> MaybeAwaitable: ...

    def answer_verification(self, job_id: str, question_id: str, answer: str) -> MaybeAwaitable: ...

    def decide_job(self, job_id: str, decision: str) -> MaybeAwaitable: ...

    def generate_resume(
        self, job_id: str, progress: ProgressSink | None = None
    ) -> MaybeAwaitable: ...

    def mark_applied(self, job_id: str) -> MaybeAwaitable: ...

    def record_outcome(self, job_id: str, outcome: str) -> MaybeAwaitable: ...

    def import_evidence(self, request: Mapping[str, str]) -> MaybeAwaitable: ...


ProfileCollection: TypeAlias = Sequence[Any]
