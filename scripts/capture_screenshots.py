"""Capture deterministic Textual screens for the project README.

Run from the repository root with::

    uv run python scripts/capture_screenshots.py

The script uses the same provider-free facade as the headless Pilot tests, so the
documentation never depends on network access, API credentials, or personal data.
"""

# ruff: noqa: E402, I001 -- the repository root must precede test-facade imports.

from __future__ import annotations

import asyncio
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from textual.widgets import DataTable, TabbedContent

import resvg_py

from roleloop.adapters.tui.app import RoleLoopApp
from roleloop.adapters.tui.review import JobReviewScreen
from roleloop.adapters.tui.workspace import WorkspaceScreen
from roleloop.application.dto import JobInboxItem
from roleloop.domain import (
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    Outcome,
    ResumeStatus,
    ReviewStatus,
)
from tests.tui.fakes import FakeFacade, ProfileManagementFacade


SCREENSHOT_DIR = ROOT / "docs" / "screenshots"
SCREEN_SIZE = (140, 42)


class ScreenshotFacade(FakeFacade):
    """Populate the inbox with representative workflow states."""

    def list_jobs(self, filters: dict[str, Any]) -> list[JobInboxItem]:
        self.calls.append(("list_jobs", dict(filters)))
        base = self._inbox_item()
        return [
            replace(
                base,
                title="Senior Backend Engineer",
                company="Example Labs",
                decision=Decision.TAILOR,
                resume_status=ResumeStatus.READY,
            ),
            replace(
                base,
                case_id="case-2",
                job_id="job-2",
                canonical_url="https://jobs.example.test/platform",
                title="Staff Platform Engineer",
                company="Northstar Systems",
                location="New York / Remote",
                eligibility_status=EligibilityStatus.UNRESOLVED,
                decision=Decision.WATCH,
                resume_status=ResumeStatus.NONE,
            ),
            replace(
                base,
                case_id="case-3",
                job_id="job-3",
                canonical_url="https://jobs.example.test/distributed",
                title="Distributed Systems Engineer",
                company="Meridian Cloud",
                location="Remote — Americas",
                review_status=ReviewStatus.STALE,
                decision=Decision.UNDECIDED,
                resume_status=ResumeStatus.STALE,
            ),
            replace(
                base,
                case_id="case-4",
                job_id="job-4",
                canonical_url="https://jobs.example.test/infrastructure",
                title="Python Infrastructure Lead",
                company="Atlas Compute",
                location="Remote",
                decision=Decision.WATCH,
                resume_status=ResumeStatus.READY,
                application_status=ApplicationStatus.SUBMITTED,
                outcome=Outcome.INTERVIEWING,
                submitted_at=base.updated_at,
                submitted_artifact_id="artifact-resume",
            ),
        ]


async def settle(app: RoleLoopApp, pilot: Any) -> None:
    """Drain Textual messages and all registered workers."""

    await pilot.pause()
    await app.workers.wait_for_complete()
    await pilot.pause()
    await app.workers.wait_for_complete()
    await pilot.pause()


def save(app: RoleLoopApp, filename: str) -> None:
    path = app.save_screenshot(filename=filename, path=str(SCREENSHOT_DIR))
    screenshot = Path(path)
    document = screenshot.read_text(encoding="utf-8")
    screenshot.write_text(
        "\n".join(line.rstrip() for line in document.splitlines()) + "\n",
        encoding="utf-8",
    )
    png_path = screenshot.with_suffix(".png")
    png_path.write_bytes(resvg_py.svg_to_bytes(svg_string=document))
    print(f"{screenshot}\n{png_path}")


async def capture_inbox() -> None:
    app = RoleLoopApp(ScreenshotFacade(decision=Decision.TAILOR))
    async with app.run_test(size=SCREEN_SIZE) as pilot:
        await settle(app, pilot)
        save(app, "roleloop-inbox.svg")


async def capture_review() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    await facade.generate_resume("job-1")
    app = RoleLoopApp(facade)
    async with app.run_test(size=SCREEN_SIZE) as pilot:
        await settle(app, pilot)
        table = app.screen.query_one("#job-table", DataTable)
        table.focus()
        await pilot.press("enter")
        await settle(app, pilot)
        if not isinstance(app.screen, JobReviewScreen):
            raise RuntimeError("Job review did not open")
        tabs = app.screen.query_one("#review-tabs", TabbedContent)
        tabs.active = "evidence-tab"
        await pilot.pause(0.5)
        save(app, "roleloop-review-evidence.svg")
        tabs.active = "resume-tab"
        await pilot.pause(0.5)
        save(app, "roleloop-review-resume.svg")


async def capture_applications() -> None:
    facade = FakeFacade(decision=Decision.TAILOR)
    await facade.generate_resume("job-1")
    facade.mark_applied("job-1")
    facade.record_outcome("job-1", Outcome.INTERVIEWING.value)
    app = RoleLoopApp(facade)
    async with app.run_test(size=SCREEN_SIZE) as pilot:
        await settle(app, pilot)
        if not isinstance(app.screen, WorkspaceScreen):
            raise RuntimeError("Workspace did not open")
        app.screen.action_show_view("applications")
        await settle(app, pilot)
        save(app, "roleloop-applications.svg")


async def capture_settings() -> None:
    app = RoleLoopApp(ProfileManagementFacade())
    async with app.run_test(size=SCREEN_SIZE) as pilot:
        await settle(app, pilot)
        if not isinstance(app.screen, WorkspaceScreen):
            raise RuntimeError("Workspace did not open")
        app.screen.action_show_view("settings")
        await settle(app, pilot)
        save(app, "roleloop-settings.svg")


async def main() -> None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    await capture_inbox()
    await capture_review()
    await capture_applications()
    await capture_settings()


if __name__ == "__main__":
    asyncio.run(main())
