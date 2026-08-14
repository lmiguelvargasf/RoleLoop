from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from roleloop.application import (
    CompiledDocument,
    EvidenceImport,
    ProfileDraft,
    ResumeDraft,
    ReviewAnalysis,
)
from roleloop.bootstrap import build_service
from roleloop.domain import (
    AgentProvider,
    Decision,
    EvidenceSourceKind,
    Finding,
    ResumeStage,
)
from roleloop.infrastructure import RoleLoopPaths

ROOT = Path(__file__).resolve().parents[2]
CLI = (
    sys.executable,
    "-c",
    "import sys; from roleloop.adapters.cli import main; raise SystemExit(main(sys.argv[1:]))",
)


class _Analyzer:
    version = "process-lock-analyzer-v1"

    async def analyze(self, context: Any, *, progress: Any) -> ReviewAnalysis:
        del context, progress
        return ReviewAnalysis(
            match_evidence=(Finding("Exact test evidence", source_anchor="resume:test"),),
            skeptic_findings=(),
            questions=(),
        )


class _SlowGenerator:
    version = "process-lock-generator-v1"

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def generate(self, context: Any, *, progress: Any) -> ResumeDraft:
        del context, progress
        self.started.set()
        await self.release.wait()
        return ResumeDraft(content={"summary": "Exact evidence only"})


class _Validator:
    version = "process-lock-validator-v1"

    async def validate(self, context: Any, draft: Any, *, progress: Any) -> tuple[()]:
        del context, draft, progress
        return ()


class _Compiler:
    version = "process-lock-compiler-v1"

    async def compile(self, context: Any, draft: Any, *, progress: Any) -> CompiledDocument:
        del context, draft, progress
        return CompiledDocument(b"%PDF-1.4\n%%EOF\n")


def _paths(root: Path) -> RoleLoopPaths:
    data_dir = root / "roleloop-data"
    return RoleLoopPaths(
        data_dir=data_dir,
        database_path=data_dir / "roleloop.sqlite3",
        artifacts_dir=data_dir / "artifacts",
    )


def _run_cli(data_dir: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["ROLELOOP_DATA_DIR"] = str(data_dir)
    environment.pop("OPENAI_API_KEY", None)
    return subprocess.run(
        [*CLI, *arguments],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )


async def test_second_cli_cannot_recover_a_live_generation_and_first_finishes_ready(
    tmp_path: Path,
) -> None:
    paths = _paths(tmp_path)
    service = build_service(paths)
    generator = _SlowGenerator()
    # Exercise the compact legacy provider pipeline so the concurrency test is
    # independent of native TeX while still persisting every résumé stage in
    # the same production SQLite repositories used by the authoritative path.
    service._agent_registry = None
    service._analyzer = _Analyzer()
    service._generator = generator
    service._validator = _Validator()
    service._compiler = _Compiler()
    task: asyncio.Task[Any] | None = None
    try:
        profile = service.create_profile(
            ProfileDraft(
                "Process lock acceptance",
                target_roles=("Evidence Engineer",),
                agent_provider=AgentProvider.DEMO,
            )
        )
        await service.import_evidence(
            profile.id,
            EvidenceImport(
                source_kind=EvidenceSourceKind.PASTED_TEXT,
                text="Built reliable evidence systems.",
            ),
        )
        case = service.add_job_url(profile.id, "https://jobs.example.test/process-lock")
        await service.review_job(profile.id, case.job_id)
        service.decide_job(profile.id, case.job_id, Decision.TAILOR)

        task = asyncio.create_task(service.generate_resume(profile.id, case.job_id))
        await asyncio.wait_for(generator.started.wait(), timeout=3)
        live = service.get_resume(profile.id, case.job_id).latest_run
        assert live is not None
        assert live.stage is ResumeStage.DRAFTING

        blocked = await asyncio.to_thread(_run_cli, paths.data_dir, "inbox", "--json")
        assert blocked.returncode == 4, blocked.stderr
        payload = json.loads(blocked.stdout)
        assert payload["error"]["code"] == "concurrent_instance"
        assert payload["error"]["details"]["owner_pid"] == os.getpid()

        blocked_tui = await asyncio.to_thread(_run_cli, paths.data_dir)
        assert blocked_tui.returncode == 4
        assert blocked_tui.stdout == ""
        assert "Another RoleLoop process" in blocked_tui.stderr
        assert "Traceback" not in blocked_tui.stderr
        assert str(paths.process_lock_path) not in blocked_tui.stderr

        untouched = service.get_resume(profile.id, case.job_id).latest_run
        assert untouched is not None
        assert untouched.id == live.id
        assert untouched.stage is ResumeStage.DRAFTING

        generator.release.set()
        ready = await asyncio.wait_for(task, timeout=3)
        assert ready.stage is ResumeStage.READY
        assert service.get_resume(profile.id, case.job_id).latest_run == ready
    finally:
        generator.release.set()
        if task is not None and not task.done():
            await task
        service.close()

    after_release = await asyncio.to_thread(_run_cli, paths.data_dir, "inbox", "--json")
    assert after_release.returncode == 0, after_release.stderr
