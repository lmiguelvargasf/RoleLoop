"""Application history and outcome tracking view."""

from __future__ import annotations

from functools import partial
from typing import TYPE_CHECKING, Any, ClassVar, cast

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Label, Select, Static

from .modals import OutcomeModal
from .presentation import as_items, compact_date, enum_text, field, item_id, operation_error

if TYPE_CHECKING:
    from .app import RoleLoopApp


class ApplicationsView(Vertical):
    BINDINGS: ClassVar = [
        Binding("enter", "open_job", "Review", show=False),
        Binding("o", "outcome", "Outcome", show=False),
        Binding("r", "refresh", "Refresh", show=False),
    ]

    OUTCOME_OPTIONS = (
        ("Any outcome", ""),
        ("No outcome", "none"),
        ("Interviewing", "interviewing"),
        ("Offer", "offer"),
        ("Rejected", "rejected"),
        ("Withdrawn", "withdrawn"),
        ("No response", "no_response"),
    )

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._rows: dict[str, Any] = {}
        self.selected_job_id: str | None = None
        self._request_generation = 0

    @property
    def roleloop_app(self) -> RoleLoopApp:
        return cast("RoleLoopApp", self.app)

    def compose(self) -> ComposeResult:
        with Horizontal(classes="view-toolbar"):
            yield Label("APPLICATION LEDGER", classes="section-kicker")
            yield Select(
                self.OUTCOME_OPTIONS,
                value="",
                allow_blank=False,
                id="applications-outcome-filter",
            )
            yield Button("Record outcome", id="record-outcome", variant="primary")
        yield Static("", id="applications-state", markup=False)
        yield DataTable(id="applications-table", cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        table = self.query_one("#applications-table", DataTable)
        table.add_columns("Role / company", "Submitted", "Artifact", "Outcome", "Updated")

    def on_show(self) -> None:
        self.refresh_data()

    def refresh_data(self) -> None:
        self._request_generation += 1
        generation = self._request_generation
        outcome = self.query_one("#applications-outcome-filter", Select).value
        filters = {} if outcome in (None, "") else {"outcome": str(outcome)}
        self.query_one("#applications-state", Static).update("Loading applications…")
        self.run_worker(
            partial(self._load, generation, filters),  # type: ignore[arg-type]
            group="applications-read",
            exclusive=True,
            exit_on_error=False,
        )

    async def _load(self, generation: int, filters: dict[str, Any]) -> None:
        try:
            result = await self.roleloop_app.invoke("list_applications", filters)
        except BaseException as error:
            if generation == self._request_generation:
                self.query_one("#applications-state", Static).update(operation_error(error))
            return
        if generation != self._request_generation:
            return
        rows = as_items(result)
        self._rows = {}
        table = self.query_one("#applications-table", DataTable)
        table.clear()
        for row in rows:
            job_id = item_id(row, "job_id")
            if not job_id:
                continue
            self._rows[job_id] = row
            title = field(row, "title", default="Untitled role")
            company = field(row, "company", default="Unknown company")
            table.add_row(
                f"{title} / {company}",
                compact_date(field(row, "submitted_at", "updated_at")),
                str(field(row, "submitted_artifact_id", "artifact_id", default="none") or "none"),
                enum_text(field(row, "outcome"), "none"),
                compact_date(field(row, "updated_at")),
                key=job_id,
            )
        state = self.query_one("#applications-state", Static)
        if not self._rows:
            state.update("No submitted applications match this filter.")
            self.selected_job_id = None
        else:
            state.update(
                f"{len(self._rows)} submitted application{'s' if len(self._rows) != 1 else ''}"
            )
            self.selected_job_id = next(iter(self._rows))
            table.focus()

    @on(Select.Changed, "#applications-outcome-filter")
    def outcome_filter_changed(self) -> None:
        self.refresh_data()

    @on(DataTable.RowHighlighted, "#applications-table")
    def select_row(self, event: DataTable.RowHighlighted) -> None:
        self.selected_job_id = str(event.row_key.value)

    @on(DataTable.RowSelected, "#applications-table")
    def open_row(self, event: DataTable.RowSelected) -> None:
        self.selected_job_id = str(event.row_key.value)
        self.action_open_job()

    @on(Button.Pressed, "#record-outcome")
    def outcome_button(self) -> None:
        self.action_outcome()

    def action_refresh(self) -> None:
        self.refresh_data()

    def action_open_job(self) -> None:
        if self.selected_job_id:
            self.roleloop_app.open_job_review(self.selected_job_id)

    def action_outcome(self) -> None:
        if not self.selected_job_id:
            return
        self.run_worker(
            partial(  # type: ignore[arg-type]
                self._record_outcome, self.selected_job_id
            ),
            exit_on_error=False,
        )

    async def _record_outcome(self, job_id: str) -> None:
        row = self._rows[job_id]
        current = enum_text(field(row, "outcome"), "none")
        outcome = await self.app.push_screen_wait(OutcomeModal(current))
        if outcome is None:
            return
        try:
            await self.roleloop_app.invoke("record_outcome", job_id, outcome)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Outcome not saved")
        self.refresh_data()
