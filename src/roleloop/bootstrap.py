"""Composition root for local RoleLoop adapters."""

from __future__ import annotations

from typing import TYPE_CHECKING

from roleloop.application import RoleLoopService
from roleloop.infrastructure.artifacts import FileSystemArtifactStore
from roleloop.infrastructure.database import SQLiteDatabase
from roleloop.infrastructure.evidence import LocalEvidenceExtractor
from roleloop.infrastructure.paths import RoleLoopPaths
from roleloop.infrastructure.runtime import SystemClock, UUID4Generator
from roleloop.infrastructure.uow import SQLiteUnitOfWorkFactory

if TYPE_CHECKING:
    from roleloop.adapters.tui import RoleLoopApp


def build_service(paths: RoleLoopPaths | None = None) -> RoleLoopService:
    """Build the provider-ready local application service.

    Live discovery, review, résumé generation, validation, and compilation are
    deliberately left unconfigured. Local evidence extraction and immutable
    artifact storage are fully operational.
    """

    resolved_paths = paths or RoleLoopPaths.from_environment()
    resolved_paths.ensure_directories()
    ids = UUID4Generator()
    service = RoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(resolved_paths.database_path)),
        SystemClock(),
        ids,
        evidence_extractor=LocalEvidenceExtractor(),
        artifact_store=FileSystemArtifactStore(
            resolved_paths.artifacts_dir,
            id_generator=ids,
        ),
    )
    service.recover_interrupted_runs()
    return service


def build_tui_app(service: RoleLoopService | None = None) -> RoleLoopApp:
    """Build the Textual adapter lazily so headless commands do not import it."""

    from roleloop.adapters.tui import RoleLoopApp
    from roleloop.adapters.tui.facade import ApplicationServiceFacade

    return RoleLoopApp(ApplicationServiceFacade(service or build_service()))


__all__ = ["build_service", "build_tui_app"]
