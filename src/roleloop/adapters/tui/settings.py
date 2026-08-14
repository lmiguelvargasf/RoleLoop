"""Search-profile management and active settings summary."""

from __future__ import annotations

import asyncio
from functools import partial
from typing import TYPE_CHECKING, Any, ClassVar, cast

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Label, Static

from .modals import ConfirmActionModal, ProfileModal, ResumeSourceModal
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
        Binding("m", "configure_resume_source", "Master résumé source", show=False),
        Binding("s", "sync_resume_source", "Sync master résumé", show=False),
        Binding("l", "preview_legacy_import", "Preview legacy import", show=False),
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
            with Horizontal(classes="button-row"):
                yield Button("Configure master résumé", id="resume-source-configure")
                yield Button(
                    "Sync master résumé",
                    id="resume-source-sync",
                    variant="primary",
                    disabled=True,
                )
                yield Button("Run Doctor", id="runtime-doctor")
            with Horizontal(classes="button-row"):
                yield Button("Preview legacy history", id="legacy-preview")
                yield Button("Import legacy history", id="legacy-apply")
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
            profiles, summary, provider_status, readiness = await asyncio.gather(
                self.roleloop_app.invoke("list_profiles"),
                self.roleloop_app.invoke("get_active_profile_summary"),
                self.roleloop_app.invoke_optional("get_provider_status"),
                self.roleloop_app.invoke_optional("check_runtime"),
            )
        except BaseException as error:
            if generation == self._request_generation:
                self.query_one("#settings-error", Static).update(operation_error(error))
            return
        if generation != self._request_generation:
            return
        self.summary = summary
        self._render_profiles(as_items(profiles))
        self._render_summary(summary, provider_status, readiness)

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

    def _render_summary(self, summary: Any, provider_status: Any, readiness: Any) -> None:
        profile = field(summary, "profile", default=summary)
        profile_version = field(
            summary,
            "profile_version",
            default=field(provider_status, "profile_version", default=None),
        )
        evidence = field(summary, "evidence", default=None)
        source = field(summary, "resume_source", default=None)
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
        source_kind = enum_text(field(source, "kind"), "-").replace("_", " ")
        source_repository = field(source, "repository", default="-")
        source_ref = field(source, "ref", default="-")
        source_document = field(source, "document_path", default="-")
        source_revision = field(source, "last_synced_revision", default="-") or "-"
        source_synced_at = compact_date(field(source, "last_synced_at"))
        trust_acknowledged = field(source, "trust_acknowledged_at", default=None)
        agent_lines = []
        for configuration in (
            field(
                profile_version,
                "agent_configurations",
                default=field(profile, "agent_configurations", default=()),
            )
            or ()
        ):
            agent_lines.append(
                "  "
                f"{enum_text(field(configuration, 'kind'), 'agent')}: "
                f"{field(configuration, 'model', default='-')} / "
                f"{field(configuration, 'reasoning_effort', default='-')}"
            )
        if not agent_lines:
            agent_lines.append("  Agent versions are not configured")
        readiness_lines = []
        for check in field(readiness, "checks", default=()) or ():
            readiness_lines.append(
                f"  {'OK' if field(check, 'available', default=False) else 'MISSING'} "
                f"{field(check, 'capability', default='unknown')}: "
                f"{field(check, 'detail', default='')}"
            )
        if not readiness_lines:
            readiness_lines.append("  Diagnostics unavailable")
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
                f"Residence          {field(profile, 'residence_country', default='Ecuador')}",
                f"Timezone           {field(profile, 'timezone', default='America/Guayaquil')}",
                "Target HQ          "
                f"{csv_text(field(profile, 'target_hq_countries', default=())) or '-'}",
                f"Startup required   {bool(field(profile, 'startup_required', default=False))}",
                "Remote arrangements "
                f"{csv_text(field(profile, 'accepted_remote_arrangements', default=())) or '-'}",
                "Hiring arrangements "
                f"{csv_text(field(profile, 'accepted_hiring_arrangements', default=())) or '-'}",
                f"Paper / pages      {field(profile, 'paper_size', default='-')} / "
                f"{field(profile, 'page_limit', default='-')}",
                "Agent provider     "
                f"{enum_text(field(profile_version, 'agent_provider'), 'unconfigured')}",
                *agent_lines,
                "",
                f"Master source      {source_kind}",
                f"Repository         {source_repository}",
                f"Git ref            {source_ref}",
                f"Fixed bridge       {source_document}",
                f"Trusted execution  {'yes' if trust_acknowledged else 'no'}",
                f"Last revision      {source_revision}",
                f"Last source sync   {source_synced_at}",
                "",
                f"Résumé evidence    {evidence_line}",
                f"Evidence imported  {compact_date(field(evidence, 'created_at'))}",
                f"Evidence checksum  {field(evidence_artifact, 'checksum', default='-')}",
                f"Managed artifact   {field(evidence_artifact, 'uri', default='-')}",
                "",
                "Provider readiness",
                *capability_lines,
                "Provider status    "
                f"{enum_text(field(profile_version, 'agent_provider'), 'unconfigured')}",
                "",
                "Doctor",
                *readiness_lines,
            )
        )
        self.query_one("#settings-summary", Static).update(summary_text)
        self.query_one("#resume-source-configure", Button).label = (
            "Change master résumé" if source is not None else "Configure master résumé"
        )
        self.query_one("#resume-source-sync", Button).disabled = (
            source is None
            or not trust_acknowledged
            or not bool(dict(capabilities or {}).get("resume_source_sync", False))
        )
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

    @on(Button.Pressed, "#resume-source-configure")
    def configure_resume_source_button(self) -> None:
        self.action_configure_resume_source()

    @on(Button.Pressed, "#resume-source-sync")
    def sync_resume_source_button(self) -> None:
        self.action_sync_resume_source()

    @on(Button.Pressed, "#runtime-doctor")
    def doctor_button(self) -> None:
        self.refresh_data()

    @on(Button.Pressed, "#legacy-preview")
    def preview_legacy_button(self) -> None:
        self.action_preview_legacy_import()

    @on(Button.Pressed, "#legacy-apply")
    def apply_legacy_button(self) -> None:
        self.run_worker(self._apply_legacy_import, exit_on_error=False)  # type: ignore[arg-type]

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

    def action_preview_legacy_import(self) -> None:
        self.run_worker(self._preview_legacy_import, exit_on_error=False)  # type: ignore[arg-type]

    async def _preview_legacy_import(self) -> Any | None:
        try:
            preview = await self.roleloop_app.invoke("preview_legacy_import")
        except BaseException as error:
            self.roleloop_app.report_error(
                operation_error(error), title="Legacy history unavailable"
            )
            return None
        sources = field(preview, "sources", default=()) or ()
        manifest_lines = tuple(
            f"{field(source, 'database_name', default='database')}: "
            f"{field(source, 'job_count', default=0)} jobs / "
            f"{field(source, 'event_count', default=0)} events / "
            f"{str(field(source, 'source_checksum', default=''))[:12]}…"
            for source in sources
        )
        await self.app.push_screen_wait(
            ConfirmActionModal(
                "Legacy import preview",
                "\n".join(
                    (
                        *manifest_lines,
                        "",
                        f"Importable jobs: {field(preview, 'importable_jobs', default=0)}",
                        "Duplicate URLs: "
                        f"{len(field(preview, 'duplicate_urls', default=()) or ())}",
                        "All imported records remain legacy_unpinned and cannot authorize "
                        "résumé generation or submission.",
                    )
                ),
                "Close preview",
            )
        )
        return preview

    async def _apply_legacy_import(self) -> None:
        preview = await self._preview_legacy_import()
        if preview is None:
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmActionModal(
                "Import legacy history?",
                "RoleLoop will import audited history in one transaction. The two original "
                "SQLite databases remain read-only and unchanged.",
                "Import history",
                danger=True,
            )
        )
        if not confirmed:
            return
        try:
            batch = await self.roleloop_app.invoke("apply_legacy_import")
        except BaseException as error:
            self.roleloop_app.report_error(
                operation_error(error), title="Legacy history not imported"
            )
            return
        self.roleloop_app.notify(
            f"Imported {field(batch, 'imported_jobs', default=0)} legacy jobs.",
            title="Legacy history",
        )
        self.refresh_data()

    def action_configure_resume_source(self) -> None:
        self.run_worker(self._configure_resume_source, exit_on_error=False)  # type: ignore[arg-type]

    async def _configure_resume_source(self) -> None:
        source = field(self.summary, "resume_source", default=None)
        values = await self.app.push_screen_wait(ResumeSourceModal(source))
        if values is None:
            return
        expected_revision = field(source, "revision", default=None)
        try:
            await self.roleloop_app.invoke(
                "configure_resume_source",
                values,
                expected_revision,
            )
        except BaseException as error:
            self.roleloop_app.report_error(
                operation_error(error),
                title="Master résumé source not configured",
            )
            return
        self.roleloop_app.notify(
            "Trusted master résumé configured. Analyze syncs and pins it automatically; "
            "manual sync remains available for diagnostics.",
            title="Settings",
        )
        self.refresh_data()

    def action_sync_resume_source(self) -> None:
        source = field(self.summary, "resume_source", default=None)
        if source is None:
            self.roleloop_app.report_error(
                "Configure a master résumé source before synchronizing it.",
                title="Master résumé source",
            )
            return
        self.roleloop_app.start_operation(
            "resume-source-sync",
            "Sync master résumé",
            "sync_resume_source",
        )
