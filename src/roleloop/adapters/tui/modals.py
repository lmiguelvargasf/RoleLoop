"""Typed modal interactions for RoleLoop's Textual adapter."""

from __future__ import annotations

from typing import Any, ClassVar

from textual import on
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, TextArea

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


class ResumeSourceModal(ModalScreen[dict[str, str] | None]):
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
                    "RoleLoop resolves a committed Git revision only when you explicitly sync. "
                    "Existing evidence and generated artifacts remain immutable.",
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
                yield Label("Résumé path inside repository", classes="field-label")
                yield Input(
                    value=str(field(self.source, "document_path", default="") or ""),
                    placeholder="resume/master.md",
                    id="resume-source-document-path",
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
        document_path = self.query_one("#resume-source-document-path", Input).value.strip()
        if not repository:
            self.query_one("#resume-source-error", Static).update("Enter a repository.")
            return
        if not document_path:
            self.query_one("#resume-source-error", Static).update(
                "Enter the résumé path inside the repository."
            )
            return
        self.dismiss(
            {
                "kind": str(self.query_one("#resume-source-kind", Select).value),
                "repository": repository,
                "ref": self.query_one("#resume-source-ref", Input).value.strip(),
                "document_path": document_path,
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
        with Vertical(id="profile-dialog"):
            with VerticalScroll(id="profile-fields"):
                yield Label(title, classes="dialog-title")
                if self.onboarding:
                    yield Static(
                        "Create one active profile. Providers and résumé evidence "
                        "can be configured later.",
                        classes="dialog-copy",
                        markup=False,
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
        if not name:
            self.query_one("#profile-error", Static).update("Enter a profile name.")
            return
        if not roles:
            self.query_one("#profile-error", Static).update("Enter at least one target role.")
            return
        result: dict[str, Any] = {
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
        }
        self.dismiss(result)

    @on(Button.Pressed, "#profile-cancel")
    def cancel_button(self) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        if not self.onboarding:
            self.dismiss(None)
