"""Typed failures exposed by the application boundary."""

from __future__ import annotations


class ApplicationError(Exception):
    code = "application_error"

    def __init__(self, message: str, *, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ValidationError(ApplicationError):
    code = "validation_error"


class NotFoundError(ApplicationError):
    code = "not_found"


class RevisionConflictError(ApplicationError):
    code = "revision_conflict"


class InvalidTransitionError(ApplicationError):
    code = "invalid_transition"


class ConcurrentInstanceError(ApplicationError):
    """The authoritative local state is already owned by another process."""

    code = "concurrent_instance"


class ProviderUnavailableError(ApplicationError):
    code = "provider_unavailable"


class ProviderFailureError(ApplicationError):
    code = "provider_failure"


class ArtifactError(ApplicationError):
    code = "artifact_error"
