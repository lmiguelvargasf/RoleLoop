"""Messages used only by the Textual adapter."""

from __future__ import annotations

from typing import Any

from textual.message import Message


class OperationProgress(Message):
    """Progress emitted by a framework-independent application use case."""

    def __init__(
        self,
        operation: str,
        update: Any,
        *,
        job_id: str | None = None,
    ) -> None:
        super().__init__()
        self.operation = operation
        self.update = update
        self.job_id = job_id


class OperationFinished(Message):
    """Completion of an app-scoped, long-running operation."""

    def __init__(
        self,
        operation: str,
        *,
        job_id: str | None = None,
        error: BaseException | None = None,
    ) -> None:
        super().__init__()
        self.operation = operation
        self.job_id = job_id
        self.error = error
