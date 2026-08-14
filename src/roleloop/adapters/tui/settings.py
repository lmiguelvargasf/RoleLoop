"""Search-profile management and active settings summary."""

from __future__ import annotations

import asyncio
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, cast

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Label, Static

from .modals import ConfirmActionModal, EvidencePathModal, ProfileModal
from .presentation import (
    as_items,
    compact_date,
    csv_text,
    enum_text,
    evidence_name,
    field,
    item_id,
    operation_error,
)

if TYPE_CHECKING:
    from .app import RoleLoopApp


class SettingsView(Horizontal):
    BINDINGS: ClassVar = [
        Binding("c", "create_profile", "Create profile", show=False),
        Binding("e", "edit_profile", "Edit profile", show=False),
        Binding("a", "activate_profile", "Activate", show=False),
        Binding("i", "import_evidence", "Import evidence", show=False),
        Binding("r", "refresh", "Refresh", show=False),
    ]

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self.profiles: dict[str, Any] = {}
        self.selected_profile_id: str | None = None
        self.summary: Any | None = None
        self._request_generation = 0

    @property
    def roleloop_app(self) -> RoleLoopApp:
        return cast("RoleLoopApp", self.app)

    def compose(self) -> ComposeResult:
        with Vertical(id="profiles-pane"):
            yield Label("SEARCH PROFILES", classes="section-kicker")
            yield DataTable(id="profiles-table", cursor_type="row", zebra_stripes=True)
            with Horizontal(classes="button-row"):
                yield Button("Create", id="profile-create")
                yield Button("Edit", id="profile-edit")
                yield Button("Activate", id="profile-activate", variant="primary")
        with Vertical(id="settings-summary-pane"):
            yield Label("ACTIVE PROFILE", classes="section-kicker")
            yield Static("Loading settings…", id="settings-summary", markup=False)
            yield Button(
                "Import / replace résumé evidence",
                id="evidence-import",
                variant="primary",
            )
            yield Static("", id="settings-error", classes="form-error", markup=False)

    def on_mount(self) -> None:
        self.query_one("#profiles-table", DataTable).add_columns("Profile", "Targets", "Active")

    def on_show(self) -> None:
        self.refresh_data()

    def refresh_data(self) -> None:
        self._request_generation += 1
        generation = self._request_generation
        self.run_worker(
            partial(self._load, generation),  # type: ignore[arg-type]
            group="settings-read",
            exclusive=True,
            exit_on_error=False,
        )

    async def _load(self, generation: int) -> None:
        try:
            profiles, summary = await asyncio.gather(
                self.roleloop_app.invoke("list_profiles"),
                self.roleloop_app.invoke("get_active_profile_summary"),
            )
        except BaseException as error:
            if generation == self._request_generation:
                self.query_one("#settings-error", Static).update(operation_error(error))
            return
        if generation != self._request_generation:
            return
        self.summary = summary
        self._render_profiles(as_items(profiles))
        self._render_summary(summary)

    def _render_profiles(self, profiles: list[Any]) -> None:
        table = self.query_one("#profiles-table", DataTable)
        table.clear()
        self.profiles.clear()
        active_profile = field(self.summary, "profile", default=None)
        active_id = item_id(active_profile, "profile_id")
        for profile in profiles:
            profile_id = item_id(profile, "profile_id")
            if not profile_id:
                continue
            self.profiles[profile_id] = profile
            is_active = bool(field(profile, "is_active", default=False)) or profile_id == active_id
            table.add_row(
                str(field(profile, "name", default="Unnamed profile")),
                csv_text(field(profile, "target_roles", default=())),
                "ACTIVE" if is_active else "",
                key=profile_id,
            )
        if self.profiles:
            self.selected_profile_id = (
                self.selected_profile_id
                if self.selected_profile_id in self.profiles
                else active_id
                if active_id in self.profiles
                else next(iter(self.profiles))
            )
            table.move_cursor(row=list(self.profiles).index(self.selected_profile_id))

    def _render_summary(self, summary: Any) -> None:
        profile = field(summary, "profile", default=summary)
        evidence = field(summary, "evidence", default=None)
        evidence_artifact = field(evidence, "source_artifact", "artifact", default=None)
        capabilities = field(summary, "provider_capabilities", "capabilities", default={})
        capability_lines = []
        for name, available in dict(capabilities or {}).items():
            capability_lines.append(f"  {name}: {'configured' if available else 'not configured'}")
        if not capability_lines:
            capability_lines.append("  No live providers configured")
        evidence_line = evidence_name(evidence)
        if evidence is not None:
            evidence_line += f" / version {item_id(evidence, 'evidence_id') or '-'}"
        summary_text = "\n".join(
            (
                str(field(profile, "name", default="No active profile")),
                "",
                f"Target roles       {csv_text(field(profile, 'target_roles', default=())) or '-'}",
                f"Locations          {csv_text(field(profile, 'locations', default=())) or '-'}",
                f"Remote preference  {enum_text(field(profile, 'remote_preference'), 'any')}",
                "Employment types   "
                f"{csv_text(field(profile, 'employment_types', default=())) or '-'}",
                f"Seniority          {csv_text(field(profile, 'seniority', default=())) or '-'}",
                f"Salary floor       {field(profile, 'annual_salary_floor', default='-') or '-'} "
                f"{field(profile, 'salary_currency', default='USD')}",
                "Include keywords   "
                f"{csv_text(field(profile, 'include_keywords', default=())) or '-'}",
                "Exclude keywords   "
                f"{csv_text(field(profile, 'exclude_keywords', default=())) or '-'}",
                f"Constraints        {field(profile, 'constraints', default='') or '-'}",
                "",
                f"Résumé evidence    {evidence_line}",
                f"Evidence imported  {compact_date(field(evidence, 'created_at'))}",
                f"Evidence checksum  {field(evidence_artifact, 'checksum', default='-')}",
                f"Managed artifact   {field(evidence_artifact, 'uri', default='-')}",
                "",
                "Provider readiness",
                *capability_lines,
            )
        )
        self.query_one("#settings-summary", Static).update(summary_text)
        self.roleloop_app.update_header(summary)

    @on(DataTable.RowHighlighted, "#profiles-table")
    def select_profile(self, event: DataTable.RowHighlighted) -> None:
        self.selected_profile_id = str(event.row_key.value)

    def _cursor_profile_id(self) -> str | None:
        """Resolve actions from the visible cursor, not a delayed highlight message."""

        table = self.query_one("#profiles-table", DataTable)
        if table.row_count:
            row_key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key
            profile_id = str(row_key.value)
            if profile_id in self.profiles:
                self.selected_profile_id = profile_id
                return profile_id
        return self.selected_profile_id

    @on(Button.Pressed, "#profile-create")
    def create_button(self) -> None:
        self.action_create_profile()

    @on(Button.Pressed, "#profile-edit")
    def edit_button(self) -> None:
        self.action_edit_profile()

    @on(Button.Pressed, "#profile-activate")
    def activate_button(self) -> None:
        self.action_activate_profile()

    @on(Button.Pressed, "#evidence-import")
    def import_button(self) -> None:
        self.action_import_evidence()

    def action_refresh(self) -> None:
        self.refresh_data()

    def action_create_profile(self) -> None:
        self.run_worker(self._create_profile, exit_on_error=False)  # type: ignore[arg-type]

    async def _create_profile(self) -> None:
        values = await self.app.push_screen_wait(ProfileModal())
        if values is None:
            return
        try:
            await self.roleloop_app.invoke("create_profile", values)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Profile not created")
        self.refresh_data()

    def action_edit_profile(self) -> None:
        profile_id = self._cursor_profile_id()
        if profile_id:
            self.run_worker(
                partial(  # type: ignore[arg-type]
                    self._edit_profile, profile_id
                ),
                exit_on_error=False,
            )

    async def _edit_profile(self, profile_id: str) -> None:
        profile = self.profiles[profile_id]
        values = await self.app.push_screen_wait(ProfileModal(profile))
        if values is None:
            return
        try:
            await self.roleloop_app.invoke("update_profile", profile_id, values)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Profile not updated")
        self.refresh_data()

    def action_activate_profile(self) -> None:
        profile_id = self._cursor_profile_id()
        if profile_id:
            self.run_worker(
                partial(  # type: ignore[arg-type]
                    self._activate_profile, profile_id
                ),
                exit_on_error=False,
            )

    async def _activate_profile(self, profile_id: str) -> None:
        try:
            await self.roleloop_app.invoke("activate_profile", profile_id)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Profile not activated")
            return
        self.roleloop_app.refresh_workspace()

    def action_import_evidence(self) -> None:
        self.run_worker(self._import_evidence, exit_on_error=False)  # type: ignore[arg-type]

    async def _import_evidence(self) -> None:
        request = await self.app.push_screen_wait(EvidencePathModal())
        if not request:
            return
        candidate = (
            Path(request["path"]).name if request["kind"] == "path" else request["source_name"]
        )
        evidence = field(self.summary, "evidence", default=None)
        if evidence is not None:
            confirmed = await self.app.push_screen_wait(
                ConfirmActionModal(
                    "Replace résumé evidence?",
                    "\n".join(
                        (
                            f"Current: {evidence_name(evidence)}",
                            f"Import:  {candidate}",
                            "",
                            "RoleLoop will create a new immutable version. Existing "
                            "résumé artifacts keep their provenance.",
                        )
                    ),
                    "Import new version",
                    danger=True,
                )
            )
            if not confirmed:
                return
        try:
            await self.roleloop_app.invoke("import_evidence", request)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Evidence not imported")
        self.refresh_data()
