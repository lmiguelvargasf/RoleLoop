"""Inbox master view and facet filters."""

from __future__ import annotations

from functools import partial
from typing import TYPE_CHECKING, Any, ClassVar, cast

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Input, Label, Select, Static

from .modals import ConfirmActionModal
from .presentation import as_items, compact_date, enum_text, field, item_id, operation_error

if TYPE_CHECKING:
    from .app import RoleLoopApp


class InboxView(Horizontal):
    """Keyboard-first job inbox for the active profile."""

    BINDINGS: ClassVar = [
        Binding("enter", "open_job", "Review", show=False),
        Binding("t", "decide('tailor')", "Tailor", show=False),
        Binding("w", "decide('watch')", "Watch", show=False),
        Binding("s", "decide('skip')", "Skip", show=False),
        Binding("f", "toggle_filters", "Filters", show=False),
        Binding("/", "focus_search", "Search", show=False),
        Binding("r", "refresh", "Refresh", show=False),
    ]

    REVIEW_OPTIONS = (
        ("Any review", ""),
        ("Missing", "missing"),
        ("Stale", "stale"),
        ("Current", "current"),
    )
    ELIGIBILITY_OPTIONS = (
        ("Any eligibility", ""),
        ("Unresolved", "unresolved"),
        ("Eligible", "eligible"),
        ("Ineligible", "ineligible"),
    )
    DECISION_OPTIONS = (
        ("Any decision", ""),
        ("Undecided", "undecided"),
        ("Tailor", "tailor"),
        ("Watch", "watch"),
        ("Skipped", "skip"),
    )
    RESUME_OPTIONS = (
        ("Any résumé", ""),
        ("None", "none"),
        ("In progress", "in_progress"),
        ("Ready", "ready"),
        ("Failed", "failed"),
        ("Stale", "stale"),
    )
    APPLICATION_OPTIONS = (
        ("Any application", ""),
        ("Not submitted", "not_submitted"),
        ("Submitted", "submitted"),
    )

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._rows: dict[str, Any] = {}
        self.selected_job_id: str | None = None
        self._request_generation = 0
        self._mutation_busy = False

    @property
    def roleloop_app(self) -> RoleLoopApp:
        return cast("RoleLoopApp", self.app)

    def compose(self) -> ComposeResult:
        with Vertical(id="inbox-filters"):
            yield Label("FILTER THE LEDGER", classes="section-kicker")
            yield Input(placeholder="Search role or company", id="inbox-search")
            yield Select(
                self.REVIEW_OPTIONS,
                value="",
                allow_blank=False,
                id="filter-review",
                classes="facet-select",
            )
            yield Select(
                self.ELIGIBILITY_OPTIONS,
                value="",
                allow_blank=False,
                id="filter-eligibility",
                classes="facet-select",
            )
            yield Select(
                self.DECISION_OPTIONS,
                value="",
                allow_blank=False,
                id="filter-decision",
                classes="facet-select",
            )
            yield Select(
                self.RESUME_OPTIONS,
                value="",
                allow_blank=False,
                id="filter-resume",
                classes="facet-select",
            )
            yield Select(
                self.APPLICATION_OPTIONS,
                value="",
                allow_blank=False,
                id="filter-application",
                classes="facet-select",
            )
            yield Button("Clear filters", id="clear-filters")
            yield Button("Apply / close filters", id="close-filters")

        with Vertical(id="jobs-pane"):
            yield Button("Filters", id="compact-filter-toggle")
            yield Static("", id="inbox-state", markup=False)
            yield DataTable(id="job-table", cursor_type="row", zebra_stripes=True)

        with Vertical(id="job-preview"):
            yield Label("SELECTED CASE", classes="section-kicker")
            yield Static(
                "Select a job to inspect its workflow and evidence.",
                id="preview-copy",
                markup=False,
            )
            with Horizontal(id="preview-actions"):
                yield Button("Tailor", id="preview-tailor")
                yield Button("Watch", id="preview-watch")
                yield Button("Skip", id="preview-skip", variant="error")
            yield Button("Open full review", id="preview-open", variant="primary")

    def on_mount(self) -> None:
        table = self.query_one("#job-table", DataTable)
        table.add_columns(
            "Role / company",
            "Review",
            "Eligibility",
            "Decision",
            "Résumé",
            "Application",
        )
        self.refresh_data()

    def filters(self) -> dict[str, Any]:
        values: dict[str, Any] = {
            "search": self.query_one("#inbox-search", Input).value.strip(),
        }
        for name in (
            "review",
            "eligibility",
            "decision",
            "resume",
            "application",
        ):
            value = self.query_one(f"#filter-{name}", Select).value
            if value not in (None, ""):
                values[name] = str(value)
        return values

    def refresh_data(self) -> None:
        self._request_generation += 1
        generation = self._request_generation
        self.query_one("#inbox-state", Static).update("Loading inbox…")
        self.run_worker(
            partial(self._load_jobs, generation),
            group="inbox-read",
            exclusive=True,
            exit_on_error=False,
        )

    async def _load_jobs(self, generation: int) -> None:
        try:
            result = await self.roleloop_app.invoke("list_jobs", self.filters())
        except BaseException as error:
            if generation == self._request_generation:
                self.query_one("#inbox-state", Static).update(operation_error(error))
            return
        if generation != self._request_generation:
            return
        self._render_rows(as_items(result))

    def _render_rows(self, rows: list[Any]) -> None:
        table = self.query_one("#job-table", DataTable)
        prior = self.selected_job_id
        table.clear()
        self._rows.clear()
        for row in rows:
            job_id = item_id(row, "job_id")
            if not job_id:
                continue
            self._rows[job_id] = row
            title = str(field(row, "title", default="Untitled role") or "Untitled role")
            company = str(field(row, "company", default="Unknown company") or "Unknown company")
            table.add_row(
                f"{title} / {company}",
                enum_text(field(row, "review_status", "review")),
                enum_text(field(row, "eligibility_status", "eligibility")),
                enum_text(field(row, "decision")),
                enum_text(field(row, "resume_status", "resume")),
                enum_text(field(row, "application_status", "application")),
                key=job_id,
            )
        state = self.query_one("#inbox-state", Static)
        if not self._rows:
            state.update(
                "No jobs match these filters. Clear filters, add a URL, or start discovery."
            )
            self.selected_job_id = None
            self._render_preview(None)
            return
        state.update(f"{len(self._rows)} case{'s' if len(self._rows) != 1 else ''}")
        self.selected_job_id = prior if prior in self._rows else next(iter(self._rows))
        table.move_cursor(row=list(self._rows).index(self.selected_job_id))
        self._render_preview(self._rows[self.selected_job_id])
        table.focus()

    def _render_preview(self, row: Any | None) -> None:
        copy = self.query_one("#preview-copy", Static)
        buttons = [
            *self.query("#preview-actions Button"),
            self.query_one("#preview-open", Button),
        ]
        for button in buttons:
            button.disabled = row is None
        if row is None:
            copy.update("Select a job to inspect its workflow and evidence.")
            return
        title = field(row, "title", default="Untitled role")
        company = field(row, "company", default="Unknown company")
        location = field(row, "location", default="Location not supplied")
        copy.update(
            "\n".join(
                (
                    f"{title}",
                    f"{company} / {location}",
                    "",
                    f"Review      {enum_text(field(row, 'review_status', 'review'))}",
                    f"Eligibility {enum_text(field(row, 'eligibility_status', 'eligibility'))}",
                    f"Decision    {enum_text(field(row, 'decision'))}",
                    f"Résumé      {enum_text(field(row, 'resume_status', 'resume'))}",
                    f"Application {enum_text(field(row, 'application_status', 'application'))}",
                    f"Updated     {compact_date(field(row, 'updated_at'))}",
                )
            )
        )

    @on(DataTable.RowHighlighted, "#job-table")
    def select_row(self, event: DataTable.RowHighlighted) -> None:
        job_id = str(event.row_key.value)
        if job_id in self._rows:
            self.selected_job_id = job_id
            self._render_preview(self._rows[job_id])

    @on(DataTable.RowSelected, "#job-table")
    def open_selected_row(self, event: DataTable.RowSelected) -> None:
        self.selected_job_id = str(event.row_key.value)
        self.action_open_job()

    @on(Select.Changed, ".facet-select")
    def filter_changed(self) -> None:
        self.refresh_data()

    @on(Input.Submitted, "#inbox-search")
    def search_submitted(self) -> None:
        self.refresh_data()

    @on(Button.Pressed, "#clear-filters")
    def clear_filters(self) -> None:
        self.query_one("#inbox-search", Input).value = ""
        for select in self.query(".facet-select"):
            cast(Select[str], select).value = ""
        self.refresh_data()

    @on(Button.Pressed, "#compact-filter-toggle")
    @on(Button.Pressed, "#close-filters")
    def toggle_filter_button(self) -> None:
        self.action_toggle_filters()

    @on(Button.Pressed, "#preview-open")
    def open_button(self) -> None:
        self.action_open_job()

    @on(Button.Pressed, "#preview-tailor")
    def tailor_button(self) -> None:
        self.action_decide("tailor")

    @on(Button.Pressed, "#preview-watch")
    def watch_button(self) -> None:
        self.action_decide("watch")

    @on(Button.Pressed, "#preview-skip")
    def skip_button(self) -> None:
        self.action_decide("skip")

    def action_refresh(self) -> None:
        self.refresh_data()

    def action_toggle_filters(self) -> None:
        self.toggle_class("filters-open")
        if self.has_class("filters-open"):
            self.query_one("#inbox-search", Input).focus()
        else:
            self.query_one("#job-table", DataTable).focus()

    def action_focus_search(self) -> None:
        if self.screen.has_class("compact") and not self.has_class("filters-open"):
            self.add_class("filters-open")
        self.query_one("#inbox-search", Input).focus()

    def action_open_job(self) -> None:
        if self.selected_job_id:
            self.roleloop_app.open_job_review(self.selected_job_id)

    def action_decide(self, decision: str) -> None:
        if not self.selected_job_id or self._mutation_busy:
            return
        self.run_worker(
            partial(self._set_decision, self.selected_job_id, decision),
            exit_on_error=False,
        )

    async def _set_decision(self, job_id: str, decision: str) -> None:
        self._mutation_busy = True
        try:
            if decision == "skip":
                row = self._rows.get(job_id)
                if enum_text(field(row, "application_status", "application"), "") == "submitted":
                    self.roleloop_app.report_error(
                        "Submitted applications cannot be skipped.", title="Skip blocked"
                    )
                    return
                confirmed = await self.app.push_screen_wait(
                    ConfirmActionModal(
                        "Skip this job?",
                        "It will leave active triage queues. The change is reversible "
                        "and remains in history.",
                        "Skip job",
                        danger=True,
                    )
                )
                if not confirmed:
                    return
            await self.roleloop_app.invoke("decide_job", job_id, decision)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Decision not saved")
        finally:
            self._mutation_busy = False
            self.refresh_data()
