"""Composition root for local RoleLoop adapters."""

from __future__ import annotations

from typing import TYPE_CHECKING

from roleloop.application import RoleLoopService
from roleloop.infrastructure.agent_providers import ProfileAgentProviderRegistry
from roleloop.infrastructure.artifacts import FileSystemArtifactAccess, FileSystemArtifactStore
from roleloop.infrastructure.contract import (
    ContractMasterResumeRenderer,
    ContractResumeSourceSynchronizer,
    TrustedResumeContractRunner,
)
from roleloop.infrastructure.database import SQLiteDatabase
from roleloop.infrastructure.evidence import LocalEvidenceExtractor
from roleloop.infrastructure.paths import RoleLoopPaths
from roleloop.infrastructure.pdf import StrictPdfInspector
from roleloop.infrastructure.process_lock import ManagedRoleLoopService, RoleLoopProcessLock
from roleloop.infrastructure.resume_sources import GitResumeSourceSynchronizer
from roleloop.infrastructure.runtime import (
    RuntimeDoctor,
    RuntimeSettings,
    SystemClock,
    UUID4Generator,
)
from roleloop.infrastructure.uow import SQLiteUnitOfWorkFactory

if TYPE_CHECKING:
    from roleloop.adapters.tui import RoleLoopApp


def build_service(paths: RoleLoopPaths | None = None) -> ManagedRoleLoopService:
    """Build the complete local RoleLoop service from runtime adapters."""

    resolved_paths = paths or RoleLoopPaths.from_environment()
    process_lock = RoleLoopProcessLock.acquire(
        resolved_paths.process_lock_path,
        database_path=resolved_paths.database_path,
    )
    try:
        resolved_paths.ensure_directories()
        return _build_locked_service(resolved_paths, process_lock)
    except BaseException:
        process_lock.close()
        raise


def _build_locked_service(
    resolved_paths: RoleLoopPaths,
    process_lock: RoleLoopProcessLock,
) -> ManagedRoleLoopService:
    ids = UUID4Generator()
    settings = RuntimeSettings.from_environment()
    artifact_store = FileSystemArtifactStore(
        resolved_paths.artifacts_dir,
        id_generator=ids,
    )
    artifact_access = FileSystemArtifactAccess(resolved_paths.artifacts_dir)
    contract_runner = TrustedResumeContractRunner(
        command_timeout_seconds=settings.contract_timeout_seconds
    )
    pdf_inspector = StrictPdfInspector(maximum_pages=5)
    service = ManagedRoleLoopService(
        SQLiteUnitOfWorkFactory(SQLiteDatabase(resolved_paths.database_path)),
        SystemClock(),
        ids,
        evidence_extractor=LocalEvidenceExtractor(),
        artifact_store=artifact_store,
        artifact_reader=artifact_access,
        artifact_exporter=artifact_access,
        resume_source_synchronizer=ContractResumeSourceSynchronizer(
            GitResumeSourceSynchronizer(resolved_paths.resume_sources_dir),
            contract_runner,
        ),
        agent_registry=ProfileAgentProviderRegistry(settings),
        master_resume_renderer=ContractMasterResumeRenderer(
            contract_runner,
            artifact_access,
            pdf_inspector,
        ),
        pdf_inspector=pdf_inspector,
        runtime_doctor=RuntimeDoctor(),
    )
    service.attach_process_lock(process_lock)
    # Recovery is safe only after this process exclusively owns the state.
    service.recover_interrupted_runs()
    return service


def build_tui_app(service: RoleLoopService | None = None) -> RoleLoopApp:
    """Build the Textual adapter lazily so headless commands do not import it."""

    from roleloop.adapters.tui import RoleLoopApp
    from roleloop.adapters.tui.facade import ApplicationServiceFacade

    settings = RuntimeSettings.from_environment()
    return RoleLoopApp(
        ApplicationServiceFacade(
            service or build_service(),
            startup_defaults=_tui_startup_defaults(settings),
        )
    )


def _tui_startup_defaults(settings: RuntimeSettings) -> dict[str, object]:
    profile: dict[str, object] = {
        "agent_provider": (
            settings.provider_default.value if settings.provider_default is not None else None
        ),
        "agent_configurations": tuple(
            {
                "kind": configuration.kind.value,
                "provider": (
                    settings.provider_default.value
                    if settings.provider_default is not None
                    else None
                ),
                "model": configuration.model,
                "reasoning_effort": configuration.reasoning_effort,
            }
            for configuration in (
                settings.provider.scout,
                settings.provider.reviewer,
                settings.provider.resume,
            )
        ),
    }
    source: dict[str, object] | None = None
    if settings.resume_repository is not None:
        source = {
            "repository": settings.resume_repository,
            "kind": (
                settings.resume_repository_kind.value
                if settings.resume_repository_kind is not None
                else "local_git"
            ),
            "ref": settings.resume_ref,
        }
    return {"profile": profile, "resume_source": source}


__all__ = ["build_service", "build_tui_app"]
