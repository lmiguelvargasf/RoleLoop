"""Reusable widgets for RoleLoop's evidence-desk interface."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.widgets import Button, Static


class RoleLoopHeader(Static):
    """Brand, active profile, and provider readiness in a single quiet line."""

    def __init__(self, profile_name: str = "No active profile") -> None:
        super().__init__(id="roleloop-header", markup=False)
        self.profile_name = profile_name
        self.capability_text = ""

    def set_context(self, profile_name: str, capability_text: str = "") -> None:
        self.profile_name = profile_name
        self.capability_text = capability_text
        suffix = f"  /  {capability_text}" if capability_text else ""
        self.update(f"ROLE/LOOP  /  {profile_name}{suffix}")

    def on_mount(self) -> None:
        self.set_context(self.profile_name, self.capability_text)


class WorkspaceNavigation(Horizontal):
    def compose(self) -> ComposeResult:
        yield Button("1  Inbox", id="nav-inbox", classes="nav-button -active")
        yield Button("2  Applications", id="nav-applications", classes="nav-button")
        yield Button("3  Settings", id="nav-settings", classes="nav-button")

    def select(self, name: str) -> None:
        for button in self.query(".nav-button"):
            button.set_class(button.id == f"nav-{name}", "-active")


class OperationStrip(Static):
    """Persistent, non-authoritative feedback for app-scoped work."""

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__("Ready", id=id, classes="operation-strip", markup=False)

    def show_progress(self, operation: str, stage: str, detail: str = "") -> None:
        suffix = f" — {detail}" if detail else ""
        self.update(f"{operation}: {stage}{suffix}")
        self.remove_class("-error")
        self.add_class("-busy")

    def show_error(self, message: str) -> None:
        self.update(message)
        self.remove_class("-busy")
        self.add_class("-error")

    def show_ready(self, message: str = "Ready") -> None:
        self.update(message)
        self.remove_class("-busy", "-error")
