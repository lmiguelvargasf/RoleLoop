from __future__ import annotations

import asyncio
import errno
import hashlib
import io
import json
import os
import tarfile
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

import roleloop.infrastructure.contract as contract_module
from roleloop.application.dto import MasterResumeRenderRequest, PdfInspection, ResumeSelection
from roleloop.application.errors import ProviderFailureError, ProviderUnavailableError
from roleloop.application.ports import NullProgressReporter
from roleloop.domain import (
    AgentProvider,
    ArtifactRef,
    EvidenceSourceKind,
    JobVersion,
    ResumeEvidenceVersion,
    ResumeExperienceSelection,
    ResumeSource,
    ResumeSourceKind,
    SearchProfileVersion,
)
from roleloop.infrastructure.contract import (
    ContractMasterResumeRenderer,
    ContractResumeSourceSynchronizer,
    ResumeContractError,
    TrustedResumeContractRunner,
)
from roleloop.infrastructure.resume_sources import GitRepositoryArchive

REVISION = "a" * 40
SOURCE_HASH = "b" * 64

_FAKE_CONTRACT = r"""from __future__ import annotations
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

REVISION_HASH = "a" * 40
SOURCE_HASH = "b" * 64

def canonical(value):
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return (text + "\n").encode()

def evidence(revision):
    return {
        "active_experience_order": ["example"],
        "active_experiences": [{
            "bullets": [{
                "experience_id": "example",
                "id": "example.claim.1234567890abcdef",
                "project_id": None,
                "source_path": "sections/example.tex",
                "source_sha256": SOURCE_HASH,
                "text": "Built a deterministic system",
            }],
            "id": "example",
            "source_path": "sections/example.tex",
            "source_sha256": SOURCE_HASH,
        }],
        "allowed_skills": [{
            "group_id": "languages",
            "group_name": "Languages",
            "id": "skill.python",
            "text": "Python",
        }],
        "contract_version": 1,
        "renderer_version": "1.0.0",
        "resume_id": "fixture",
        "schema": "roleloop.evidence-catalog.v1",
        "source_revision": revision,
        "summary": {
            "id": "summary.current",
            "source_path": "sections/summary.tex",
            "source_sha256": SOURCE_HASH,
            "text": "Applied AI engineer",
        },
        "tracked_manifest": {"main.tex": SOURCE_HASH},
    }

parser = argparse.ArgumentParser()
sub = parser.add_subparsers(dest="command", required=True)
for name in ("describe", "export", "render"):
    command = sub.add_parser(name)
    command.add_argument("--protocol", type=int, required=True)
    if name == "export":
        command.add_argument("--source-revision", required=True)
    if name == "render":
        command.add_argument("--output-dir", type=Path, required=True)
args = parser.parse_args()

unsafe_environment = any(
    os.environ.get(name)
    for name in ("OPENAI_API_KEY", "GITHUB_TOKEN", "PYTHONPATH")
)
if unsafe_environment:
    sys.stderr.buffer.write(canonical({
        "code": "unsafe_environment",
        "contract_version": 1,
        "message": "secret environment leaked",
        "retryable": False,
        "schema": "roleloop.bridge-error.v1",
        "status": "error",
    }))
    raise SystemExit(65)
if args.protocol != 1:
    raise SystemExit(69)
if args.command == "describe":
    result = {
        "bridge_version": "1.0.0",
        "commands": ["describe", "export", "render"],
        "contract_name": "roleloop.master-resume",
        "contract_version": 1,
        "renderer_version": "1.0.0",
        "schema": "roleloop.bridge-description.v1",
        "schemas": {"evidence_catalog": 1, "render_result": 1, "tailoring_selection": 1},
        "supported_paper_sizes": ["a4paper", "letterpaper"],
    }
elif args.command == "export":
    result = evidence(args.source_revision)
else:
    selection_bytes = sys.stdin.buffer.read()
    selection = json.loads(selection_bytes)
    output = args.output_dir
    output.mkdir()
    catalog_bytes = canonical(evidence(selection["source_revision"]))
    files = {
        "REVIEW.md": b"Review exact evidence\n",
        "ats.txt": b"SUMMARY SKILLS PROFESSIONAL EXPERIENCE\n",
        "compile.log": b"clean compile\n",
        "evidence-catalog.json": catalog_bytes,
        "render-source.tar": b"source tar fixture",
        "resume.fls": b"INPUT main.tex\n",
        "resume.pdf": b"%PDF-1.7 fixture",
        "tailoring-selection.json": selection_bytes,
    }
    media = {
        "REVIEW.md": "text/markdown; charset=utf-8",
        "ats.txt": "text/plain; charset=utf-8",
        "compile.log": "text/plain; charset=utf-8",
        "evidence-catalog.json": "application/json",
        "render-source.tar": "application/x-tar",
        "resume.fls": "text/plain; charset=utf-8",
        "resume.pdf": "application/pdf",
        "tailoring-selection.json": "application/json",
    }
    manifests = []
    for name, data in files.items():
        (output / name).write_bytes(data)
        manifests.append({
            "file_name": name,
            "media_type": media[name],
            "sha256": hashlib.sha256(data).hexdigest(),
            "size_bytes": len(data),
        })
    result = {
        "checks": {
            "ats_text_nonempty": True,
            "compile_log_sanitized": True,
            "page_count": 1,
            "valid_pdf_header": True,
        },
        "contract_version": 1,
        "evidence_catalog_sha256": hashlib.sha256(catalog_bytes).hexdigest(),
        "files": manifests,
        "renderer_version": "1.0.0",
        "resume_id": "fixture",
        "schema": "roleloop.render-result.v1",
        "selection_sha256": hashlib.sha256(selection_bytes).hexdigest(),
        "source_revision": selection["source_revision"],
        "status": "ok",
        "toolchain": {
            "latexmk_version": "fixture",
            "pdfinfo_version": "fixture",
            "pdftotext_version": "fixture",
            "pdftex_version": "fixture",
            "python_version": sys.version.split()[0],
        },
        "warnings": [],
    }
    (output / "render-result.json").write_bytes(canonical(result))
sys.stdout.buffer.write(canonical(result))
"""


def _archive(script: str = _FAKE_CONTRACT) -> bytes:
    payload = io.BytesIO()
    encoded = script.encode("utf-8")
    with tarfile.open(fileobj=payload, mode="w") as archive:
        info = tarfile.TarInfo("roleloop_contract/v1/cli.py")
        info.size = len(encoded)
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(encoded))
    return payload.getvalue()


def _hanging_archive(pid_path: Path) -> bytes:
    script = f"""import argparse
import subprocess
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--protocol")
parser.parse_args()
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
Path({str(pid_path)!r}).write_text(str(child.pid), encoding="utf-8")
time.sleep(60)
"""
    return _archive(script)


def _oversized_stdout_archive(pid_path: Path) -> bytes:
    script = f"""import argparse
import os
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--protocol")
parser.parse_args()
Path({str(pid_path)!r}).write_text(str(os.getpid()), encoding="utf-8")
sys.stdout.buffer.write(b"x" * (4 * 1024 * 1024 + 1))
sys.stdout.buffer.flush()
time.sleep(60)
"""
    return _archive(script)


def _oversized_render_archive(pid_path: Path) -> bytes:
    replacement = f"""output.mkdir()
    Path({str(pid_path)!r}).write_text(str(os.getpid()), encoding="utf-8")
    with (output / "oversized.bin").open("wb") as oversized:
        oversized.truncate(100 * 1024 * 1024 + 1)
    __import__("time").sleep(60)
    catalog_bytes"""
    return _archive(_FAKE_CONTRACT.replace("output.mkdir()\n    catalog_bytes", replacement))


def _orphaning_archive(pid_path: Path) -> bytes:
    injected = f"""import subprocess

child = subprocess.Popen([
    sys.executable,
    "-c",
    "import time; time.sleep(60)",
])
Path({str(pid_path)!r}).write_text(str(child.pid), encoding="utf-8")
"""
    return _archive(
        _FAKE_CONTRACT.replace(
            "unsafe_environment =",
            injected + "\nunsafe_environment =",
        )
    )


def _process_exists(process_id: int) -> bool:
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    return True


def _assert_process_exits(process_id: int) -> None:
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if not _process_exists(process_id):
            return
        time.sleep(0.02)
    pytest.fail(f"contract descendant {process_id} survived process-group cleanup")


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group behavior")
@pytest.mark.parametrize("probe_errno", [errno.EPERM, errno.ESRCH])
def test_contract_process_group_probe_treats_terminal_errors_as_cleanup_complete(
    monkeypatch: pytest.MonkeyPatch,
    probe_errno: int,
) -> None:
    signals: list[int] = []

    class ExitedProcess:
        pid = 123456

        def poll(self) -> int:
            return 0

        def wait(self, *, timeout: float) -> int:
            del timeout
            return 0

        def terminate(self) -> None:
            pytest.fail("cleanup must not terminate an already-exited parent")

        def kill(self) -> None:
            pytest.fail("a terminal process-group probe must not escalate")

    def fake_killpg(process_group: int, requested_signal: int) -> None:
        assert process_group == ExitedProcess.pid
        signals.append(requested_signal)
        if requested_signal == 0:
            raise OSError(probe_errno, "process-group probe is terminal")

    monkeypatch.setattr(contract_module.os, "killpg", fake_killpg)

    contract_module._terminate_process_group(ExitedProcess())  # type: ignore[arg-type]

    assert signals == [contract_module.signal.SIGTERM, 0]


def _artifact(identifier: str, data: bytes, media_type: str) -> ArtifactRef:
    return ArtifactRef(
        id=identifier,
        checksum=hashlib.sha256(data).hexdigest(),
        uri=identifier,
        media_type=media_type,
        size_bytes=len(data),
    )


@pytest.mark.asyncio
async def test_contract_runner_describes_and_exports_with_sanitized_environment() -> None:
    runner = TrustedResumeContractRunner(
        inherited_environment={
            "PATH": "/usr/bin:/bin",
            "OPENAI_API_KEY": "must-not-leak",
            "GITHUB_TOKEN": "must-not-leak",
            "PYTHONPATH": "/untrusted",
        }
    )

    exported = await runner.inspect_and_export(_archive(), source_revision=REVISION)

    assert exported.source_revision == REVISION
    assert exported.description.renderer_version == "1.0.0"
    assert exported.description.evidence_schema_version == 1
    assert exported.evidence_checksum == hashlib.sha256(exported.evidence).hexdigest()
    assert json.loads(exported.evidence)["schema"] == "roleloop.evidence-catalog.v1"


@pytest.mark.asyncio
async def test_contract_runner_rejects_wrong_cli_checksum_and_unsafe_archive() -> None:
    runner = TrustedResumeContractRunner()
    with pytest.raises(ResumeContractError, match="checksum"):
        await runner.inspect_and_export(
            _archive(),
            source_revision=REVISION,
            expected_cli_checksum="0" * 64,
        )

    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w") as archive:
        data = b"escape"
        info = tarfile.TarInfo("../escape")
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    with pytest.raises(ProviderFailureError, match="unsafe"):
        await runner.inspect_and_export(payload.getvalue(), source_revision=REVISION)


@pytest.mark.asyncio
async def test_contract_timeout_terminates_descendant_process_group(tmp_path: Path) -> None:
    pid_path = tmp_path / "descendant.pid"
    runner = TrustedResumeContractRunner(command_timeout_seconds=0.2)

    with pytest.raises(ResumeContractError, match="timed out"):
        await runner.inspect_and_export(
            _hanging_archive(pid_path),
            source_revision=REVISION,
        )

    process_id = int(pid_path.read_text(encoding="utf-8"))
    _assert_process_exits(process_id)


@pytest.mark.asyncio
async def test_contract_cancellation_terminates_descendant_process_group(
    tmp_path: Path,
) -> None:
    pid_path = tmp_path / "cancelled-descendant.pid"
    runner = TrustedResumeContractRunner(command_timeout_seconds=30)
    task = asyncio.create_task(
        runner.inspect_and_export(
            _hanging_archive(pid_path),
            source_revision=REVISION,
        )
    )
    for _ in range(100):
        if pid_path.exists():
            break
        await asyncio.sleep(0.02)
    assert pid_path.exists()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    process_id = int(pid_path.read_text(encoding="utf-8"))
    _assert_process_exits(process_id)


@pytest.mark.asyncio
async def test_contract_kills_process_as_soon_as_stdout_exceeds_cap(tmp_path: Path) -> None:
    pid_path = tmp_path / "oversized.pid"
    runner = TrustedResumeContractRunner(command_timeout_seconds=30)

    started = time.monotonic()
    with pytest.raises(ResumeContractError, match="execution limit") as failure:
        await runner.inspect_and_export(
            _oversized_stdout_archive(pid_path),
            source_revision=REVISION,
        )

    assert time.monotonic() - started < 5
    assert failure.value.details["limit"] == "stdout_bytes"
    _assert_process_exits(int(pid_path.read_text(encoding="utf-8")))


@pytest.mark.asyncio
async def test_contract_kills_render_as_soon_as_output_exceeds_cap(tmp_path: Path) -> None:
    pid_path = tmp_path / "oversized-render.pid"
    archive = _oversized_render_archive(pid_path)
    runner = TrustedResumeContractRunner(command_timeout_seconds=30)
    exported = await runner.inspect_and_export(archive, source_revision=REVISION)
    selection = {
        "schema": "roleloop.tailoring-selection.v1",
        "contract_version": 1,
        "source_revision": REVISION,
        "evidence_catalog_sha256": exported.evidence_checksum,
        "job_version_id": "job-version",
        "headline": "Applied AI Engineer",
        "summary_id": "summary.current",
        "skill_ids": ["skill.python"],
        "experiences": [
            {
                "experience_id": "example",
                "bullet_ids": ["example.claim.1234567890abcdef"],
            }
        ],
        "paper_size": "a4paper",
        "maximum_pages": 2,
    }

    with pytest.raises(ResumeContractError, match="execution limit") as failure:
        await runner.render(
            archive,
            source_revision=REVISION,
            selection=selection,
            evidence_checksum=exported.evidence_checksum,
            expected_cli_checksum=exported.description.cli_checksum,
        )

    assert failure.value.details["limit"] == "output_bytes"
    _assert_process_exits(int(pid_path.read_text(encoding="utf-8")))


@pytest.mark.asyncio
async def test_contract_kills_descendants_even_after_successful_parent_exit(
    tmp_path: Path,
) -> None:
    pid_path = tmp_path / "orphaned-descendant.pid"

    exported = await TrustedResumeContractRunner().inspect_and_export(
        _orphaning_archive(pid_path),
        source_revision=REVISION,
    )

    assert exported.source_revision == REVISION
    _assert_process_exits(int(pid_path.read_text(encoding="utf-8")))


@pytest.mark.asyncio
async def test_contract_runner_validates_render_manifest_and_receipt() -> None:
    archive = _archive()
    runner = TrustedResumeContractRunner()
    exported = await runner.inspect_and_export(archive, source_revision=REVISION)
    selection = {
        "schema": "roleloop.tailoring-selection.v1",
        "contract_version": 1,
        "source_revision": REVISION,
        "evidence_catalog_sha256": exported.evidence_checksum,
        "job_version_id": "job-version",
        "headline": "Applied AI Engineer",
        "summary_id": "summary.current",
        "skill_ids": ["skill.python"],
        "experiences": [
            {
                "experience_id": "example",
                "bullet_ids": ["example.claim.1234567890abcdef"],
            }
        ],
        "paper_size": "a4paper",
        "maximum_pages": 2,
    }

    rendered = await runner.render(
        archive,
        source_revision=REVISION,
        selection=selection,
        evidence_checksum=exported.evidence_checksum,
        expected_cli_checksum=exported.description.cli_checksum,
    )

    assert rendered.page_count == 1
    assert rendered.output("resume.pdf").data.startswith(b"%PDF-")
    assert rendered.output("evidence-catalog.json").data == exported.evidence
    assert json.loads(rendered.receipt)["status"] == "ok"


class _FakeGit:
    def __init__(self, archive: bytes) -> None:
        self.archive = archive

    async def snapshot_archive(
        self,
        source: ResumeSource,
        *,
        progress: NullProgressReporter,
    ) -> GitRepositoryArchive:
        del source, progress
        return GitRepositoryArchive(
            source_revision=REVISION,
            data=self.archive,
            checksum=hashlib.sha256(self.archive).hexdigest(),
        )


@pytest.mark.asyncio
async def test_contract_source_sync_requires_persisted_trust(tmp_path: Path) -> None:
    syncer = ContractResumeSourceSynchronizer(
        _FakeGit(_archive()),  # type: ignore[arg-type]
        TrustedResumeContractRunner(),
    )
    source = ResumeSource(
        id="source",
        profile_id="profile",
        kind=ResumeSourceKind.LOCAL_GIT,
        repository=str(tmp_path),
        ref="HEAD",
    )
    with pytest.raises(ProviderUnavailableError, match="trust"):
        await syncer.sync(source, progress=NullProgressReporter())

    trusted = ResumeSource(
        id=source.id,
        profile_id=source.profile_id,
        kind=source.kind,
        repository=source.repository,
        ref=source.ref,
        trust_acknowledged_at=datetime.now(UTC),
    )
    snapshot = await syncer.sync(trusted, progress=NullProgressReporter())
    assert snapshot.source_revision == REVISION
    assert snapshot.contract_checksum == hashlib.sha256(_FAKE_CONTRACT.encode("utf-8")).hexdigest()
    assert snapshot.canonical_evidence_bytes == snapshot.source_bytes
    assert snapshot.source_bundle_bytes == _archive()


class _ArtifactReader:
    def __init__(self, values: dict[str, bytes]) -> None:
        self.values = values

    async def read_bytes(self, artifact: ArtifactRef) -> bytes:
        return self.values[artifact.id]


class _PdfInspector:
    def __init__(self, extracted_text: str = "SUMMARY SKILLS PROFESSIONAL EXPERIENCE") -> None:
        self.extracted_text = extracted_text

    def inspect(self, data: bytes) -> PdfInspection:
        return PdfInspection(
            valid=data.startswith(b"%PDF-"),
            page_count=1,
            media_type="application/pdf",
            extracted_text=self.extracted_text,
        )


@pytest.mark.asyncio
async def test_contract_renderer_maps_exact_selection_and_artifacts() -> None:
    archive = _archive()
    runner = TrustedResumeContractRunner()
    exported = await runner.inspect_and_export(archive, source_revision=REVISION)
    archive_ref = _artifact("archive", archive, "application/x-tar")
    evidence_ref = _artifact("evidence", exported.evidence, "application/json")
    evidence = ResumeEvidenceVersion(
        id="evidence-version",
        profile_id="profile",
        source_kind=EvidenceSourceKind.TEXT_FILE,
        source_name="evidence-catalog.json",
        source_artifact=evidence_ref,
        extracted_text=exported.evidence.decode("utf-8"),
        created_at=datetime.now(UTC),
        source_revision=REVISION,
        canonical_evidence_artifact=evidence_ref,
        source_bundle_artifact=archive_ref,
        contract_checksum=exported.description.cli_checksum,
    )
    request = MasterResumeRenderRequest(
        evidence=evidence,
        selection=ResumeSelection(
            headline="Applied AI Engineer",
            experiences=(
                ResumeExperienceSelection(
                    experience_id="example",
                    bullet_ids=("example.claim.1234567890abcdef",),
                ),
            ),
            skill_ids=("skill.python",),
        ),
        job_version=JobVersion(
            id="job-version",
            job_id="job",
            version_number=1,
            content_fingerprint="fingerprint",
            canonical_url="https://example.com/job",
            title="Applied AI Engineer",
            company="Example",
            location="Remote",
            description="Build systems",
            source="fixture",
        ),
        profile_version=SearchProfileVersion(
            id="profile-version",
            profile_id="profile",
            version_number=1,
            name="Fixture",
            agent_provider=AgentProvider.DEMO,
            paper_size="a4paper",
            page_limit=2,
        ),
    )
    renderer = ContractMasterResumeRenderer(
        runner,
        _ArtifactReader({"archive": archive, "evidence": exported.evidence}),
        _PdfInspector(),
    )

    result = await renderer.render(request, progress=NullProgressReporter())

    assert result.pdf.startswith(b"%PDF-")
    assert result.page_count == 1
    assert result.renderer_source_revision == REVISION
    assert result.tailored_source_bundle == b"source tar fixture"
    selection_file = json.loads(result.selection_file)
    assert selection_file["summary_id"] == json.loads(exported.evidence)["summary"]["id"]
    assert selection_file["experiences"] == [
        {
            "experience_id": "example",
            "bullet_ids": ["example.claim.1234567890abcdef"],
        }
    ]
    assert result.ats_text.startswith("SUMMARY")


@pytest.mark.asyncio
async def test_contract_renderer_rejects_ats_text_unrelated_to_pdf() -> None:
    archive = _archive(
        _FAKE_CONTRACT.replace(
            '"ats.txt": b"SUMMARY SKILLS PROFESSIONAL EXPERIENCE\\n",',
            '"ats.txt": b"UNRELATED CONTRACT TEXT\\n",',
        )
    )
    runner = TrustedResumeContractRunner()
    exported = await runner.inspect_and_export(archive, source_revision=REVISION)
    archive_ref = _artifact("archive", archive, "application/x-tar")
    evidence_ref = _artifact("evidence", exported.evidence, "application/json")
    request = MasterResumeRenderRequest(
        evidence=ResumeEvidenceVersion(
            id="evidence-version",
            profile_id="profile",
            source_kind=EvidenceSourceKind.TEXT_FILE,
            source_name="evidence-catalog.json",
            source_artifact=evidence_ref,
            extracted_text=exported.evidence.decode("utf-8"),
            created_at=datetime.now(UTC),
            source_revision=REVISION,
            canonical_evidence_artifact=evidence_ref,
            source_bundle_artifact=archive_ref,
            contract_checksum=exported.description.cli_checksum,
        ),
        selection=ResumeSelection(
            headline="Applied AI Engineer",
            experiences=(
                ResumeExperienceSelection(
                    experience_id="example",
                    bullet_ids=("example.claim.1234567890abcdef",),
                ),
            ),
            skill_ids=("skill.python",),
        ),
        job_version=JobVersion(
            id="job-version",
            job_id="job",
            version_number=1,
            content_fingerprint="fingerprint",
            canonical_url="https://example.com/job",
            title="Applied AI Engineer",
            company="Example",
            location="Remote",
            description="Build systems",
            source="fixture",
        ),
        profile_version=SearchProfileVersion(
            id="profile-version",
            profile_id="profile",
            version_number=1,
            name="Fixture",
            agent_provider=AgentProvider.DEMO,
            paper_size="a4paper",
            page_limit=2,
        ),
    )
    renderer = ContractMasterResumeRenderer(
        runner,
        _ArtifactReader({"archive": archive, "evidence": exported.evidence}),
        _PdfInspector(),
    )

    with pytest.raises(ResumeContractError, match="does not match"):
        await renderer.render(request, progress=NullProgressReporter())
