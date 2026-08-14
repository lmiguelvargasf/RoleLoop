"""Persistent workspace shell for Inbox, Applications, and Settings."""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar, cast

from textual import events, on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Button, ContentSwitcher, Footer

from .applications import ApplicationsView
from .inbox import InboxView
from .modals import AddJobModal
from .presentation import field, operation_error
from .settings import SettingsView
from .widgets import OperationStrip, RoleLoopHeader, WorkspaceNavigation

if TYPE_CHECKING:
    from .app import RoleLoopApp


class WorkspaceScreen(Screen[None]):
    HELP_TEXT: ClassVar[str] = (
        "Workspace: 1 inbox · 2 applications · 3 settings · d Scout discovery · "
        "n inspect job URL · Enter open review. Review: a Analyze/Rerun · t Tailor · "
        "w Watch · s Skip · v request changes · p approve exact PDF · "
        "u record submission · l record stage · r refresh · Esc back. q quits."
    )

    BINDINGS: ClassVar = [
        Binding("1", "show_view('inbox')", "Inbox"),
        Binding("2", "show_view('applications')", "Applications"),
        Binding("3", "show_view('settings')", "Settings"),
        Binding("d", "discover", "Discover"),
        Binding("n", "add_job", "Add URL"),
        Binding("p", "show_view('settings')", "Profile", show=False),
        Binding("?", "help", "Help"),
        Binding("q", "request_quit", "Quit"),
    ]

    def __init__(self, summary: object) -> None:
        super().__init__()
        self.summary = summary

    @property
    def roleloop_app(self) -> RoleLoopApp:
        return cast("RoleLoopApp", self.app)

    def compose(self) -> ComposeResult:
        with Vertical(id="workspace-shell"):
            yield RoleLoopHeader(self._profile_name())
            yield WorkspaceNavigation(id="workspace-navigation")
            with ContentSwitcher(initial="inbox-view", id="workspace-content"):
                yield InboxView(id="inbox-view")
                yield ApplicationsView(id="applications-view")
                yield SettingsView(id="settings-view")
            yield OperationStrip(id="workspace-operation")
            yield Footer()

    def on_mount(self) -> None:
        self.update_summary(self.summary)
        self._apply_responsive_class(self.size.width)

    def _profile_name(self) -> str:
        profile = field(self.summary, "profile", default=self.summary)
        return str(field(profile, "name", default="No active profile"))

    def update_summary(self, summary: object) -> None:
        self.summary = summary
        profile = field(summary, "profile", default=summary)
        capabilities = field(summary, "provider_capabilities", "capabilities", default={})
        configured = sum(1 for value in dict(capabilities or {}).values() if value)
        total = len(dict(capabilities or {}))
        capability_text = f"providers {configured}/{total}" if total else "manual mode"
        self.query_one(RoleLoopHeader).set_context(
            str(field(profile, "name", default="No active profile")), capability_text
        )

    @on(events.Resize)
    def resized(self, event: events.Resize) -> None:
        self._apply_responsive_class(event.size.width)

    def _apply_responsive_class(self, width: int) -> None:
        self.set_class(width < 110, "compact")
        self.set_class(width < 72, "narrow")

    @on(Button.Pressed, ".nav-button")
    def navigate_button(self, event: Button.Pressed) -> None:
        if event.button.id:
            self.action_show_view(event.button.id.removeprefix("nav-"))

    def action_show_view(self, name: str) -> None:
        if name not in {"inbox", "applications", "settings"}:
            return
        self.query_one("#workspace-content", ContentSwitcher).current = f"{name}-view"
        self.query_one(WorkspaceNavigation).select(name)
        view = self.query_one(f"#{name}-view")
        refresh = getattr(view, "refresh_data", None)
        if callable(refresh):
            refresh()

    def action_discover(self) -> None:
        self.roleloop_app.start_operation(
            "discovery",
            "Discover jobs",
            "discover_jobs",
        )

    def action_add_job(self) -> None:
        self.run_worker(self._add_job, exit_on_error=False)  # type: ignore[arg-type]

    async def _add_job(self) -> None:
        result = await self.app.push_screen_wait(AddJobModal())
        if result is None:
            return
        try:
            await self.roleloop_app.invoke("add_job", str(result["url"]), dict(result["details"]))
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Job not added")
            return
        self.roleloop_app.notify("Job added to the active profile.", title="Inbox")
        self.query_one(InboxView).refresh_data()

    def action_help(self) -> None:
        self.roleloop_app.notify(
            self.HELP_TEXT,
            title="Keyboard map",
            timeout=8,
        )

    def action_request_quit(self) -> None:
        self.roleloop_app.request_quit()

    def refresh_all(self) -> None:
        self.query_one(InboxView).refresh_data()
        self.query_one(ApplicationsView).refresh_data()
        self.query_one(SettingsView).refresh_data()
