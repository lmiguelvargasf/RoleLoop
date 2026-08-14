"""Typed modal interactions for RoleLoop's Textual adapter."""

from __future__ import annotations

from datetime import date
from typing import Any, ClassVar

from textual import on
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Input, Label, Select, Static, TextArea

from .presentation import csv_text, csv_values, field


class ConfirmActionModal(ModalScreen[bool]):
    """A confirmation that makes the safe action the keyboard default."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    def __init__(
        self,
        title: str,
        body: str,
        confirm_label: str,
        *,
        danger: bool = False,
    ) -> None:
        super().__init__()
        self.title_text = title
        self.body_text = body
        self.confirm_label = confirm_label
        self.danger = danger

    def compose(self) -> ComposeResult:
        with Grid(id="confirm-dialog"):
            yield Label(self.title_text, id="confirm-title")
            yield Static(self.body_text, id="confirm-body", markup=False)
            yield Button("Cancel", id="confirm-cancel", variant="primary")
            yield Button(
                self.confirm_label,
                id="confirm-action",
                variant="error" if self.danger else "success",
            )

    def on_mount(self) -> None:
        self.query_one("#confirm-cancel", Button).focus()

    @on(Button.Pressed, "#confirm-cancel")
    def cancel_button(self) -> None:
        self.dismiss(False)

    @on(Button.Pressed, "#confirm-action")
    def confirm_button(self) -> None:
        self.query_one("#confirm-action", Button).disabled = True
        self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)


class AddJobModal(ModalScreen[dict[str, Any] | None]):
    """Capture a URL and optional manual job detail without fetching it."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="form-dialog"):
            yield Label("Add a job", classes="dialog-title")
            yield Label("Job URL", classes="field-label")
            yield Input(placeholder="https://…", id="job-url")
            yield Label("Role (optional)", classes="field-label")
            yield Input(id="job-title")
            yield Label("Company (optional)", classes="field-label")
            yield Input(id="job-company")
            yield Label("Location (optional)", classes="field-label")
            yield Input(id="job-location")
            yield Label("Manual details (optional)", classes="field-label")
            yield TextArea(id="job-details")
            yield Static("", id="form-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="form-cancel")
                yield Button("Add job", id="form-submit", variant="success")

    def on_mount(self) -> None:
        self.query_one("#job-url", Input).focus()

    @on(Button.Pressed, "#form-submit")
    def submit(self) -> None:
        url = self.query_one("#job-url", Input).value.strip()
        if not url:
            self.query_one("#form-error", Static).update("Enter a job URL.")
            return
        result = {
            "url": url,
            "details": {
                "title": self.query_one("#job-title", Input).value.strip(),
                "company": self.query_one("#job-company", Input).value.strip(),
                "location": self.query_one("#job-location", Input).value.strip(),
                "description": self.query_one("#job-details", TextArea).text.strip(),
            },
        }
        self.dismiss(result)

    @on(Button.Pressed, "#form-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class QuestionAnswerModal(ModalScreen[str | None]):
    """Answer an analyzer-supplied yes/no/unknown question."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    OPTIONS = (("Yes", "yes"), ("No", "no"), ("Unknown", "unknown"))

    def __init__(self, question: Any) -> None:
        super().__init__()
        self.question = question

    def compose(self) -> ComposeResult:
        prompt = str(field(self.question, "prompt", "question", "text", default="Question"))
        current = str(field(self.question, "answer", default="unknown") or "unknown")
        with Grid(id="question-dialog"):
            yield Label("Verification question", classes="dialog-title")
            yield Static(prompt, id="question-prompt", markup=False)
            yield Select(self.OPTIONS, value=current, allow_blank=False, id="question-answer")
            yield Button("Cancel", id="question-cancel")
            yield Button("Save answer", id="question-save", variant="success")

    def on_mount(self) -> None:
        self.query_one("#question-answer", Select).focus()

    @on(Button.Pressed, "#question-save")
    def save(self) -> None:
        value = self.query_one("#question-answer", Select).value
        self.dismiss(str(value))

    @on(Button.Pressed, "#question-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class OutcomeModal(ModalScreen[str | None]):
    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    OUTCOMES = (
        ("Interviewing", "interviewing"),
        ("Offer", "offer"),
        ("Rejected", "rejected"),
        ("Withdrawn", "withdrawn"),
        ("No response", "no_response"),
    )

    def __init__(self, current: str = "interviewing") -> None:
        super().__init__()
        self.current = (
            current if current in {value for _, value in self.OUTCOMES} else "interviewing"
        )

    def compose(self) -> ComposeResult:
        with Grid(id="outcome-dialog"):
            yield Label("Record application outcome", classes="dialog-title")
            yield Select(
                self.OUTCOMES,
                value=self.current,
                allow_blank=False,
                id="outcome-value",
            )
            yield Button("Cancel", id="outcome-cancel")
            yield Button("Save outcome", id="outcome-save", variant="success")

    def on_mount(self) -> None:
        self.query_one("#outcome-value", Select).focus()

    @on(Button.Pressed, "#outcome-save")
    def save(self) -> None:
        self.dismiss(str(self.query_one("#outcome-value", Select).value))

    @on(Button.Pressed, "#outcome-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ResumeFeedbackModal(ModalScreen[str | None]):
    """Capture feedback that must create a child résumé run."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="path-dialog"):
            yield Label("Request résumé changes", classes="dialog-title")
            yield Static(
                "Describe the change in positioning or selection. The current PDF remains "
                "immutable and RoleLoop creates a child run.",
                markup=False,
            )
            yield TextArea(id="resume-feedback")
            yield Static("", id="resume-feedback-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="resume-feedback-cancel")
                yield Button("Create child run", id="resume-feedback-save", variant="success")

    def on_mount(self) -> None:
        self.query_one("#resume-feedback", TextArea).focus()

    @on(Button.Pressed, "#resume-feedback-save")
    def save(self) -> None:
        feedback = self.query_one("#resume-feedback", TextArea).text.strip()
        if not feedback:
            self.query_one("#resume-feedback-error", Static).update(
                "Enter the changes you want reviewed."
            )
            return
        self.dismiss(feedback)

    @on(Button.Pressed, "#resume-feedback-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class SubmissionModal(ModalScreen[dict[str, str] | None]):
    """Require the operator to choose the first follow-up date."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="path-dialog"):
            yield Label("Record manual submission", classes="dialog-title")
            yield Static(
                "Only the approved RoleLoop PDF can be submitted. Enter the first date on "
                "which you want this application to appear in the follow-up queue.",
                markup=False,
            )
            yield Label("First follow-up date (YYYY-MM-DD)", classes="field-label")
            yield Input(placeholder="2026-08-21", id="submission-follow-up")
            yield Label("Note (optional)", classes="field-label")
            yield Input(id="submission-note")
            yield Static("", id="submission-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="submission-cancel")
                yield Button("Record submission", id="submission-save", variant="success")

    def on_mount(self) -> None:
        self.query_one("#submission-follow-up", Input).focus()

    @on(Button.Pressed, "#submission-save")
    def save(self) -> None:
        follow_up = self.query_one("#submission-follow-up", Input).value.strip()
        if not _valid_iso_date(follow_up):
            self.query_one("#submission-error", Static).update(
                "Enter a valid follow-up date as YYYY-MM-DD."
            )
            return
        self.dismiss(
            {
                "follow_up": follow_up,
                "note": self.query_one("#submission-note", Input).value.strip(),
            }
        )

    @on(Button.Pressed, "#submission-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class FollowUpRescheduleModal(ModalScreen[dict[str, str] | None]):
    """Choose a replacement date for one existing follow-up."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="path-dialog"):
            yield Label("Reschedule follow-up", classes="dialog-title")
            yield Label("Replacement date (YYYY-MM-DD)", classes="field-label")
            yield Input(placeholder="2026-08-28", id="reschedule-date")
            yield Label("Note (optional)", classes="field-label")
            yield Input(id="reschedule-note")
            yield Static("", id="reschedule-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="reschedule-cancel")
                yield Button("Reschedule", id="reschedule-save", variant="success")

    def on_mount(self) -> None:
        self.query_one("#reschedule-date", Input).focus()

    @on(Button.Pressed, "#reschedule-save")
    def save(self) -> None:
        due_date = self.query_one("#reschedule-date", Input).value.strip()
        if not _valid_iso_date(due_date):
            self.query_one("#reschedule-error", Static).update(
                "Enter a valid replacement date as YYYY-MM-DD."
            )
            return
        self.dismiss(
            {
                "date": due_date,
                "note": self.query_one("#reschedule-note", Input).value.strip(),
            }
        )

    @on(Button.Pressed, "#reschedule-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ApplicationStageModal(ModalScreen[dict[str, Any] | None]):
    """Record a fixed application stage and an explicit follow-up choice."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]
    STAGES = (
        ("Acknowledged", "acknowledged"),
        ("Recruiter screen", "recruiter_screen"),
        ("Hiring-manager screen", "hiring_manager_screen"),
        ("Assessment", "assessment"),
        ("Technical interview", "technical_interview"),
        ("Final / onsite", "final_or_onsite"),
        ("Offer", "offer"),
        ("Rejected", "rejected"),
        ("Withdrawn", "withdrawn"),
        ("No response", "no_response"),
    )
    TERMINAL = frozenset({"offer", "rejected", "withdrawn", "no_response"})
    FOLLOW_UP_CHOICES = (
        ("Set replacement date", "replace"),
        ("No follow-up", "none"),
    )

    def __init__(self, current: str = "acknowledged") -> None:
        super().__init__()
        available = {value for _, value in self.STAGES}
        self.current = current if current in available else "acknowledged"

    def compose(self) -> ComposeResult:
        with Vertical(id="profile-dialog"):
            with VerticalScroll(id="profile-fields"):
                yield Label("Record application stage", classes="dialog-title")
                yield Label("Stage", classes="field-label")
                yield Select(
                    self.STAGES,
                    value=self.current,
                    allow_blank=False,
                    id="application-stage",
                )
                yield Label("Follow-up choice", classes="field-label")
                yield Select(
                    self.FOLLOW_UP_CHOICES,
                    value="replace",
                    allow_blank=False,
                    id="application-follow-up-choice",
                )
                yield Label(
                    "Replacement follow-up date (YYYY-MM-DD)",
                    classes="field-label",
                    id="application-follow-up-label",
                )
                yield Input(placeholder="2026-08-28", id="application-follow-up")
                yield Label("Stage note (optional)", classes="field-label")
                yield TextArea(id="application-stage-note")
                yield Static("", id="application-stage-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="application-stage-cancel")
                yield Button("Record stage", id="application-stage-save", variant="success")

    def on_mount(self) -> None:
        self._sync_follow_up_fields()
        self.query_one("#application-stage", Select).focus()

    @on(Select.Changed, "#application-stage")
    @on(Select.Changed, "#application-follow-up-choice")
    def choice_changed(self) -> None:
        self._sync_follow_up_fields()

    def _sync_follow_up_fields(self) -> None:
        stage = str(self.query_one("#application-stage", Select).value)
        terminal = stage in self.TERMINAL
        choice = self.query_one("#application-follow-up-choice", Select)
        if terminal:
            choice.value = "none"
        choice.disabled = terminal
        replace = not terminal and str(choice.value) == "replace"
        self.query_one("#application-follow-up-label", Label).display = replace
        self.query_one("#application-follow-up", Input).display = replace

    @on(Button.Pressed, "#application-stage-save")
    def save(self) -> None:
        stage = str(self.query_one("#application-stage", Select).value)
        choice = str(self.query_one("#application-follow-up-choice", Select).value)
        follow_up = self.query_one("#application-follow-up", Input).value.strip()
        if stage not in self.TERMINAL and choice == "replace" and not _valid_iso_date(follow_up):
            self.query_one("#application-stage-error", Static).update(
                "Enter a valid replacement date as YYYY-MM-DD or choose no follow-up."
            )
            return
        self.dismiss(
            {
                "stage": stage,
                "follow_up": follow_up if choice == "replace" else None,
                "no_follow_up": choice == "none",
                "note": self.query_one("#application-stage-note", TextArea).text.strip(),
            }
        )

    @on(Button.Pressed, "#application-stage-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ExportPathModal(ModalScreen[str | None]):
    """Choose a destination without allowing the TUI to read artifact bytes."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    def __init__(self, suggested_name: str = "tailored-resume.pdf") -> None:
        super().__init__()
        self.suggested_name = suggested_name

    def compose(self) -> ComposeResult:
        with Vertical(id="path-dialog"):
            yield Label("Export approved artifact", classes="dialog-title")
            yield Label("Destination path", classes="field-label")
            yield Input(placeholder=f"/absolute/path/{self.suggested_name}", id="export-path")
            yield Static("", id="export-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="export-cancel")
                yield Button("Export", id="export-save", variant="success")

    def on_mount(self) -> None:
        self.query_one("#export-path", Input).focus()

    @on(Button.Pressed, "#export-save")
    def save(self) -> None:
        destination = self.query_one("#export-path", Input).value.strip()
        if not destination:
            self.query_one("#export-error", Static).update("Enter a destination path.")
            return
        self.dismiss(destination)

    @on(Button.Pressed, "#export-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


def _valid_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


class EvidencePathModal(ModalScreen[dict[str, str] | None]):
    """Capture either a PDF/text path or pasted UTF-8 résumé evidence."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    SOURCES = (("PDF or text file", "path"), ("Paste UTF-8 text", "text"))

    def __init__(self, *, optional: bool = False) -> None:
        super().__init__()
        self.optional = optional

    def compose(self) -> ComposeResult:
        with Vertical(id="path-dialog"):
            with VerticalScroll(id="evidence-fields"):
                yield Label("Import résumé evidence", classes="dialog-title")
                yield Static(
                    "Choose a local PDF/plain-text file or paste UTF-8 text. "
                    "RoleLoop copies and versions the evidence.",
                    markup=False,
                )
                yield Label("Evidence source", classes="field-label")
                yield Select(
                    self.SOURCES,
                    value="path",
                    allow_blank=False,
                    id="evidence-kind",
                )
                yield Label(
                    "PDF or text-file path",
                    id="evidence-path-label",
                    classes="field-label",
                )
                yield Input(placeholder="/path/to/resume.pdf", id="evidence-path")
                yield Label(
                    "Pasted text source name",
                    id="evidence-source-name-label",
                    classes="field-label",
                )
                yield Input(placeholder="resume.txt", id="evidence-source-name")
                yield Label(
                    "Pasted résumé text",
                    id="evidence-text-label",
                    classes="field-label",
                )
                yield TextArea(id="evidence-text")
                yield Static("", id="path-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button(
                    "Skip for now" if self.optional else "Cancel",
                    id="path-cancel",
                )
                yield Button("Continue", id="path-continue", variant="success")

    def on_mount(self) -> None:
        self._sync_source_fields()

    @on(Select.Changed, "#evidence-kind")
    def source_changed(self) -> None:
        self._sync_source_fields()

    def _sync_source_fields(self) -> None:
        text_source = str(self.query_one("#evidence-kind", Select).value) == "text"
        for selector in ("#evidence-source-name-label", "#evidence-source-name"):
            self.query_one(selector).display = text_source
        for selector in ("#evidence-text-label", "#evidence-text"):
            self.query_one(selector).display = text_source
        for selector in ("#evidence-path-label", "#evidence-path"):
            self.query_one(selector).display = not text_source
        if text_source:
            self.query_one("#evidence-text", TextArea).focus()
        else:
            self.query_one("#evidence-path", Input).focus()

    @on(Button.Pressed, "#path-continue")
    def continue_import(self) -> None:
        kind = str(self.query_one("#evidence-kind", Select).value)
        if kind == "path":
            path = self.query_one("#evidence-path", Input).value.strip()
            if not path:
                self.query_one("#path-error", Static).update("Enter a file path.")
                return
            self.dismiss({"kind": "path", "path": path})
            return
        text = self.query_one("#evidence-text", TextArea).text.strip()
        source_name = self.query_one("#evidence-source-name", Input).value.strip()
        if not text:
            self.query_one("#path-error", Static).update("Paste résumé text.")
            return
        self.dismiss(
            {
                "kind": "text",
                "text": text,
                "source_name": source_name or "pasted-resume.txt",
            }
        )

    @on(Button.Pressed, "#path-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ResumeSourceModal(ModalScreen[dict[str, Any] | None]):
    """Configure a persistent local or remote Git master résumé source."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]
    KINDS = (("Local Git repository", "local_git"), ("Remote Git repository", "remote_git"))

    def __init__(self, source: Any | None = None) -> None:
        super().__init__()
        self.source = source

    def compose(self) -> ComposeResult:
        kind = field(self.source, "kind", default="local_git")
        kind = getattr(kind, "value", kind)
        if kind not in {value for _, value in self.KINDS}:
            kind = "local_git"
        with Vertical(id="resume-source-dialog"):
            with VerticalScroll(id="resume-source-fields"):
                yield Label("Master résumé repository", classes="dialog-title")
                yield Static(
                    "Analyze automatically resolves and archives an exact clean Git commit. "
                    "RoleLoop executes only roleloop_contract/v1/cli.py from that snapshot; "
                    "existing evidence and generated artifacts remain immutable.",
                    classes="dialog-copy",
                    markup=False,
                )
                yield Label("Repository kind", classes="field-label")
                yield Select(
                    self.KINDS,
                    value=kind,
                    allow_blank=False,
                    id="resume-source-kind",
                )
                yield Label("Repository", classes="field-label")
                yield Input(
                    value=str(field(self.source, "repository", default="") or ""),
                    id="resume-source-repository",
                )
                yield Label("Git ref — optional", classes="field-label")
                yield Input(
                    value=str(field(self.source, "ref", default="") or ""),
                    placeholder="HEAD locally; main remotely",
                    id="resume-source-ref",
                )
                yield Label("Fixed trusted bridge", classes="field-label")
                yield Input(
                    value="roleloop_contract/v1/cli.py",
                    id="resume-source-document-path",
                    disabled=True,
                )
                yield Checkbox(
                    "I trust this repository/ref and its future commits to execute "
                    "the fixed bridge",
                    value=field(self.source, "trust_acknowledged_at", default=None) is not None,
                    id="resume-source-trust",
                )
                yield Static("", id="resume-source-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                yield Button("Cancel", id="resume-source-cancel")
                yield Button("Save source", id="resume-source-save", variant="success")

    def on_mount(self) -> None:
        self._sync_repository_placeholder()
        self.query_one("#resume-source-repository", Input).focus()

    @on(Select.Changed, "#resume-source-kind")
    def kind_changed(self) -> None:
        self._sync_repository_placeholder()

    def _sync_repository_placeholder(self) -> None:
        kind = str(self.query_one("#resume-source-kind", Select).value)
        placeholder = (
            "/absolute/path/to/resume-repository"
            if kind == "local_git"
            else "git@example.com:owner/resume.git"
        )
        self.query_one("#resume-source-repository", Input).placeholder = placeholder

    @on(Button.Pressed, "#resume-source-save")
    def save(self) -> None:
        repository = self.query_one("#resume-source-repository", Input).value.strip()
        if not repository:
            self.query_one("#resume-source-error", Static).update("Enter a repository.")
            return
        if not self.query_one("#resume-source-trust", Checkbox).value:
            self.query_one("#resume-source-error", Static).update(
                "Acknowledge that this trusted repository executes code during sync and render."
            )
            return
        self.dismiss(
            {
                "kind": str(self.query_one("#resume-source-kind", Select).value),
                "repository": repository,
                "ref": self.query_one("#resume-source-ref", Input).value.strip(),
                "document_path": "roleloop_contract/v1/cli.py",
                "trust_repository": True,
            }
        )

    @on(Button.Pressed, "#resume-source-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ProfileModal(ModalScreen[dict[str, Any] | None]):
    """Create or edit a practical search profile."""

    BINDINGS: ClassVar = [("escape", "cancel", "Cancel")]

    WORK_MODES = (
        ("Any work mode", "any"),
        ("Remote", "remote"),
        ("Hybrid", "hybrid"),
        ("On-site", "onsite"),
    )
    PROVIDERS = (("Demo — deterministic and offline", "demo"), ("OpenAI", "openai"))
    PAPER_SIZES = (("A4", "a4paper"), ("US Letter", "letterpaper"))
    REASONING_EFFORTS = (
        ("Low", "low"),
        ("Medium", "medium"),
        ("High", "high"),
        ("Extra high", "xhigh"),
    )

    def __init__(self, profile: Any | None = None, *, onboarding: bool = False) -> None:
        super().__init__()
        self.profile = profile
        self.onboarding = onboarding

    def compose(self) -> ComposeResult:
        title = (
            "Set up RoleLoop"
            if self.onboarding
            else ("Edit search profile" if self.profile is not None else "Create search profile")
        )
        salary = field(self.profile, "annual_salary_floor", default="")
        remote_preference = field(self.profile, "remote_preference", default="any")
        remote_preference = getattr(remote_preference, "value", remote_preference)
        if remote_preference not in {value for _, value in self.WORK_MODES}:
            remote_preference = "any"
        provider = _profile_provider(self.profile)
        if provider not in {value for _, value in self.PROVIDERS}:
            provider = Select.NULL
        paper_size = str(field(self.profile, "paper_size", default="a4paper") or "a4paper")
        if paper_size == "A4":
            paper_size = "a4paper"
        if paper_size not in {value for _, value in self.PAPER_SIZES}:
            paper_size = "a4paper"
        with Vertical(id="profile-dialog"):
            with VerticalScroll(id="profile-fields"):
                yield Label(title, classes="dialog-title")
                if self.onboarding:
                    yield Static(
                        "Create one active profile and explicitly choose Demo or OpenAI. "
                        "Secrets are never stored in the profile.",
                        classes="dialog-copy",
                        markup=False,
                    )
                yield Label("Agent provider", classes="field-label")
                yield Select(
                    self.PROVIDERS,
                    value=provider,
                    allow_blank=True,
                    prompt="Choose Demo or OpenAI",
                    id="profile-provider",
                )
                yield Label("Profile name", classes="field-label")
                yield Input(
                    value=str(field(self.profile, "name", default="") or ""),
                    id="profile-name",
                )
                yield Label("Target roles — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "target_roles", "roles", default="")),
                    id="profile-roles",
                )
                yield Label("Locations — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "locations", default="")),
                    id="profile-locations",
                )
                yield Label("Work mode", classes="field-label")
                yield Select(
                    self.WORK_MODES,
                    value=remote_preference,
                    allow_blank=False,
                    id="profile-work-mode",
                )
                yield Label("Employment types — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "employment_types", default="")),
                    placeholder="full-time, contract",
                    id="profile-employment-types",
                )
                yield Label("Seniority — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "seniority", default="")),
                    placeholder="senior, staff",
                    id="profile-seniority",
                )
                yield Label("Minimum annual salary (optional)", classes="field-label")
                yield Input(value=str(salary or ""), type="integer", id="profile-salary")
                yield Label("Salary currency", classes="field-label")
                yield Input(
                    value=str(field(self.profile, "salary_currency", default="USD") or "USD"),
                    id="profile-currency",
                )
                yield Label("Include keywords — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "include_keywords", default="")),
                    id="profile-include-keywords",
                )
                yield Label("Exclude keywords — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "exclude_keywords", default="")),
                    id="profile-exclude-keywords",
                )
                yield Label("Other constraints", classes="field-label")
                yield TextArea(
                    str(field(self.profile, "constraints", default="") or ""),
                    id="profile-constraints",
                )
                yield Label("Residence country", classes="field-label")
                yield Input(
                    value=str(field(self.profile, "residence_country", default="Ecuador")),
                    id="profile-residence-country",
                )
                yield Label("Timezone", classes="field-label")
                yield Input(
                    value=str(field(self.profile, "timezone", default="America/Guayaquil")),
                    id="profile-timezone",
                )
                yield Label(
                    "Target headquarters countries — comma separated",
                    classes="field-label",
                )
                yield Input(
                    value=csv_text(field(self.profile, "target_hq_countries", default=())),
                    placeholder="United States",
                    id="profile-hq-countries",
                )
                yield Checkbox(
                    "Require a startup",
                    value=bool(field(self.profile, "startup_required", default=False)),
                    id="profile-startup-required",
                )
                yield Label("Accepted remote arrangements — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "accepted_remote_arrangements", default=())),
                    placeholder="global remote, remote from Ecuador",
                    id="profile-remote-arrangements",
                )
                yield Label("Accepted hiring arrangements — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "accepted_hiring_arrangements", default=())),
                    placeholder="employee of record, contractor",
                    id="profile-hiring-arrangements",
                )
                yield Label("Scout search queries — comma separated", classes="field-label")
                yield Input(
                    value=csv_text(field(self.profile, "search_queries", default=())),
                    id="profile-search-queries",
                )
                yield Label("Résumé paper size", classes="field-label")
                yield Select(
                    self.PAPER_SIZES,
                    value=paper_size,
                    allow_blank=False,
                    id="profile-paper-size",
                )
                yield Label("Résumé page limit (1-5)", classes="field-label")
                yield Input(
                    value=str(field(self.profile, "page_limit", default=2) or 2),
                    type="integer",
                    id="profile-page-limit",
                )
                for agent_name in ("scout", "reviewer", "resume"):
                    display_name = agent_name.capitalize()
                    yield Label(f"{display_name} model", classes="field-label")
                    yield Input(
                        value=_agent_setting(
                            self.profile,
                            agent_name,
                            "model",
                            "gpt-5.6-terra",
                        ),
                        id=f"profile-{agent_name}-model",
                    )
                    yield Label(f"{display_name} reasoning effort", classes="field-label")
                    yield Select(
                        self.REASONING_EFFORTS,
                        value=_agent_setting(
                            self.profile,
                            agent_name,
                            "reasoning_effort",
                            "medium",
                        ),
                        allow_blank=False,
                        id=f"profile-{agent_name}-effort",
                    )
                yield Static("", id="profile-error", classes="form-error", markup=False)
            with Horizontal(classes="dialog-actions"):
                if not self.onboarding:
                    yield Button("Cancel", id="profile-cancel")
                yield Button(
                    "Create active profile" if self.onboarding else "Save profile",
                    id="profile-save",
                    variant="success",
                )

    def on_mount(self) -> None:
        self.query_one("#profile-name", Input).focus()

    @on(Button.Pressed, "#profile-save")
    def save(self) -> None:
        name = self.query_one("#profile-name", Input).value.strip()
        roles = csv_values(self.query_one("#profile-roles", Input).value)
        salary_text = self.query_one("#profile-salary", Input).value.strip()
        provider = self.query_one("#profile-provider", Select).value
        page_limit_text = self.query_one("#profile-page-limit", Input).value.strip()
        if provider is Select.NULL:
            self.query_one("#profile-error", Static).update("Choose Demo or OpenAI.")
            return
        if not name:
            self.query_one("#profile-error", Static).update("Enter a profile name.")
            return
        if not roles:
            self.query_one("#profile-error", Static).update("Enter at least one target role.")
            return
        try:
            page_limit = int(page_limit_text)
        except ValueError:
            page_limit = 0
        if not 1 <= page_limit <= 5:
            self.query_one("#profile-error", Static).update(
                "Résumé page limit must be between 1 and 5."
            )
            return
        models = {
            agent_name: self.query_one(f"#profile-{agent_name}-model", Input).value.strip()
            for agent_name in ("scout", "reviewer", "resume")
        }
        if not all(models.values()):
            self.query_one("#profile-error", Static).update(
                "Enter a model for Scout, Reviewer, and Resume."
            )
            return
        result: dict[str, Any] = {
            "agent_provider": str(provider),
            "name": name,
            "target_roles": roles,
            "locations": csv_values(self.query_one("#profile-locations", Input).value),
            "remote_preference": str(self.query_one("#profile-work-mode", Select).value),
            "employment_types": csv_values(
                self.query_one("#profile-employment-types", Input).value
            ),
            "seniority": csv_values(self.query_one("#profile-seniority", Input).value),
            "annual_salary_floor": int(salary_text) if salary_text else None,
            "salary_currency": self.query_one("#profile-currency", Input).value.strip() or "USD",
            "include_keywords": csv_values(
                self.query_one("#profile-include-keywords", Input).value
            ),
            "exclude_keywords": csv_values(
                self.query_one("#profile-exclude-keywords", Input).value
            ),
            "constraints": self.query_one("#profile-constraints", TextArea).text.strip(),
            "residence_country": self.query_one("#profile-residence-country", Input).value.strip(),
            "timezone": self.query_one("#profile-timezone", Input).value.strip(),
            "target_hq_countries": csv_values(self.query_one("#profile-hq-countries", Input).value),
            "startup_required": self.query_one("#profile-startup-required", Checkbox).value,
            "accepted_remote_arrangements": csv_values(
                self.query_one("#profile-remote-arrangements", Input).value
            ),
            "accepted_hiring_arrangements": csv_values(
                self.query_one("#profile-hiring-arrangements", Input).value
            ),
            "search_queries": csv_values(self.query_one("#profile-search-queries", Input).value),
            "paper_size": str(self.query_one("#profile-paper-size", Select).value),
            "page_limit": page_limit,
            "agent_configurations": tuple(
                {
                    "kind": agent_name,
                    "provider": str(provider),
                    "model": models[agent_name],
                    "reasoning_effort": str(
                        self.query_one(f"#profile-{agent_name}-effort", Select).value
                    ),
                }
                for agent_name in ("scout", "reviewer", "resume")
            ),
        }
        self.dismiss(result)

    @on(Button.Pressed, "#profile-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        if not self.onboarding:
            self.dismiss(None)


def _agent_setting(profile: Any | None, kind: str, setting: str, default: str) -> str:
    configurations = field(profile, "agent_configurations", default=()) or ()
    for configuration in configurations:
        configured_kind = field(configuration, "kind", default="")
        configured_kind = getattr(configured_kind, "value", configured_kind)
        if configured_kind == kind:
            value = str(field(configuration, setting, default=default) or default)
            return value
    return default


def _profile_provider(profile: Any | None) -> Any:
    provider = field(profile, "agent_provider", default=None)
    provider = getattr(provider, "value", provider)
    if provider:
        return provider
    configurations = field(profile, "agent_configurations", default=()) or ()
    configured = {
        getattr(
            field(item, "provider", default=None), "value", field(item, "provider", default=None)
        )
        for item in configurations
        if field(item, "provider", default=None) is not None
    }
    return next(iter(configured)) if len(configured) == 1 else None
