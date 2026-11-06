"""Application stages and the manual follow-up queue."""

from __future__ import annotations

import asyncio
from functools import partial
from typing import TYPE_CHECKING, Any, ClassVar, cast

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Label, Static

from .modals import ApplicationStageModal, ConfirmActionModal, FollowUpRescheduleModal
from .presentation import as_items, compact_date, enum_text, field, item_id, operation_error

if TYPE_CHECKING:
    from .app import RoleLoopApp


class ApplicationsView(Vertical):
    BINDINGS: ClassVar = [
        Binding("enter", "open_job", "Review", show=False),
        Binding("s", "stage", "Record stage", show=False),
        Binding("r", "refresh", "Refresh", show=False),
    ]

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._rows: dict[str, Any] = {}
        self._followups: dict[str, Any] = {}
        self.selected_job_id: str | None = None
        self.selected_follow_up_id: str | None = None
        self._request_generation = 0

    @property
    def roleloop_app(self) -> RoleLoopApp:
        return cast("RoleLoopApp", self.app)

    def compose(self) -> ComposeResult:
        with Horizontal(classes="view-toolbar"):
            yield Label("APPLICATION LEDGER", classes="section-kicker")
            yield Button("Record stage", id="record-stage", variant="primary")
        yield Static("", id="applications-state", markup=False)
        yield DataTable(id="applications-table", cursor_type="row", zebra_stripes=True)
        with Horizontal(classes="view-toolbar"):
            yield Label("FOLLOW-UPS DUE", classes="section-kicker")
            yield Button("Resolve", id="followup-resolve", variant="success")
            yield Button("Reschedule", id="followup-reschedule")
        yield Static("", id="followups-state", markup=False)
        yield DataTable(id="followups-table", cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        self.query_one("#applications-table", DataTable).add_columns(
            "Role / company",
            "Stage",
            "Submitted",
            "Next follow-up",
            "PDF artifact",
            "Updated",
        )
        self.query_one("#followups-table", DataTable).add_columns(
            "Due",
            "Application",
            "Note",
        )

    def on_show(self) -> None:
        self.refresh_data()

    def refresh_data(self) -> None:
        self._request_generation += 1
        generation = self._request_generation
        self.query_one("#applications-state", Static).update("Loading applications…")
        self.query_one("#followups-state", Static).update("Loading follow-ups…")
        self.run_worker(
            partial(self._load, generation),
            group="applications-read",
            exclusive=True,
            exit_on_error=False,
        )

    async def _load(self, generation: int) -> None:
        try:
            result, followups = await asyncio.gather(
                self.roleloop_app.invoke("list_applications", {}),
                self.roleloop_app.invoke_optional("list_due_followups"),
            )
        except BaseException as error:
            if generation == self._request_generation:
                message = operation_error(error)
                self.query_one("#applications-state", Static).update(message)
                self.query_one("#followups-state", Static).update(message)
            return
        if generation != self._request_generation:
            return
        self._render_applications(as_items(result))
        self._render_followups(as_items(followups))

    def _render_applications(self, rows: list[Any]) -> None:
        table = self.query_one("#applications-table", DataTable)
        table.clear()
        self._rows.clear()
        for row in rows:
            application = field(row, "application", default=row)
            job = field(row, "job", default=row)
            job_id = item_id(application, "job_id") or item_id(row, "job_id")
            if not job_id:
                continue
            self._rows[job_id] = row
            follow_up = field(row, "open_follow_up", default=None)
            title = field(job, "title", default="Untitled role")
            company = field(job, "company", default="Unknown company")
            table.add_row(
                f"{title} / {company}",
                enum_text(field(application, "current_stage", "stage"), "submitted"),
                compact_date(field(application, "submitted_at")),
                compact_date(field(follow_up, "due_at")) if follow_up else "none",
                str(field(application, "pdf_artifact_id", default="none") or "none"),
                compact_date(field(application, "updated_at")),
                key=job_id,
            )
        state = self.query_one("#applications-state", Static)
        if self._rows:
            state.update(f"{len(self._rows)} application{'s' if len(self._rows) != 1 else ''}")
            self.selected_job_id = next(iter(self._rows))
        else:
            state.update("No manually submitted applications yet.")
            self.selected_job_id = None

    def _render_followups(self, followups: list[Any]) -> None:
        table = self.query_one("#followups-table", DataTable)
        table.clear()
        self._followups.clear()
        for follow_up in followups:
            follow_up_id = item_id(follow_up, "follow_up_id")
            if not follow_up_id:
                continue
            self._followups[follow_up_id] = follow_up
            table.add_row(
                compact_date(field(follow_up, "due_at")),
                str(field(follow_up, "application_id", default="-")),
                str(field(follow_up, "note", default="") or "-"),
                key=follow_up_id,
            )
        state = self.query_one("#followups-state", Static)
        if self._followups:
            state.update(
                f"{len(self._followups)} due or overdue follow-up"
                f"{'s' if len(self._followups) != 1 else ''}"
            )
            self.selected_follow_up_id = next(iter(self._followups))
        else:
            state.update("No follow-ups are due.")
            self.selected_follow_up_id = None

    @on(DataTable.RowHighlighted, "#applications-table")
    def select_application(self, event: DataTable.RowHighlighted) -> None:
        self.selected_job_id = str(event.row_key.value)

    @on(DataTable.RowSelected, "#applications-table")
    def open_application(self, event: DataTable.RowSelected) -> None:
        self.selected_job_id = str(event.row_key.value)
        self.action_open_job()

    @on(DataTable.RowHighlighted, "#followups-table")
    def select_followup(self, event: DataTable.RowHighlighted) -> None:
        self.selected_follow_up_id = str(event.row_key.value)

    @on(Button.Pressed, "#record-stage")
    def stage_button(self) -> None:
        self.action_stage()

    @on(Button.Pressed, "#followup-resolve")
    def resolve_button(self) -> None:
        if self.selected_follow_up_id:
            self.run_worker(self._resolve_followup, exit_on_error=False)

    @on(Button.Pressed, "#followup-reschedule")
    def reschedule_button(self) -> None:
        if self.selected_follow_up_id:
            self.run_worker(self._reschedule_followup, exit_on_error=False)

    def action_refresh(self) -> None:
        self.refresh_data()

    def action_open_job(self) -> None:
        if self.selected_job_id:
            self.roleloop_app.open_job_review(self.selected_job_id)

    def action_stage(self) -> None:
        if self.selected_job_id:
            self.run_worker(self._record_stage, exit_on_error=False)

    async def _record_stage(self) -> None:
        if not self.selected_job_id:
            return
        row = self._rows[self.selected_job_id]
        application = field(row, "application", default=row)
        current = enum_text(field(application, "current_stage", "stage"), "acknowledged")
        values = await self.app.push_screen_wait(ApplicationStageModal(current))
        if values is None:
            return
        try:
            await self.roleloop_app.invoke(
                "record_application_stage",
                self.selected_job_id,
                values,
            )
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Stage not recorded")
        self.refresh_data()

    async def _resolve_followup(self) -> None:
        follow_up_id = self.selected_follow_up_id
        if not follow_up_id:
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmActionModal(
                "Resolve this follow-up?",
                "The resolution is append-only and the item leaves the due queue.",
                "Resolve follow-up",
            )
        )
        if not confirmed:
            return
        try:
            await self.roleloop_app.invoke("resolve_followup", follow_up_id, "")
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Follow-up not resolved")
        self.refresh_data()

    async def _reschedule_followup(self) -> None:
        follow_up_id = self.selected_follow_up_id
        if not follow_up_id:
            return
        values = await self.app.push_screen_wait(FollowUpRescheduleModal())
        if values is None:
            return
        try:
            await self.roleloop_app.invoke(
                "reschedule_followup",
                follow_up_id,
                values["date"],
                values["note"],
            )
        except BaseException as error:
            self.roleloop_app.report_error(
                operation_error(error),
                title="Follow-up not rescheduled",
            )
        self.refresh_data()
