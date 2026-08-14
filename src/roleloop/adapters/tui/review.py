"""Full job review screen."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from functools import partial
from typing import TYPE_CHECKING, Any, ClassVar, cast

from textual import events, on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Button, DataTable, Static, TabbedContent, TabPane

from .modals import ConfirmActionModal, OutcomeModal, QuestionAnswerModal
from .presentation import (
    compact_date,
    enum_text,
    field,
    item_id,
    operation_error,
)
from .widgets import OperationStrip

if TYPE_CHECKING:
    from .app import RoleLoopApp


class JobReviewScreen(Screen[None]):
    """Evidence, questions, résumé work, and history for a single job."""

    BINDINGS: ClassVar = [
        Binding("escape", "back", "Back"),
        Binding("t", "decide('tailor')", "Tailor"),
        Binding("w", "decide('watch')", "Watch"),
        Binding("s", "decide('skip')", "Skip"),
        Binding("g", "generate", "Generate"),
        Binding("a", "applied", "Submitted"),
        Binding("o", "outcome", "Outcome"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self, job_id: str) -> None:
        super().__init__()
        self.job_id = job_id
        self.view: Any | None = None
        self.questions: dict[str, Any] = {}
        self._request_generation = 0
        self._analysis_requested = False
        self._mutation_busy = False
        self.last_error = ""

    @property
    def roleloop_app(self) -> RoleLoopApp:
        return cast("RoleLoopApp", self.app)

    def compose(self) -> ComposeResult:
        with Vertical(id="review-shell"):
            yield Static("Loading job…", id="review-title", markup=False)
            yield Static("", id="workflow-rail", markup=False)
            yield Static("", id="review-error", classes="form-error", markup=False)
            with TabbedContent(initial="summary-tab", id="review-tabs"):
                with TabPane("Summary", id="summary-tab"):
                    yield Static("Loading details…", id="review-summary", markup=False)
                with (
                    TabPane("Evidence", id="evidence-tab"),
                    Horizontal(id="evidence-ledger"),
                ):
                    yield Static(
                        "CASE FOR\n+ No review evidence yet.",
                        id="evidence-support",
                        classes="evidence-column",
                        markup=False,
                    )
                    yield Static(
                        "SKEPTIC'S CASE\n! No review evidence yet.",
                        id="evidence-skeptic",
                        classes="evidence-column",
                        markup=False,
                    )
                with TabPane("Questions", id="questions-tab"):
                    yield Static("", id="questions-gate", markup=False)
                    yield DataTable(id="questions-table", cursor_type="row", zebra_stripes=True)
                with TabPane("Résumé", id="resume-tab"):
                    yield Static("No résumé run yet.", id="resume-status", markup=False)
                with TabPane("History", id="history-tab"):
                    yield Static("No workflow events yet.", id="history-ledger", markup=False)
            with Horizontal(id="review-actions"):
                yield Button("Tailor", id="review-tailor")
                yield Button("Watch", id="review-watch")
                yield Button("Skip", id="review-skip", variant="error")
                yield Button("Generate résumé", id="review-generate", variant="primary")
                yield Button("Mark submitted", id="review-applied", variant="success")
                yield Button("Outcome", id="review-outcome", disabled=True)
            yield OperationStrip(id="review-operation")

    def on_mount(self) -> None:
        self._apply_responsive_class(self.size.width)
        self.query_one("#questions-table", DataTable).add_columns(
            "Required", "Category", "Question", "Answer"
        )
        self.refresh_data(analyze=True)

    @on(events.Resize)
    def resized(self, event: events.Resize) -> None:
        self._apply_responsive_class(event.size.width)

    def _apply_responsive_class(self, width: int) -> None:
        self.set_class(width < 90, "compact-review")

    def refresh_data(self, *, analyze: bool = False) -> None:
        self._request_generation += 1
        generation = self._request_generation
        self.run_worker(
            partial(  # type: ignore[arg-type]
                self._load, generation, analyze=analyze
            ),
            group="review-read",
            exclusive=True,
            exit_on_error=False,
        )

    async def _load(self, generation: int, *, analyze: bool) -> None:
        try:
            view, history = await asyncio.gather(
                self.roleloop_app.invoke("get_job_review", self.job_id),
                self.roleloop_app.invoke_optional("get_job_history", self.job_id),
            )
        except BaseException as error:
            if generation == self._request_generation:
                self.query_one("#review-error", Static).update(operation_error(error))
            return
        if generation != self._request_generation:
            return
        self.view = view
        self.query_one("#review-error", Static).update(self.last_error)
        self._render_view(view, history)
        review_status = enum_text(field(view, "review_status"), "missing")
        if analyze and review_status in {"missing", "stale"} and not self._analysis_requested:
            self._analysis_requested = True
            self.roleloop_app.start_operation(
                f"review:{self.job_id}",
                "Analyze job",
                "review_job",
                self.job_id,
                job_id=self.job_id,
            )

    def _render_view(self, view: Any, history: Any) -> None:
        job = field(view, "job", default={})
        case = field(view, "case", default={})
        review = field(view, "review", default=None)
        title = field(job, "title", default="Untitled role") or "Untitled role"
        company = field(job, "company", default="Unknown company") or "Unknown company"
        location = (
            field(job, "location", default="Location not supplied") or "Location not supplied"
        )
        self.query_one("#review-title", Static).update(f"{title}  /  {company}  /  {location}")
        review_status = enum_text(field(view, "review_status"), "missing")
        eligibility = enum_text(field(view, "eligibility_status"), "unresolved")
        decision = enum_text(field(case, "decision"), "undecided")
        resume = enum_text(field(view, "resume_status"), "none")
        application = enum_text(field(case, "application_status"), "not submitted")
        outcome = enum_text(field(case, "current_outcome", "outcome"), "none")
        self.query_one("#workflow-rail", Static).update(
            "  ".join(
                (
                    f"[review {review_status}]",
                    f"[eligibility {eligibility}]",
                    f"[decision {decision}]",
                    f"[résumé {resume}]",
                    f"[application {application}]",
                    f"[outcome {outcome}]",
                )
            )
        )
        description = str(field(job, "description", default="") or "No description supplied.")
        self.query_one("#review-summary", Static).update(
            "\n".join(
                (
                    f"Source      {field(job, 'source', default='manual')}",
                    f"URL         {field(job, 'canonical_url', 'url', default='-')}",
                    f"Updated     {compact_date(field(job, 'updated_at'))}",
                    "",
                    description,
                )
            )
        )
        self._render_evidence(review)
        self._render_questions(view, review)
        self._render_resume(view)
        self._render_history(history, case)
        self._sync_actions(decision, eligibility, resume, application)

    def show_error(self, message: str) -> None:
        self.last_error = message
        self.query_one("#review-error", Static).update(message)

    def clear_error(self) -> None:
        self.last_error = ""
        self.query_one("#review-error", Static).update("")

    def _render_evidence(self, review: Any | None) -> None:
        if review is None:
            missing = "Analysis is missing. RoleLoop will analyze it when a provider is configured."
            self.query_one("#evidence-support", Static).update(f"CASE FOR\n+ {missing}")
            self.query_one("#evidence-skeptic", Static).update(f"SKEPTIC'S CASE\n! {missing}")
            return
        matches = field(review, "match_evidence", default=()) or ()
        skeptics = field(review, "skeptic_findings", default=()) or ()
        support_lines = ["CASE FOR", *self._finding_lines(matches, "+")]
        skeptic_lines = ["SKEPTIC'S CASE", *self._finding_lines(skeptics, "!")]
        self.query_one("#evidence-support", Static).update("\n".join(support_lines))
        self.query_one("#evidence-skeptic", Static).update("\n".join(skeptic_lines))

    @staticmethod
    def _finding_lines(findings: Iterable[Any], marker: str) -> list[str]:
        lines: list[str] = []
        for finding in findings:
            summary = field(finding, "summary", "message", default="Finding")
            detail = field(finding, "detail", default="")
            source = field(finding, "source_anchor", "source", default="")
            lines.append(f"{marker} {summary}")
            if detail:
                lines.append(f"    {detail}")
            if source:
                lines.append(f"    source: {source}")
        if not lines:
            lines.append(f"{marker} None recorded")
        return lines

    def _render_questions(self, view: Any, review: Any | None) -> None:
        table = self.query_one("#questions-table", DataTable)
        table.clear()
        self.questions.clear()
        answers = field(view, "answers", default={}) or {}
        questions = field(review, "questions", default=()) if review is not None else ()
        for question in questions or ():
            question_id = item_id(question, "question_id")
            if not question_id:
                continue
            self.questions[question_id] = question
            answer = answers.get(question_id) if isinstance(answers, Mapping) else None
            table.add_row(
                "YES" if field(question, "required", default=False) else "",
                enum_text(field(question, "category"), "verification"),
                str(field(question, "prompt", "text", default="Question")),
                enum_text(answer, "unanswered"),
                key=question_id,
            )
        eligibility = enum_text(field(view, "eligibility_status"), "unresolved")
        self.query_one("#questions-gate", Static).update(
            f"Eligibility: {eligibility}. Select a question and press Enter "
            "to answer yes, no, or unknown."
        )

    def _render_resume(self, view: Any) -> None:
        run = field(view, "latest_resume_run", "resume_run", default=None)
        if run is None:
            self.query_one("#resume-status", Static).update(
                "No résumé run yet. Choose Tailor, resolve required questions, then Generate."
            )
            return
        findings = field(run, "validation_findings", default=()) or ()
        provenance = field(run, "provenance", default=()) or ()
        artifact = field(run, "artifact", default=None)
        lines = [
            f"Run         {item_id(run, 'run_id') or '-'}",
            f"Stage       {enum_text(field(run, 'stage'))}",
            f"Created     {compact_date(field(run, 'created_at'))}",
            f"Artifact    {field(artifact, 'uri', default='Not ready')}",
            "",
            "VALIDATION",
        ]
        if findings:
            for finding in findings:
                lines.append(
                    f"[{enum_text(field(finding, 'severity'))}] "
                    f"{field(finding, 'message', default='Finding')}"
                )
        else:
            lines.append("No validation findings recorded.")
        lines.extend(("", f"Provenance claims: {len(tuple(provenance))}"))
        error = field(run, "error_message", "error", default="")
        if error:
            lines.extend(("", f"Failure: {error}"))
        self.query_one("#resume-status", Static).update("\n".join(lines))

    def _render_history(self, history: Any, case: Any) -> None:
        events = field(history, "events", default=history if history is not None else ()) or ()
        if isinstance(events, Mapping):
            events = events.values()
        lines: list[str] = []
        for event in events:
            lines.append(
                f"{compact_date(field(event, 'occurred_at', 'created_at'))}  "
                f"{enum_text(field(event, 'event_type', 'type'), 'event')}"
            )
            metadata = field(event, "metadata", default={})
            if metadata:
                lines.append(f"    {dict(metadata)}")
        if not lines:
            lines.append(
                f"Current case revision: {field(case, 'revision', default='-')}. "
                "No event detail available."
            )
        self.query_one("#history-ledger", Static).update("\n".join(lines))

    def _sync_actions(self, decision: str, eligibility: str, resume: str, application: str) -> None:
        submitted = application == "submitted"
        self.query_one("#review-skip", Button).disabled = submitted
        self.query_one("#review-applied", Button).disabled = submitted
        self.query_one("#review-outcome", Button).disabled = not submitted
        generate = self.query_one("#review-generate", Button)
        generate.disabled = not (
            decision == "tailor"
            and eligibility == "eligible"
            and resume != "in progress"
            and resume != "in_progress"
        )
        if decision != "tailor":
            generate.label = "Choose Tailor first"
        elif eligibility == "unresolved":
            generate.label = "Answer required questions"
        elif eligibility == "ineligible":
            generate.label = "Ineligible"
        elif resume in {"in progress", "in_progress"}:
            generate.label = "Generating…"
        elif resume in {"ready", "failed", "stale"}:
            generate.label = "Generate new version"
        else:
            generate.label = "Generate résumé"

    @on(DataTable.RowSelected, "#questions-table")
    def answer_row(self, event: DataTable.RowSelected) -> None:
        question_id = str(event.row_key.value)
        if question_id in self.questions:
            self.run_worker(
                partial(  # type: ignore[arg-type]
                    self._answer_question, question_id
                ),
                exit_on_error=False,
            )

    async def _answer_question(self, question_id: str) -> None:
        answer = await self.app.push_screen_wait(QuestionAnswerModal(self.questions[question_id]))
        if answer is None:
            return
        try:
            await self.roleloop_app.invoke("answer_verification", self.job_id, question_id, answer)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Answer not saved")
        self.refresh_data()

    @on(Button.Pressed, "#review-tailor")
    def tailor_button(self) -> None:
        self.action_decide("tailor")

    @on(Button.Pressed, "#review-watch")
    def watch_button(self) -> None:
        self.action_decide("watch")

    @on(Button.Pressed, "#review-skip")
    def skip_button(self) -> None:
        self.action_decide("skip")

    @on(Button.Pressed, "#review-generate")
    def generate_button(self) -> None:
        self.action_generate()

    @on(Button.Pressed, "#review-applied")
    def applied_button(self) -> None:
        self.action_applied()

    @on(Button.Pressed, "#review-outcome")
    def outcome_button(self) -> None:
        self.action_outcome()

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_refresh(self) -> None:
        self.refresh_data(analyze=False)

    def action_decide(self, decision: str) -> None:
        if self.view is None or self._mutation_busy:
            return
        self.run_worker(
            partial(self._decide, decision),  # type: ignore[arg-type]
            exit_on_error=False,
        )

    async def _decide(self, decision: str) -> None:
        self._mutation_busy = True
        try:
            case = field(self.view, "case", default={})
            if decision == "skip":
                if enum_text(field(case, "application_status"), "") == "submitted":
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
            await self.roleloop_app.invoke("decide_job", self.job_id, decision)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Decision not saved")
        finally:
            self._mutation_busy = False
            self.refresh_data()

    def action_generate(self) -> None:
        if self.view is None:
            return
        self.run_worker(self._confirm_generate, exit_on_error=False)  # type: ignore[arg-type]

    async def _confirm_generate(self) -> None:
        case = field(self.view, "case", default={})
        decision = enum_text(field(case, "decision"), "undecided")
        eligibility = enum_text(field(self.view, "eligibility_status"), "unresolved")
        if decision != "tailor":
            self.roleloop_app.report_error(
                "Choose Tailor before generating a résumé.", title="Generation blocked"
            )
            return
        if eligibility != "eligible":
            self.roleloop_app.report_error(
                "Resolve the required eligibility questions first.",
                title="Generation blocked",
            )
            return
        active = field(self.roleloop_app.active_summary, "profile", default={})
        evidence = field(self.roleloop_app.active_summary, "evidence", default={})
        job = field(self.view, "job", default={})
        confirmed = await self.app.push_screen_wait(
            ConfirmActionModal(
                "Generate a tailored résumé?",
                "\n".join(
                    (
                        f"Job:      {field(job, 'title', default='Untitled role')}",
                        f"Profile:  {field(active, 'name', default='Active profile')}",
                        f"Evidence: {field(evidence, 'source_name', default='Current version')}",
                        "",
                        "RoleLoop will draft, validate, and compile a new version. "
                        "Prior artifacts remain unchanged.",
                    )
                ),
                "Generate résumé",
            )
        )
        if not confirmed:
            return
        self.query_one("#review-generate", Button).disabled = True
        self.roleloop_app.start_operation(
            f"generate:{self.job_id}",
            "Generate résumé",
            "generate_resume",
            self.job_id,
            job_id=self.job_id,
        )

    def action_applied(self) -> None:
        if self.view is not None:
            self.run_worker(
                self._confirm_applied,  # type: ignore[arg-type]
                exit_on_error=False,
            )

    async def _confirm_applied(self) -> None:
        case = field(self.view, "case", default={})
        if enum_text(field(case, "decision"), "undecided") == "skip":
            self.roleloop_app.report_error(
                "Restore this job before marking it submitted.", title="Submission blocked"
            )
            return
        job = field(self.view, "job", default={})
        confirmed = await self.app.push_screen_wait(
            ConfirmActionModal(
                "Mark application submitted?",
                f"{field(job, 'title', default='Untitled role')} / "
                f"{field(job, 'company', default='Unknown company')}\n\n"
                "RoleLoop will record the current time and retain the decision "
                "and artifact provenance.",
                "Mark submitted",
            )
        )
        if not confirmed:
            return
        try:
            await self.roleloop_app.invoke("mark_applied", self.job_id)
        except BaseException as error:
            self.roleloop_app.report_error(
                operation_error(error), title="Application not marked submitted"
            )
        self.refresh_data()

    def action_outcome(self) -> None:
        case = field(self.view, "case", default={})
        if (
            self.view is not None
            and enum_text(field(case, "application_status"), "not_submitted") == "submitted"
        ):
            self.run_worker(
                self._record_outcome,  # type: ignore[arg-type]
                exit_on_error=False,
            )

    async def _record_outcome(self) -> None:
        case = field(self.view, "case", default={})
        if enum_text(field(case, "application_status"), "not_submitted") != "submitted":
            return
        current = enum_text(field(case, "current_outcome"), "interviewing")
        outcome = await self.app.push_screen_wait(OutcomeModal(current))
        if outcome is None:
            return
        try:
            await self.roleloop_app.invoke("record_outcome", self.job_id, outcome)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Outcome not saved")
        self.refresh_data()
