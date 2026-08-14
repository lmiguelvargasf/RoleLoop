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

from .modals import (
    ApplicationStageModal,
    ConfirmActionModal,
    ExportPathModal,
    QuestionAnswerModal,
    ResumeFeedbackModal,
    SubmissionModal,
)
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
        Binding("a", "analyze", "Analyze"),
        Binding("t", "decide('tailor')", "Tailor"),
        Binding("w", "decide('watch')", "Watch"),
        Binding("s", "decide('skip')", "Skip"),
        Binding("v", "revise", "Request changes"),
        Binding("p", "approve", "Approve PDF"),
        Binding("u", "submit", "Submit"),
        Binding("l", "stage", "Stage"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self, job_id: str) -> None:
        super().__init__()
        self.job_id = job_id
        self.view: Any | None = None
        self.resume_case: Any | None = None
        self.questions: dict[str, Any] = {}
        self._request_generation = 0
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
                yield Button("Analyze", id="review-analyze", variant="primary")
                yield Button("Tailor", id="review-tailor")
                yield Button("Watch", id="review-watch")
                yield Button("Skip", id="review-skip", variant="error")
                yield Button("Retry generation", id="review-retry")
            with Horizontal(id="resume-review-actions"):
                yield Button("Request changes", id="review-revise")
                yield Button("Approve exact PDF", id="review-approve", variant="success")
                yield Button("Reject PDF", id="review-reject", variant="error")
                yield Button("Open PDF", id="review-open")
                yield Button("Export PDF", id="review-export")
            with Horizontal(id="application-stage-actions"):
                yield Button("Record submission", id="review-submit", variant="success")
                yield Button("Record stage", id="review-stage")
            yield OperationStrip(id="review-operation")

    def on_mount(self) -> None:
        self._apply_responsive_class(self.size.width)
        self.query_one("#questions-table", DataTable).add_columns(
            "Required", "Category", "Question", "Answer"
        )
        self.refresh_data(analyze=False)

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
            view, resume_case, history = await asyncio.gather(
                self.roleloop_app.invoke("get_job_review", self.job_id),
                self.roleloop_app.invoke_optional("get_resume", self.job_id),
                self.roleloop_app.invoke_optional("get_job_history", self.job_id),
            )
        except BaseException as error:
            if generation == self._request_generation:
                self.query_one("#review-error", Static).update(operation_error(error))
            return
        if generation != self._request_generation:
            return
        self.view = view
        self.resume_case = resume_case
        self.query_one("#review-error", Static).update(self.last_error)
        self._render_view(view, resume_case, history)
        del analyze

    def _render_view(self, view: Any, resume_case: Any, history: Any) -> None:
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
        self.query_one("#workflow-rail", Static).update(
            "  ".join(
                (
                    f"[review {review_status}]",
                    f"[eligibility {eligibility}]",
                    f"[decision {decision}]",
                    f"[résumé {resume}]",
                    f"[application {application}]",
                )
            )
        )
        description = str(field(job, "description", default="") or "No description supplied.")
        job_version = field(view, "job_version", default=None)
        sources = field(view, "sources", default=field(job_version, "sources", default=())) or ()
        source_lines = [
            f"  {enum_text(field(source, 'source_kind'), 'source')}: "
            f"{field(source, 'canonical_url', 'url', default='-')}"
            for source in sources
        ]
        screens = field(view, "screen_evaluations", default=()) or ()
        screen_lines = [
            f"  {enum_text(field(screen, 'result'), 'unknown').upper()} "
            f"{field(screen, 'rule_id', default='rule')}: "
            f"{field(screen, 'detail', default='')}"
            for screen in screens
        ]
        self.query_one("#review-summary", Static).update(
            "\n".join(
                (
                    f"Source      {field(job, 'source', default='manual')}",
                    f"URL         {field(job, 'canonical_url', 'url', default='-')}",
                    f"Updated     {compact_date(field(job, 'updated_at'))}",
                    "",
                    description,
                    "",
                    "RETAINED SOURCES",
                    *(source_lines or ["  No retained source links."]),
                    "",
                    "DETERMINISTIC SCREEN",
                    *(screen_lines or ["  No screen evaluation recorded."]),
                )
            )
        )
        self._render_evidence(review)
        self._render_questions(view, review)
        self._render_resume(view, resume_case)
        self._render_history(history, case)
        self._sync_actions(review_status, eligibility, resume, application)

    def show_error(self, message: str) -> None:
        self.last_error = message
        self.query_one("#review-error", Static).update(message)

    def clear_error(self) -> None:
        self.last_error = ""
        self.query_one("#review-error", Static).update("")

    def _render_evidence(self, review: Any | None) -> None:
        if review is None:
            missing = "Analysis is missing. Choose Analyze when you want Reviewer to run."
            self.query_one("#evidence-support", Static).update(f"CASE FOR\n+ {missing}")
            self.query_one("#evidence-skeptic", Static).update(f"SKEPTIC'S CASE\n! {missing}")
            return
        matches = field(review, "match_evidence", default=()) or ()
        skeptics = field(review, "skeptic_findings", default=()) or ()
        requirements = field(review, "requirements", default=()) or ()
        requirement_lines = [
            f"{'+ ' if field(item, 'required', default=False) else '  '}"
            f"{field(item, 'text', default='Requirement')}\n"
            f"    evidence: {field(item, 'evidence', default='-')}\n"
            f"    source: {field(item, 'source_anchor', default='-')}"
            for item in requirements
        ]
        support_lines = [
            "CASE FOR",
            *self._finding_lines(matches, "+"),
            "",
            "REQUIREMENTS",
            *(requirement_lines or ["  None recorded"]),
            "",
            f"POSITIONING  {field(review, 'positioning', default='-')}",
            f"CONFIDENCE   {field(review, 'confidence', default='-')}",
        ]
        skeptic_lines = [
            "SKEPTIC'S CASE",
            *self._finding_lines(skeptics, "!"),
            "",
            "SELF-CRITIQUE",
            str(field(review, "self_critique", default="-") or "-"),
        ]
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

    def _render_resume(self, view: Any, resume_case: Any | None) -> None:
        run = field(view, "latest_resume_run", "resume_run", default=None)
        if run is None:
            self.query_one("#resume-status", Static).update(
                "No résumé run yet. A current eligible review and Tailor decision "
                "start generation immediately."
            )
            return
        findings = field(run, "validation_findings", default=()) or ()
        provenance = field(run, "provenance", default=()) or ()
        artifact = field(run, "artifact", default=None)
        approval = enum_text(
            field(resume_case, "approval_status", default=None),
            enum_text(field(view, "resume_approval_status"), "none"),
        )
        lines = [
            f"Run         {item_id(run, 'run_id') or '-'}",
            f"Parent      {field(run, 'parent_resume_run_id', default='-') or '-'}",
            f"Stage       {enum_text(field(run, 'stage'))}",
            f"Gate 2      {approval}",
            f"Created     {compact_date(field(run, 'created_at'))}",
            f"Artifact    {field(artifact, 'uri', default='Not ready')}",
            f"PDF SHA-256 {field(artifact, 'checksum', default='-')}",
            f"Source Git  {field(run, 'renderer_source_revision', default='-') or '-'}",
            f"Pages       {field(run, 'rendered_page_count', default='-') or '-'}",
            "",
            "EXACT SELECTION",
        ]
        headline = field(run, "headline", default="")
        if headline:
            lines.append(f"Headline: {headline}")
        experiences = field(run, "selected_experiences", default=()) or ()
        for experience in experiences:
            bullets = field(experience, "bullet_ids", default=()) or ()
            lines.append(
                f"{field(experience, 'experience_id', default='experience')}: {', '.join(bullets)}"
            )
        skills = field(run, "selected_skill_ids", default=()) or ()
        lines.extend((f"Skills: {', '.join(skills) if skills else 'none'}", "", "VALIDATION"))
        if findings:
            for finding in findings:
                lines.append(
                    f"[{enum_text(field(finding, 'severity'))}] "
                    f"{field(finding, 'message', default='Finding')}"
                )
        else:
            lines.append("No validation findings recorded.")
        lines.extend(("", f"Provenance claims: {len(tuple(provenance))}"))
        runs = field(resume_case, "runs", default=()) or ()
        if runs:
            lines.extend(("", "LINEAGE"))
            for lineage_run in runs:
                parent = field(lineage_run, "parent_resume_run_id", default=None)
                lines.append(
                    f"{item_id(lineage_run, 'run_id') or '-'} <- {parent or 'gate 1'} "
                    f"[{enum_text(field(lineage_run, 'stage'), 'unknown')}]"
                )
                if parent:
                    parent_run = next(
                        (
                            candidate
                            for candidate in runs
                            if item_id(candidate, "run_id") == str(parent)
                        ),
                        None,
                    )
                    if parent_run is not None:
                        lines.extend(self._selection_diff_lines(parent_run, lineage_run))
        error = field(run, "error_message", "error", default="")
        if error:
            lines.extend(("", f"Failure: {error}"))
        self.query_one("#resume-status", Static).update("\n".join(lines))

    @staticmethod
    def _selection_diff_lines(parent_run: Any, child_run: Any) -> list[str]:
        """Render an ordered, ID-only diff between two exact v1 selections."""

        lines: list[str] = []
        before_headline = str(field(parent_run, "headline", default="") or "")
        after_headline = str(field(child_run, "headline", default="") or "")
        if before_headline != after_headline:
            lines.append(f'    headline: "{before_headline}" -> "{after_headline}"')

        before_experiences = JobReviewScreen._experience_selection(parent_run)
        after_experiences = JobReviewScreen._experience_selection(child_run)
        before_experience_ids = tuple(before_experiences)
        after_experience_ids = tuple(after_experiences)
        if before_experience_ids != after_experience_ids:
            lines.append(
                "    experience order: "
                f"{JobReviewScreen._ordered_values(before_experience_ids)} -> "
                f"{JobReviewScreen._ordered_values(after_experience_ids)}"
            )
            added_experiences = tuple(
                item for item in after_experience_ids if item not in before_experiences
            )
            removed_experiences = tuple(
                item for item in before_experience_ids if item not in after_experiences
            )
            if added_experiences:
                lines.append(
                    f"    experiences + {JobReviewScreen._ordered_values(added_experiences)}"
                )
            if removed_experiences:
                lines.append(
                    f"    experiences - {JobReviewScreen._ordered_values(removed_experiences)}"
                )

        experience_ids = (*after_experience_ids, *before_experience_ids)
        seen_experience_ids: set[str] = set()
        for experience_id in experience_ids:
            if experience_id in seen_experience_ids:
                continue
            seen_experience_ids.add(experience_id)
            before_bullets = before_experiences.get(experience_id, ())
            after_bullets = after_experiences.get(experience_id, ())
            if before_bullets == after_bullets:
                continue
            lines.append(
                f"    {experience_id} bullet order: "
                f"{JobReviewScreen._ordered_values(before_bullets)} -> "
                f"{JobReviewScreen._ordered_values(after_bullets)}"
            )
            added_bullets = tuple(item for item in after_bullets if item not in before_bullets)
            removed_bullets = tuple(item for item in before_bullets if item not in after_bullets)
            if added_bullets:
                lines.append(
                    f"    {experience_id} bullets + "
                    f"{JobReviewScreen._ordered_values(added_bullets)}"
                )
            if removed_bullets:
                lines.append(
                    f"    {experience_id} bullets - "
                    f"{JobReviewScreen._ordered_values(removed_bullets)}"
                )

        before_skills = tuple(field(parent_run, "selected_skill_ids", default=()) or ())
        after_skills = tuple(field(child_run, "selected_skill_ids", default=()) or ())
        if before_skills != after_skills:
            lines.append(
                "    skill order: "
                f"{JobReviewScreen._ordered_values(before_skills)} -> "
                f"{JobReviewScreen._ordered_values(after_skills)}"
            )
            added_skills = tuple(item for item in after_skills if item not in before_skills)
            removed_skills = tuple(item for item in before_skills if item not in after_skills)
            if added_skills:
                lines.append(f"    skills + {JobReviewScreen._ordered_values(added_skills)}")
            if removed_skills:
                lines.append(f"    skills - {JobReviewScreen._ordered_values(removed_skills)}")

        if not lines:
            lines.append("    selection unchanged")
        return lines

    @staticmethod
    def _experience_selection(run: Any) -> dict[str, tuple[str, ...]]:
        selections: dict[str, tuple[str, ...]] = {}
        for experience in field(run, "selected_experiences", default=()) or ():
            experience_id = str(field(experience, "experience_id", default="") or "")
            if experience_id:
                selections[experience_id] = tuple(
                    str(item) for item in field(experience, "bullet_ids", default=()) or ()
                )
        return selections

    @staticmethod
    def _ordered_values(values: Iterable[str]) -> str:
        ordered = tuple(values)
        return ", ".join(ordered) if ordered else "none"

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

    def _sync_actions(
        self,
        review_status: str,
        eligibility: str,
        resume: str,
        application: str,
    ) -> None:
        submitted = application == "submitted"
        self.query_one("#review-skip", Button).disabled = submitted
        self.query_one("#review-analyze", Button).label = (
            "Rerun analysis" if review_status == "current" else "Analyze"
        )
        no_current_resume_chain = resume in {"", "none", "stale"}
        self.query_one("#review-tailor", Button).disabled = not (
            review_status == "current"
            and eligibility == "eligible"
            and not submitted
            and no_current_resume_chain
        )
        run = field(self.view, "latest_resume_run", "resume_run", default=None)
        has_pdf = field(run, "artifact", default=None) is not None
        in_progress = resume in {"in progress", "in_progress"}
        self.query_one("#review-retry", Button).disabled = resume != "failed"
        self.query_one("#review-revise", Button).disabled = not has_pdf or in_progress
        self.query_one("#review-approve", Button).disabled = not has_pdf or in_progress
        self.query_one("#review-reject", Button).disabled = not has_pdf or in_progress
        self.query_one("#review-open", Button).disabled = not has_pdf
        self.query_one("#review-export", Button).disabled = not has_pdf
        approval = enum_text(
            field(self.resume_case, "approval_status", default=None),
            enum_text(field(self.view, "resume_approval_status"), "none"),
        )
        self.query_one("#review-submit", Button).disabled = submitted or approval != "approved"
        self.query_one("#review-stage", Button).disabled = not submitted

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

    @on(Button.Pressed, "#review-analyze")
    def analyze_button(self) -> None:
        self.action_analyze()

    @on(Button.Pressed, "#review-retry")
    def retry_button(self) -> None:
        self.action_retry()

    @on(Button.Pressed, "#review-revise")
    def revise_button(self) -> None:
        self.action_revise()

    @on(Button.Pressed, "#review-approve")
    def approve_button(self) -> None:
        self.action_approve()

    @on(Button.Pressed, "#review-reject")
    def reject_button(self) -> None:
        self.action_reject()

    @on(Button.Pressed, "#review-open")
    def open_button(self) -> None:
        self._run_mutation(self._open_pdf)

    @on(Button.Pressed, "#review-export")
    def export_button(self) -> None:
        self._run_mutation(self._export_pdf)

    @on(Button.Pressed, "#review-submit")
    def submit_button(self) -> None:
        self.action_submit()

    @on(Button.Pressed, "#review-stage")
    def stage_button(self) -> None:
        self.action_stage()

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_refresh(self) -> None:
        self.refresh_data(analyze=False)

    def action_analyze(self) -> None:
        if self.view is None:
            return
        rerun = enum_text(field(self.view, "review_status"), "missing") == "current"
        self.roleloop_app.start_operation(
            f"review:{self.job_id}",
            "Rerun analysis" if rerun else "Analyze job",
            "review_job",
            self.job_id,
            rerun,
            job_id=self.job_id,
        )

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
            if decision == "tailor":
                confirmed = await self.app.push_screen_wait(
                    ConfirmActionModal(
                        "Tailor and generate now?",
                        "Gate 1 will be recorded and the Resume agent will immediately "
                        "select exact evidence and render a new immutable PDF.",
                        "Tailor and generate",
                    )
                )
                if not confirmed:
                    return
                self.roleloop_app.start_operation(
                    f"tailor:{self.job_id}",
                    "Tailor résumé",
                    "decide_job",
                    self.job_id,
                    decision,
                    job_id=self.job_id,
                )
                return
            await self.roleloop_app.invoke("decide_job", self.job_id, decision)
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Decision not saved")
        finally:
            self._mutation_busy = False
            self.refresh_data()

    def action_retry(self) -> None:
        self.roleloop_app.start_operation(
            f"resume-retry:{self.job_id}",
            "Retry résumé",
            "retry_resume",
            self.job_id,
            job_id=self.job_id,
        )

    def action_revise(self) -> None:
        self._run_mutation(self._revise)

    async def _revise(self) -> None:
        feedback = await self.app.push_screen_wait(ResumeFeedbackModal())
        if feedback is None:
            return
        self.roleloop_app.start_operation(
            f"resume-revise:{self.job_id}",
            "Revise résumé",
            "revise_resume",
            self.job_id,
            feedback,
            job_id=self.job_id,
        )

    def action_approve(self) -> None:
        self._run_mutation(self._approve)

    async def _approve(self) -> None:
        run = self._current_run()
        artifact = field(run, "artifact", default={})
        confirmed = await self.app.push_screen_wait(
            ConfirmActionModal(
                "Approve this exact PDF?",
                f"Run: {item_id(run, 'run_id')}\nSHA-256: "
                f"{field(artifact, 'checksum', default='-')}\n\n"
                "Approval is bound to this artifact and checksum.",
                "Approve PDF",
            )
        )
        if not confirmed:
            return
        await self.roleloop_app.invoke(
            "approve_resume",
            self.job_id,
            item_id(run, "run_id"),
        )
        self.refresh_data()

    def action_reject(self) -> None:
        self._run_mutation(self._reject)

    async def _reject(self) -> None:
        run = self._current_run()
        confirmed = await self.app.push_screen_wait(
            ConfirmActionModal(
                "Reject this PDF?",
                "The run remains in history and cannot authorize submission.",
                "Reject PDF",
                danger=True,
            )
        )
        if not confirmed:
            return
        await self.roleloop_app.invoke(
            "reject_resume",
            self.job_id,
            item_id(run, "run_id"),
            "",
        )
        self.refresh_data()

    async def _open_pdf(self) -> None:
        artifact = field(self._current_run(), "artifact", default={})
        await self.roleloop_app.invoke("open_artifact", item_id(artifact, "artifact_id"))

    async def _export_pdf(self) -> None:
        artifact = field(self._current_run(), "artifact", default={})
        destination = await self.app.push_screen_wait(ExportPathModal())
        if destination is None:
            return
        await self.roleloop_app.invoke(
            "export_artifact",
            item_id(artifact, "artifact_id"),
            destination,
        )

    def action_submit(self) -> None:
        self._run_mutation(self._submit)

    async def _submit(self) -> None:
        values = await self.app.push_screen_wait(SubmissionModal())
        if values is None:
            return
        await self.roleloop_app.invoke(
            "submit_application",
            self.job_id,
            values["follow_up"],
            values["note"],
        )
        self.refresh_data()

    def action_stage(self) -> None:
        self._run_mutation(self._stage)

    async def _stage(self) -> None:
        values = await self.app.push_screen_wait(ApplicationStageModal())
        if values is None:
            return
        await self.roleloop_app.invoke("record_application_stage", self.job_id, values)
        self.refresh_data()

    def _current_run(self) -> Any:
        run = field(self.view, "latest_resume_run", "resume_run", default=None)
        if run is None:
            raise RuntimeError("No résumé run is available.")
        return run

    def _run_mutation(self, operation: Any) -> None:
        if self.view is None or self._mutation_busy:
            return
        self.run_worker(
            partial(self._guard_mutation, operation),  # type: ignore[arg-type]
            exit_on_error=False,
        )

    async def _guard_mutation(self, operation: Any) -> None:
        self._mutation_busy = True
        try:
            await operation()
        except BaseException as error:
            self.roleloop_app.report_error(operation_error(error), title="Action failed")
        finally:
            self._mutation_busy = False
            self.refresh_data()
