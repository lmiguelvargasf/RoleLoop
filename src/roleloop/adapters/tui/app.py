"""Textual application adapter for RoleLoop."""

from __future__ import annotations

import asyncio
import inspect
from functools import partial
from typing import Any

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import LoadingIndicator, Static

from .messages import OperationFinished, OperationProgress
from .modals import ConfirmActionModal, ProfileModal, ResumeSourceModal
from .presentation import as_items, enum_text, field, item_id, operation_error, progress_parts
from .protocols import RoleLoopFacade
from .review import JobReviewScreen
from .widgets import OperationStrip
from .workspace import WorkspaceScreen


class RoleLoopApp(App[None]):
    """Primary human interface, backed entirely by application services."""

    CSS_PATH = "roleloop.tcss"
    TITLE = "RoleLoop"
    SUB_TITLE = "Evidence-led job search"

    def __init__(self, services: RoleLoopFacade) -> None:
        super().__init__()
        self.services = services
        self.active_summary: Any | None = None
        self.active_operations: dict[str, str] = {}

    def compose(self) -> ComposeResult:
        yield Static("ROLE/LOOP", id="startup-title", markup=False)
        yield LoadingIndicator(id="startup-loading")
        yield Static("Opening the active search profile…", id="startup-state", markup=False)

    def on_mount(self) -> None:
        self.run_worker(
            self._bootstrap,
            group="bootstrap",
            exclusive=True,
            exit_on_error=False,
        )

    def on_unmount(self) -> None:
        """Release authoritative process ownership after Textual workers stop."""

        close = getattr(self.services, "close", None)
        if callable(close):
            close()

    async def invoke(self, method_name: str, *args: Any, **kwargs: Any) -> Any:
        """Invoke a sync or async facade method without blocking Textual."""

        method = getattr(self.services, method_name)
        if inspect.iscoroutinefunction(method):
            return await method(*args, **kwargs)
        result = await asyncio.to_thread(partial(method, *args, **kwargs))
        if inspect.isawaitable(result):
            return await result
        return result

    async def invoke_optional(self, method_name: str, *args: Any, **kwargs: Any) -> Any | None:
        if not hasattr(self.services, method_name):
            return None
        return await self.invoke(method_name, *args, **kwargs)

    async def _bootstrap(self) -> None:
        try:
            profiles = as_items(await self.invoke("list_profiles"))
            summary = await self.invoke("get_active_profile_summary")
        except BaseException as error:
            profiles = []
            summary = None
            if "not found" not in str(error).lower() and "active" not in str(error).lower():
                self.query_one("#startup-state", Static).update(operation_error(error))
        if summary is None:
            defaults = await self.invoke_optional("get_startup_defaults") or {}
            profile_defaults = field(defaults, "profile", default=None)
            values = await self.push_screen_wait(ProfileModal(profile_defaults, onboarding=True))
            if values is None:
                self.exit()
                return
            try:
                profile = await self.invoke("create_profile", values)
                profile_id = item_id(profile, "profile_id")
                if not profile_id and profiles:
                    profile_id = item_id(profiles[0], "profile_id")
                if profile_id:
                    await self.invoke("activate_profile", profile_id)
                source_defaults = field(defaults, "resume_source", default=None)
                source_request = await self.push_screen_wait(ResumeSourceModal(source_defaults))
                if source_request is not None:
                    try:
                        await self.invoke("configure_resume_source", source_request)
                    except BaseException as error:
                        self.notify(
                            operation_error(error),
                            title="Master résumé not configured",
                            severity="error",
                            timeout=8,
                        )
                summary = await self.invoke("get_active_profile_summary")
            except BaseException as error:
                self.query_one("#startup-state", Static).update(operation_error(error))
                return
        self.active_summary = summary
        # Keep Textual's implicit startup screen on the stack while the
        # workspace mounts. Replacing the only screen from this worker creates
        # a brief empty-stack window in which Input reactive watchers fail.
        self.push_screen(WorkspaceScreen(summary))

    def open_job_review(self, job_id: str) -> None:
        self.push_screen(JobReviewScreen(job_id))

    def start_operation(
        self,
        key: str,
        label: str,
        method_name: str,
        *args: Any,
        job_id: str | None = None,
    ) -> bool:
        """Start a durable app-scoped operation once and keep navigation live."""

        if key in self.active_operations:
            self.notify(
                f"{self.active_operations[key]} is already running.",
                title="Background work",
                severity="warning",
            )
            return False
        self.active_operations[key] = label
        self._show_progress(label, "queued")
        self.run_worker(
            partial(self._run_operation, key, label, method_name, args, job_id),
            group=f"operation:{key}",
            exclusive=False,
            exit_on_error=False,
        )
        return True

    async def _run_operation(
        self,
        key: str,
        label: str,
        method_name: str,
        args: tuple[Any, ...],
        job_id: str | None,
    ) -> None:
        def progress(update: Any) -> None:
            self.post_message(OperationProgress(label, update, job_id=job_id))

        try:
            result = await self.invoke(method_name, *args, progress=progress)
            operation_result = field(result, "resume_run", default=result)
            stage = enum_text(field(operation_result, "stage"), "")
            if stage in {"failed", "interrupted"}:
                detail = str(
                    field(
                        operation_result,
                        "error_message",
                        "error",
                        default=f"{label} ended as {stage}.",
                    )
                )
                raise RuntimeError(detail)
        except BaseException as error:
            self.post_message(OperationFinished(label, job_id=job_id, error=error))
        else:
            self.post_message(OperationFinished(label, job_id=job_id))
        finally:
            self.active_operations.pop(key, None)

    @on(OperationProgress)
    def operation_progressed(self, message: OperationProgress) -> None:
        stage, detail = progress_parts(message.update)
        self._show_progress(message.operation, stage, detail)
        if (
            message.job_id
            and isinstance(self.screen, JobReviewScreen)
            and self.screen.job_id == message.job_id
        ):
            self.screen.refresh_data(analyze=False)

    @on(OperationFinished)
    def operation_finished(self, message: OperationFinished) -> None:
        if message.error is not None:
            error_message = operation_error(message.error)
            self.report_error(error_message, title=f"{message.operation} failed")
        else:
            if (
                message.job_id
                and isinstance(self.screen, JobReviewScreen)
                and self.screen.job_id == message.job_id
            ):
                self.screen.clear_error()
            self._show_ready(f"{message.operation} complete")
            self.notify(
                f"{message.operation} complete.",
                title="Background work",
                severity="information",
            )
        self.refresh_visible_data(job_id=message.job_id)

    def _operation_strips(self) -> list[OperationStrip]:
        strips: list[OperationStrip] = []
        for screen in self.screen_stack:
            strips.extend(screen.query(OperationStrip))
        return strips

    def _show_progress(self, operation: str, stage: str, detail: str = "") -> None:
        for strip in self._operation_strips():
            strip.show_progress(operation, stage, detail)

    def _show_ready(self, message: str = "Ready") -> None:
        for strip in self._operation_strips():
            strip.show_ready(message)

    def report_error(self, message: str, *, title: str = "RoleLoop") -> None:
        for strip in self._operation_strips():
            strip.show_error(message)
        if isinstance(self.screen, JobReviewScreen):
            self.screen.show_error(message)
        self.notify(message, title=title, severity="error", timeout=8)

    def refresh_visible_data(self, *, job_id: str | None = None) -> None:
        for screen in self.screen_stack:
            if isinstance(screen, WorkspaceScreen):
                screen.refresh_all()
            elif isinstance(screen, JobReviewScreen) and (
                job_id is None or screen.job_id == job_id
            ):
                screen.refresh_data(analyze=False)

    def refresh_workspace(self) -> None:
        self.run_worker(
            self._refresh_workspace,
            group="active-profile-refresh",
            exclusive=True,
            exit_on_error=False,
        )

    async def _refresh_workspace(self) -> None:
        try:
            summary = await self.invoke("get_active_profile_summary")
        except BaseException as error:
            self.report_error(operation_error(error), title="Settings not refreshed")
            return
        self.active_summary = summary
        for screen in self.screen_stack:
            if isinstance(screen, WorkspaceScreen):
                screen.update_summary(summary)
                screen.refresh_all()

    def update_header(self, summary: Any) -> None:
        self.active_summary = summary
        for screen in self.screen_stack:
            if isinstance(screen, WorkspaceScreen):
                screen.update_summary(summary)

    def request_quit(self) -> None:
        if not self.active_operations:
            self.exit()
            return
        self.run_worker(self._confirm_quit, exit_on_error=False)

    async def _confirm_quit(self) -> None:
        operations = ", ".join(self.active_operations.values())
        confirmed = await self.push_screen_wait(
            ConfirmActionModal(
                "Quit while work is running?",
                f"Active: {operations}\n\n"
                "Interrupted work remains visible and retryable on the next launch.",
                "Quit RoleLoop",
                danger=True,
            )
        )
        if confirmed:
            self.exit()


def run_tui(services: RoleLoopFacade) -> None:
    """Run RoleLoop's primary interactive adapter."""

    RoleLoopApp(services).run()
