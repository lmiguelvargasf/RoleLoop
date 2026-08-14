"""Execution boundary for the trusted, commit-pinned master-résumé contract."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError

from roleloop.application.dto import (
    MasterResumeRenderRequest,
    MasterResumeRenderResult,
    ProgressUpdate,
    ResumeSourceSnapshot,
)
from roleloop.application.errors import (
    ProviderFailureError,
    ProviderUnavailableError,
    ValidationError,
)
from roleloop.application.ports import ArtifactReader, PdfInspector, ProgressReporter
from roleloop.domain import ResumeSource, ResumeSourceKind
from roleloop.domain.git import (
    InvalidGitRef,
    InvalidGitRemote,
    validate_git_ref,
    validate_remote_git_repository,
)

from .resume_sources import GitResumeSourceSynchronizer
from .runtime import sanitized_subprocess_environment

CONTRACT_PROTOCOL_VERSION = "1"
CONTRACT_CLI_PATH = PurePosixPath("roleloop_contract/v1/cli.py")
_REVISION = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_CHECKSUM = re.compile(r"^[0-9a-f]{64}$")
_SAFE_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
_MAX_ARCHIVE_MEMBERS = 4_096
_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
_MAX_REQUEST_BYTES = 2 * 1024 * 1024
_MAX_STDOUT_BYTES = 4 * 1024 * 1024
_MAX_STDERR_BYTES = 512 * 1024
_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
_MAX_OUTPUT_FILES = 32
_MAX_WORK_BYTES = _MAX_OUTPUT_BYTES + _MAX_STDOUT_BYTES + _MAX_STDERR_BYTES + _MAX_REQUEST_BYTES
_RENDER_MEDIA_TYPES = {
    "REVIEW.md": "text/markdown; charset=utf-8",
    "ats.txt": "text/plain; charset=utf-8",
    "compile.log": "text/plain; charset=utf-8",
    "evidence-catalog.json": "application/json",
    "render-source.tar": "application/x-tar",
    "resume.fls": "text/plain; charset=utf-8",
    "resume.pdf": "application/pdf",
    "tailoring-selection.json": "application/json",
}
_RENDER_RESULT_NAME = "render-result.json"
_THREAD_RESULT = TypeVar("_THREAD_RESULT")


class ResumeContractError(ProviderFailureError):
    code = "resume_contract_error"


class ResumeContractUnavailableError(ProviderUnavailableError):
    code = "resume_contract_unavailable"


class _ContractExecutionCancelled(Exception):
    pass


async def _cancellable_thread(
    operation: Callable[[threading.Event], _THREAD_RESULT],
) -> _THREAD_RESULT:
    cancellation = threading.Event()
    worker = asyncio.create_task(asyncio.to_thread(operation, cancellation))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancellation.set()
        with suppress(Exception, asyncio.CancelledError):
            await asyncio.shield(worker)
        raise


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _BridgeDescription(_StrictModel):
    schema_name: Literal["roleloop.bridge-description.v1"] = Field(alias="schema")
    bridge_version: str
    commands: list[str]
    contract_name: Literal["roleloop.master-resume"]
    contract_version: Literal[1]
    renderer_version: str
    schemas: dict[str, int]
    supported_paper_sizes: list[str]


class _SummaryEvidence(_StrictModel):
    id: str
    text: str
    source_path: str
    source_sha256: str


class _BulletEvidence(_StrictModel):
    id: str
    experience_id: str
    project_id: str | None
    text: str
    source_path: str
    source_sha256: str


class _ExperienceEvidence(_StrictModel):
    id: str
    source_path: str
    source_sha256: str
    bullets: list[_BulletEvidence]


class _SkillEvidence(_StrictModel):
    id: str
    text: str
    group_id: str
    group_name: str


class _EvidenceCatalog(_StrictModel):
    schema_name: Literal["roleloop.evidence-catalog.v1"] = Field(alias="schema")
    contract_version: Literal[1]
    source_revision: str
    resume_id: str
    summary: _SummaryEvidence
    active_experiences: list[_ExperienceEvidence]
    allowed_skills: list[_SkillEvidence]
    active_experience_order: list[str]
    renderer_version: str
    tracked_manifest: dict[str, str]


class _RenderFile(_StrictModel):
    file_name: str
    media_type: str
    sha256: str
    size_bytes: int = Field(ge=0)


class _RenderToolchain(_StrictModel):
    python_version: str
    latexmk_version: str
    pdftex_version: str
    pdfinfo_version: str
    pdftotext_version: str


class _RenderChecks(_StrictModel):
    valid_pdf_header: bool
    page_count: int = Field(ge=0)
    ats_text_nonempty: bool
    compile_log_sanitized: bool


class _RenderResult(_StrictModel):
    schema_name: Literal["roleloop.render-result.v1"] = Field(alias="schema")
    contract_version: Literal[1]
    status: Literal["ok"]
    source_revision: str
    renderer_version: str
    resume_id: str
    evidence_catalog_sha256: str
    selection_sha256: str
    files: list[_RenderFile]
    toolchain: _RenderToolchain
    checks: _RenderChecks
    warnings: list[str]


@dataclass(frozen=True, slots=True)
class ContractDescription:
    bridge_version: str
    renderer_version: str
    evidence_schema_version: int
    cli_checksum: str


@dataclass(frozen=True, slots=True)
class ContractExport:
    description: ContractDescription
    source_revision: str
    evidence: bytes
    evidence_checksum: str


@dataclass(frozen=True, slots=True)
class ContractOutput:
    path: str
    media_type: str
    checksum: str
    data: bytes


@dataclass(frozen=True, slots=True)
class ContractRender:
    description: ContractDescription
    source_revision: str
    renderer_version: str
    receipt: bytes
    outputs: tuple[ContractOutput, ...]
    page_count: int
    tool_versions: Mapping[str, str]

    def output(self, path: str) -> ContractOutput:
        try:
            return next(output for output in self.outputs if output.path == path)
        except StopIteration as error:
            raise ResumeContractError(
                f"Contract output is missing required file: {path}"
            ) from error


def _safe_relative_path(value: str, *, label: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if (
        not value
        or "\x00" in value
        or "\\" in value
        or path.is_absolute()
        or not path.parts
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(ord(character) < 32 for character in value)
    ):
        raise ResumeContractError(f"{label} contains an unsafe relative path")
    return path


def _canonical_json_bytes(value: object) -> bytes:
    try:
        data = (
            json.dumps(
                value,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValidationError("Résumé contract request is not JSON serializable") from error
    return data


def _canonical_contract_request(value: object) -> bytes:
    data = _canonical_json_bytes(value)
    if len(data) > _MAX_REQUEST_BYTES:
        raise ValidationError("Résumé contract request exceeds the size limit")
    return data


def _load_canonical_json(data: bytes, *, label: str) -> object:
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate field: {key}")
            result[key] = value
        return result

    try:
        value = json.loads(data, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ResumeContractError(f"Trusted résumé {label} is not valid JSON") from error
    if _canonical_json_bytes(value) != data:
        raise ResumeContractError(f"Trusted résumé {label} is not canonical JSON")
    return value


def _validate_checksum(value: str, *, label: str) -> str:
    normalized = value.lower()
    if value != normalized or not _CHECKSUM.fullmatch(normalized):
        raise ResumeContractError(f"Trusted résumé {label} has an invalid checksum")
    return normalized


class TrustedResumeContractRunner:
    """Run only the fixed v1 CLI found inside a trusted immutable Git archive."""

    def __init__(
        self,
        *,
        python_executable: str = sys.executable,
        command_timeout_seconds: float = 120.0,
        inherited_environment: Mapping[str, str] | None = None,
    ) -> None:
        if not python_executable or "\x00" in python_executable:
            raise ValueError("Python executable must not be empty")
        if command_timeout_seconds <= 0:
            raise ValueError("Contract timeout must be greater than zero")
        self._python = python_executable
        self._timeout = command_timeout_seconds
        self._inherited_environment = (
            os.environ if inherited_environment is None else inherited_environment
        )

    async def inspect_and_export(
        self,
        archive: bytes,
        *,
        source_revision: str,
        expected_cli_checksum: str | None = None,
    ) -> ContractExport:
        return await _cancellable_thread(
            lambda cancellation: self._inspect_and_export_sync(
                archive,
                source_revision=source_revision,
                expected_cli_checksum=expected_cli_checksum,
                cancellation=cancellation,
            )
        )

    async def render(
        self,
        archive: bytes,
        *,
        source_revision: str,
        selection: Mapping[str, object],
        evidence_checksum: str,
        expected_cli_checksum: str,
    ) -> ContractRender:
        return await _cancellable_thread(
            lambda cancellation: self._render_sync(
                archive,
                source_revision=source_revision,
                selection=selection,
                evidence_checksum=evidence_checksum,
                expected_cli_checksum=expected_cli_checksum,
                cancellation=cancellation,
            )
        )

    def _inspect_and_export_sync(
        self,
        archive: bytes,
        *,
        source_revision: str,
        expected_cli_checksum: str | None,
        cancellation: threading.Event,
    ) -> ContractExport:
        revision = _validated_revision(source_revision)
        with self._prepared_archive(
            archive,
            expected_cli_checksum=expected_cli_checksum,
        ) as prepared:
            description = self._describe(prepared, cancellation=cancellation)
            stdout = self._run_cli(
                prepared,
                [
                    "export",
                    "--protocol",
                    CONTRACT_PROTOCOL_VERSION,
                    "--source-revision",
                    revision,
                ],
                operation="export",
                cancellation=cancellation,
            )
            catalog = _parse_evidence(stdout, expected_revision=revision)
            if catalog.renderer_version != description.renderer_version:
                raise ResumeContractError(
                    "Trusted résumé export and bridge renderer versions disagree"
                )
            return ContractExport(
                description=description,
                source_revision=revision,
                evidence=stdout,
                evidence_checksum=hashlib.sha256(stdout).hexdigest(),
            )

    def _render_sync(
        self,
        archive: bytes,
        *,
        source_revision: str,
        selection: Mapping[str, object],
        evidence_checksum: str,
        expected_cli_checksum: str,
        cancellation: threading.Event,
    ) -> ContractRender:
        revision = _validated_revision(source_revision)
        checksum = _validate_checksum(evidence_checksum, label="evidence")
        with self._prepared_archive(
            archive,
            expected_cli_checksum=expected_cli_checksum,
        ) as prepared:
            description = self._describe(prepared, cancellation=cancellation)
            request = _canonical_contract_request(dict(selection))
            selection_checksum = hashlib.sha256(request).hexdigest()
            output_root = prepared.work_root / "outputs"
            stdout = self._run_cli(
                prepared,
                [
                    "render",
                    "--protocol",
                    CONTRACT_PROTOCOL_VERSION,
                    "--output-dir",
                    str(output_root),
                ],
                operation="render",
                stdin=request,
                cancellation=cancellation,
                monitored_output_root=output_root,
            )
            result = _parse_render_result(
                stdout,
                expected_revision=revision,
                expected_evidence_checksum=checksum,
                expected_selection_checksum=selection_checksum,
                expected_renderer_version=description.renderer_version,
            )
            outputs = _validate_render_outputs(
                output_root,
                result,
                stdout,
                evidence_checksum=checksum,
                selection=request,
            )
            return ContractRender(
                description=description,
                source_revision=revision,
                renderer_version=result.renderer_version,
                receipt=stdout,
                outputs=outputs,
                page_count=result.checks.page_count,
                tool_versions=MappingProxyType(
                    {
                        "python": result.toolchain.python_version,
                        "latexmk": result.toolchain.latexmk_version,
                        "pdftex": result.toolchain.pdftex_version,
                        "pdfinfo": result.toolchain.pdfinfo_version,
                        "pdftotext": result.toolchain.pdftotext_version,
                    }
                ),
            )

    def _describe(
        self,
        prepared: _PreparedArchive,
        *,
        cancellation: threading.Event,
    ) -> ContractDescription:
        stdout = self._run_cli(
            prepared,
            ["describe", "--protocol", CONTRACT_PROTOCOL_VERSION],
            operation="describe",
            cancellation=cancellation,
        )
        value = _load_canonical_json(stdout, label="bridge description")
        try:
            description = _BridgeDescription.model_validate(value)
        except PydanticValidationError as error:
            raise ResumeContractError(
                "Trusted résumé bridge description is incompatible"
            ) from error
        if description.commands != ["describe", "export", "render"]:
            raise ResumeContractError("Trusted résumé bridge command set is incompatible")
        if description.schemas != {
            "evidence_catalog": 1,
            "render_result": 1,
            "tailoring_selection": 1,
        }:
            raise ResumeContractError("Trusted résumé bridge schemas are incompatible")
        if set(description.supported_paper_sizes) != {"a4paper", "letterpaper"}:
            raise ResumeContractError("Trusted résumé bridge paper sizes are incompatible")
        return ContractDescription(
            bridge_version=description.bridge_version,
            renderer_version=description.renderer_version,
            evidence_schema_version=description.schemas["evidence_catalog"],
            cli_checksum=prepared.cli_checksum,
        )

    def _run_cli(
        self,
        prepared: _PreparedArchive,
        arguments: Sequence[str],
        *,
        operation: str,
        stdin: bytes | None = None,
        cancellation: threading.Event,
        monitored_output_root: Path | None = None,
    ) -> bytes:
        stdout_path = prepared.work_root / f"{operation}.stdout.json"
        stderr_path = prepared.work_root / f"{operation}.stderr.json"
        stdin_path = prepared.work_root / f"{operation}.stdin.json"
        if stdin is not None:
            stdin_path.write_bytes(stdin)
        environment = sanitized_subprocess_environment(
            prepared.work_root,
            source_date_epoch=0,
            inherited=self._inherited_environment,
        )
        command = [self._python, "-I", "-B", str(prepared.cli_path), *arguments]
        if cancellation.is_set():
            raise _ContractExecutionCancelled
        process: subprocess.Popen[bytes] | None = None
        try:
            with (
                stdout_path.open("wb") as stdout_stream,
                stderr_path.open("wb") as stderr_stream,
                (
                    stdin_path.open("rb") if stdin is not None else open(os.devnull, "rb")
                ) as stdin_stream,
            ):
                process = subprocess.Popen(
                    command,
                    cwd=prepared.source_root,
                    env=environment,
                    shell=False,
                    stdin=stdin_stream,
                    stdout=stdout_stream,
                    stderr=stderr_stream,
                    start_new_session=os.name == "posix",
                )
                deadline = time.monotonic() + self._timeout
                while True:
                    if cancellation.is_set():
                        _terminate_process_group(process)
                        raise _ContractExecutionCancelled
                    limit = _execution_limit_violation(
                        prepared.work_root,
                        stdout_path=stdout_path,
                        stderr_path=stderr_path,
                        output_root=monitored_output_root,
                    )
                    if limit is not None:
                        _terminate_process_group(process)
                        raise ResumeContractError(
                            "Trusted résumé contract exceeded an execution limit",
                            details={"operation": operation, "limit": limit},
                        )
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        _terminate_process_group(process)
                        raise subprocess.TimeoutExpired(command, self._timeout)
                    try:
                        return_code = process.wait(timeout=min(0.05, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        continue
                # A successful parent is not proof that the bridge process tree is
                # finished. Tear down the isolated group before reading or trusting
                # any output so a forked descendant cannot mutate it after validation.
                _terminate_process_group(process)
                limit = _execution_limit_violation(
                    prepared.work_root,
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    output_root=monitored_output_root,
                )
                if limit is not None:
                    raise ResumeContractError(
                        "Trusted résumé contract exceeded an execution limit",
                        details={"operation": operation, "limit": limit},
                    )
                if return_code != 0:
                    raise subprocess.CalledProcessError(return_code, command)
        except FileNotFoundError as error:
            raise ResumeContractUnavailableError(
                "Python is required to run the trusted résumé contract",
                details={"capability": "master_resume_contract"},
            ) from error
        except subprocess.TimeoutExpired as error:
            if process is not None:
                _terminate_process_group(process)
            raise ResumeContractError(
                "Trusted résumé contract timed out",
                details={"operation": operation, "timeout_seconds": self._timeout},
            ) from error
        except subprocess.CalledProcessError as error:
            error_code = _read_contract_error_code(stderr_path)
            details: dict[str, object] = {
                "operation": operation,
                "exit_code": error.returncode,
            }
            if error_code is not None:
                details["contract_error_code"] = error_code
            raise ResumeContractError(
                "Trusted résumé contract rejected the request",
                details=details,
            ) from error
        except OSError as error:
            if process is not None:
                _terminate_process_group(process)
            raise ResumeContractError("Trusted résumé contract could not be executed") from error
        _read_bounded(stderr_path, _MAX_STDERR_BYTES, "contract diagnostics")
        return _read_bounded(stdout_path, _MAX_STDOUT_BYTES, "contract output")

    def _prepared_archive(
        self,
        archive: bytes,
        *,
        expected_cli_checksum: str | None,
    ) -> _PreparedArchiveContext:
        return _PreparedArchiveContext(
            archive,
            expected_cli_checksum=expected_cli_checksum,
        )


@dataclass(frozen=True, slots=True)
class _PreparedArchive:
    source_root: Path
    work_root: Path
    cli_path: Path
    cli_checksum: str


class _PreparedArchiveContext:
    def __init__(self, archive: bytes, *, expected_cli_checksum: str | None) -> None:
        self._archive = archive
        self._expected_cli_checksum = expected_cli_checksum
        self._temporary: tempfile.TemporaryDirectory[str] | None = None

    def __enter__(self) -> _PreparedArchive:
        if not self._archive or len(self._archive) > _MAX_ARCHIVE_BYTES:
            raise ResumeContractError("Trusted résumé source archive is empty or too large")
        if self._expected_cli_checksum is not None:
            _validate_checksum(self._expected_cli_checksum, label="contract CLI")
        self._temporary = tempfile.TemporaryDirectory(prefix="roleloop-contract-")
        try:
            root = Path(self._temporary.name).resolve(strict=True)
            source_root = root / "source"
            source_root.mkdir(mode=0o700)
            _extract_tar_safely(self._archive, source_root)
            cli_path = source_root.joinpath(*CONTRACT_CLI_PATH.parts)
            if cli_path.is_symlink() or not cli_path.is_file():
                raise ResumeContractUnavailableError(
                    f"Trusted résumé repository must contain {CONTRACT_CLI_PATH.as_posix()}",
                    details={"capability": "master_resume_contract"},
                )
            cli_checksum = hashlib.sha256(cli_path.read_bytes()).hexdigest()
            if (
                self._expected_cli_checksum is not None
                and cli_checksum != self._expected_cli_checksum
            ):
                raise ResumeContractError("Pinned résumé contract CLI checksum does not match")
            work_root = root / "work"
            work_root.mkdir(mode=0o700)
            return _PreparedArchive(source_root, work_root, cli_path, cli_checksum)
        except BaseException:
            self._temporary.cleanup()
            self._temporary = None
            raise

    def __exit__(self, *_: object) -> None:
        if self._temporary is not None:
            self._temporary.cleanup()


def _validated_revision(value: str) -> str:
    revision = value.strip().lower()
    if not _REVISION.fullmatch(revision):
        raise ValidationError("Résumé contract requires a full immutable Git revision")
    return revision


def _read_bounded(path: Path, maximum: int, label: str) -> bytes:
    try:
        size = path.stat().st_size
        if size > maximum:
            raise ResumeContractError(f"Trusted résumé {label} exceeds the size limit")
        return path.read_bytes()
    except ResumeContractError:
        raise
    except OSError as error:
        raise ResumeContractError(f"Trusted résumé {label} could not be read") from error


def _execution_limit_violation(
    work_root: Path,
    *,
    stdout_path: Path,
    stderr_path: Path,
    output_root: Path | None,
) -> str | None:
    """Inspect child-owned files without following links while the process runs."""

    for path, maximum, label in (
        (stdout_path, _MAX_STDOUT_BYTES, "stdout_bytes"),
        (stderr_path, _MAX_STDERR_BYTES, "stderr_bytes"),
    ):
        try:
            if path.lstat().st_size > maximum:
                return label
        except FileNotFoundError:
            pass
        except OSError:
            return "unsafe_work_file"

    work_usage = _bounded_tree_usage(
        work_root,
        maximum_bytes=_MAX_WORK_BYTES,
        maximum_entries=_MAX_ARCHIVE_MEMBERS,
    )
    if work_usage is not None:
        return f"work_{work_usage}"
    if output_root is not None and output_root.exists():
        output_usage = _bounded_tree_usage(
            output_root,
            maximum_bytes=_MAX_OUTPUT_BYTES,
            maximum_entries=_MAX_OUTPUT_FILES + 1,
        )
        if output_usage is not None:
            return f"output_{output_usage}"
    return None


def _bounded_tree_usage(
    root: Path,
    *,
    maximum_bytes: int,
    maximum_entries: int,
) -> str | None:
    """Return the first violated tree limit, avoiding links and special files."""

    try:
        if root.is_symlink() or not root.is_dir():
            return "unsafe_tree"
        pending = [root]
        total_bytes = 0
        entries = 0
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as children:
                for child in children:
                    entries += 1
                    if entries > maximum_entries:
                        return "entry_count"
                    try:
                        if child.is_symlink():
                            return "unsafe_entry"
                        if child.is_dir(follow_symlinks=False):
                            pending.append(Path(child.path))
                            continue
                        if not child.is_file(follow_symlinks=False):
                            return "unsafe_entry"
                        total_bytes += child.stat(follow_symlinks=False).st_size
                    except FileNotFoundError:
                        continue
                    if total_bytes > maximum_bytes:
                        return "bytes"
    except FileNotFoundError:
        return None
    except OSError:
        return "unsafe_tree"
    return None


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    """Terminate the isolated contract process tree, escalating after a grace period."""

    if process.poll() is not None and os.name != "posix":
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:  # pragma: no cover - exercised on Windows packaging smoke tests
            process.terminate()
    except ProcessLookupError:
        return
    except OSError:
        process.terminate()
    parent_exited = False
    try:
        process.wait(timeout=1.0)
        parent_exited = True
    except subprocess.TimeoutExpired:
        pass
    if os.name != "posix" and parent_exited:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, 0)
        except OSError as error:
            # macOS can report EPERM while probing a process group whose leader
            # has already exited. There is no safe escalation available in that
            # case, and falling back to ``process.terminate()`` would target the
            # already-reaped parent. ESRCH likewise means the group is gone.
            if error.errno in {errno.EPERM, errno.ESRCH}:
                return
            raise
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:  # pragma: no cover - exercised on Windows packaging smoke tests
            process.kill()
    except ProcessLookupError:
        return
    except OSError:
        process.kill()
    with suppress(subprocess.TimeoutExpired):
        process.wait(timeout=1.0)


def _read_contract_error_code(path: Path) -> str | None:
    try:
        data = _read_bounded(path, _MAX_STDERR_BYTES, "contract diagnostics")
        value = json.loads(data)
    except (ResumeContractError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    code = value.get("code")
    return code if isinstance(code, str) and _SAFE_ERROR_CODE.fullmatch(code) else None


def _extract_tar_safely(data: bytes, destination: Path) -> None:
    total_size = 0
    seen: set[str] = set()
    try:
        with tarfile.open(fileobj=BytesIO(data), mode="r:*") as archive:
            members = archive.getmembers()
            if len(members) > _MAX_ARCHIVE_MEMBERS:
                raise ResumeContractError("Trusted résumé archive contains too many entries")
            for member in members:
                relative = _safe_relative_path(member.name.rstrip("/"), label="Archive")
                normalized = relative.as_posix()
                if normalized in seen:
                    raise ResumeContractError("Trusted résumé archive contains duplicate paths")
                seen.add(normalized)
                if not (member.isdir() or member.isfile()):
                    raise ResumeContractError(
                        "Trusted résumé archive may contain only regular files and directories"
                    )
                total_size += member.size
                if member.size < 0 or total_size > _MAX_UNCOMPRESSED_BYTES:
                    raise ResumeContractError(
                        "Trusted résumé archive expands beyond the size limit"
                    )
                target = destination.joinpath(*relative.parts)
                if not target.resolve(strict=False).is_relative_to(destination):
                    raise ResumeContractError("Trusted résumé archive escapes its extraction root")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                source = archive.extractfile(member)
                if source is None:
                    raise ResumeContractError("Trusted résumé archive file could not be read")
                try:
                    content = source.read(member.size + 1)
                finally:
                    source.close()
                if len(content) != member.size:
                    raise ResumeContractError("Trusted résumé archive file size is inconsistent")
                with target.open("xb") as stream:
                    stream.write(content)
                target.chmod(0o400)
            for path in sorted(
                (item for item in destination.rglob("*") if item.is_dir()),
                key=lambda item: len(item.parts),
                reverse=True,
            ):
                path.chmod(0o500)
    except ResumeContractError:
        raise
    except (tarfile.TarError, OSError) as error:
        raise ResumeContractError("Trusted résumé source archive is invalid") from error


def _parse_evidence(data: bytes, *, expected_revision: str) -> _EvidenceCatalog:
    value = _load_canonical_json(data, label="evidence export")
    try:
        catalog = _EvidenceCatalog.model_validate(value)
    except PydanticValidationError as error:
        raise ResumeContractError("Trusted résumé evidence schema is incompatible") from error
    if catalog.source_revision != expected_revision:
        raise ResumeContractError("Trusted résumé evidence returned a different revision")
    identifiers = [catalog.summary.id]
    experiences: list[str] = []
    for experience in catalog.active_experiences:
        experiences.append(experience.id)
        for bullet in experience.bullets:
            if bullet.experience_id != experience.id:
                raise ResumeContractError(
                    "Trusted résumé evidence contains a cross-experience bullet"
                )
            identifiers.append(bullet.id)
            _validate_checksum(bullet.source_sha256, label="bullet source")
        _validate_checksum(experience.source_sha256, label="experience source")
    skill_ids = [skill.id for skill in catalog.allowed_skills]
    if len(identifiers) != len(set(identifiers)):
        raise ResumeContractError("Trusted résumé evidence contains duplicate IDs")
    if len(experiences) != len(set(experiences)):
        raise ResumeContractError("Trusted résumé evidence contains duplicate experiences")
    if len(skill_ids) != len(set(skill_ids)):
        raise ResumeContractError("Trusted résumé evidence contains duplicate skill IDs")
    if catalog.active_experience_order != experiences:
        raise ResumeContractError("Trusted résumé evidence order is inconsistent")
    _validate_checksum(catalog.summary.source_sha256, label="summary source")
    for path, checksum in catalog.tracked_manifest.items():
        _safe_relative_path(path, label="Evidence manifest")
        _validate_checksum(checksum, label="manifest")
    return catalog


def _parse_render_result(
    data: bytes,
    *,
    expected_revision: str,
    expected_evidence_checksum: str,
    expected_selection_checksum: str,
    expected_renderer_version: str,
) -> _RenderResult:
    value = _load_canonical_json(data, label="render receipt")
    try:
        result = _RenderResult.model_validate(value)
    except PydanticValidationError as error:
        raise ResumeContractError("Trusted résumé render receipt is incompatible") from error
    if result.source_revision != expected_revision:
        raise ResumeContractError("Trusted résumé render returned a different revision")
    if result.evidence_catalog_sha256 != expected_evidence_checksum:
        raise ResumeContractError("Trusted résumé render used different evidence")
    if result.renderer_version != expected_renderer_version:
        raise ResumeContractError("Trusted résumé renderer version changed unexpectedly")
    if result.selection_sha256 != expected_selection_checksum:
        raise ResumeContractError("Trusted résumé render used a different selection")
    if not (
        result.checks.valid_pdf_header
        and result.checks.ats_text_nonempty
        and result.checks.compile_log_sanitized
        and result.checks.page_count > 0
    ):
        raise ResumeContractError("Trusted résumé render checks did not pass")
    return result


def _validate_render_outputs(
    output_root: Path,
    result: _RenderResult,
    receipt: bytes,
    *,
    evidence_checksum: str,
    selection: bytes,
) -> tuple[ContractOutput, ...]:
    if output_root.is_symlink() or not output_root.is_dir():
        raise ResumeContractError("Trusted résumé render output directory is invalid")
    if len(result.files) > _MAX_OUTPUT_FILES:
        raise ResumeContractError("Trusted résumé render returned too many files")
    manifests: dict[str, _RenderFile] = {}
    for manifest in result.files:
        relative = _safe_relative_path(manifest.file_name, label="Render output")
        if len(relative.parts) != 1:
            raise ResumeContractError("Trusted résumé render outputs must be flat")
        if manifest.file_name in manifests:
            raise ResumeContractError("Trusted résumé render declared a duplicate output")
        expected_media_type = _RENDER_MEDIA_TYPES.get(manifest.file_name)
        if expected_media_type is None or manifest.media_type != expected_media_type:
            raise ResumeContractError("Trusted résumé render returned an unexpected output")
        _validate_checksum(manifest.sha256, label="render output")
        manifests[manifest.file_name] = manifest
    if set(manifests) != set(_RENDER_MEDIA_TYPES):
        raise ResumeContractError("Trusted résumé render output manifest is incomplete")

    actual: set[str] = set()
    for path in output_root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            raise ResumeContractError("Trusted résumé render created an unsafe output")
        actual.add(path.relative_to(output_root).as_posix())
    if actual != {*_RENDER_MEDIA_TYPES, _RENDER_RESULT_NAME}:
        raise ResumeContractError("Trusted résumé render created undeclared output files")
    result_path = output_root / _RENDER_RESULT_NAME
    if result_path.read_bytes() != receipt:
        raise ResumeContractError("Trusted résumé render receipts do not match")

    total_size = len(receipt)
    outputs: list[ContractOutput] = []
    for name in sorted(manifests):
        manifest = manifests[name]
        target = output_root / name
        data = target.read_bytes()
        total_size += len(data)
        if total_size > _MAX_OUTPUT_BYTES:
            raise ResumeContractError("Trusted résumé render outputs exceed the size limit")
        if len(data) != manifest.size_bytes or hashlib.sha256(data).hexdigest() != manifest.sha256:
            raise ResumeContractError("Trusted résumé render output checksum does not match")
        target.chmod(0o400)
        outputs.append(
            ContractOutput(
                path=name,
                media_type=manifest.media_type,
                checksum=manifest.sha256,
                data=data,
            )
        )
    result_path.chmod(0o400)
    by_name = {output.path: output for output in outputs}
    if by_name["evidence-catalog.json"].checksum != evidence_checksum:
        raise ResumeContractError("Trusted résumé render emitted different evidence")
    if by_name["tailoring-selection.json"].data != selection:
        raise ResumeContractError("Trusted résumé render emitted a different selection")
    return tuple(outputs)


class PersistedResumeSourceTrustPolicy:
    """Require trust on the current persisted repository configuration every sync."""

    def require(self, source: ResumeSource) -> None:
        if source.trust_acknowledged_at is None:
            raise ResumeContractUnavailableError(
                "Résumé repository trust must be acknowledged before contract execution",
                details={"capability": "master_resume_contract_trust"},
            )
        if source.kind is ResumeSourceKind.LOCAL_GIT:
            try:
                repository = Path(source.repository).expanduser().resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise ResumeContractUnavailableError(
                    "Trusted local résumé repository does not exist",
                    details={"capability": "master_resume_contract_trust"},
                ) from error
            if not repository.is_dir():
                raise ResumeContractUnavailableError(
                    "Trusted local résumé repository is not a directory",
                    details={"capability": "master_resume_contract_trust"},
                )
        elif source.kind is ResumeSourceKind.REMOTE_GIT:
            try:
                validate_remote_git_repository(source.repository)
            except InvalidGitRemote as error:
                raise ResumeContractUnavailableError(
                    "Trusted remote résumé repository is invalid",
                    details={"capability": "master_resume_contract_trust"},
                ) from error
        else:  # pragma: no cover - enum exhaustiveness guard
            raise ResumeContractUnavailableError(
                "Trusted résumé repository kind is unsupported",
                details={"capability": "master_resume_contract_trust"},
            )
        try:
            validate_git_ref(source.ref)
        except InvalidGitRef as error:
            raise ResumeContractUnavailableError(
                "Trusted résumé repository ref is invalid",
                details={"capability": "master_resume_contract_trust"},
            ) from error


class ContractResumeSourceSynchronizer:
    """Sync Git, execute its exact trusted contract, and return immutable evidence."""

    def __init__(
        self,
        git: GitResumeSourceSynchronizer,
        runner: TrustedResumeContractRunner,
        trust_policy: PersistedResumeSourceTrustPolicy | None = None,
    ) -> None:
        self._git = git
        self._runner = runner
        self._trust = trust_policy or PersistedResumeSourceTrustPolicy()

    async def sync(
        self,
        source: ResumeSource,
        *,
        progress: ProgressReporter,
    ) -> ResumeSourceSnapshot:
        self._trust.require(source)
        archive = await self._git.snapshot_archive(source, progress=progress)
        progress.report(
            ProgressUpdate(
                operation="resume_source_sync",
                stage="extracting_evidence",
                message="Running the pinned master résumé evidence contract",
            )
        )
        exported = await self._runner.inspect_and_export(
            archive.data,
            source_revision=archive.source_revision,
        )
        extracted_text = exported.evidence.decode("utf-8")
        progress.report(
            ProgressUpdate(
                operation="resume_source_sync",
                stage="ready",
                message="Pinned master résumé evidence is ready",
            )
        )
        return ResumeSourceSnapshot(
            source_bytes=exported.evidence,
            extracted_text=extracted_text,
            source_name="evidence-catalog.json",
            media_type="application/json",
            extension=".json",
            source_revision=archive.source_revision,
            content_checksum=exported.evidence_checksum,
            contract_schema_version=str(exported.description.evidence_schema_version),
            canonical_evidence_bytes=exported.evidence,
            canonical_evidence_media_type="application/json",
            source_bundle_bytes=archive.data,
            source_bundle_media_type="application/x-tar",
            renderer_protocol_version=CONTRACT_PROTOCOL_VERSION,
            renderer_version=exported.description.renderer_version,
            contract_checksum=exported.description.cli_checksum,
        )


class ContractMasterResumeRenderer:
    """Render through the CLI archived with the pinned evidence revision."""

    protocol_version = CONTRACT_PROTOCOL_VERSION

    def __init__(
        self,
        runner: TrustedResumeContractRunner,
        artifact_reader: ArtifactReader,
        pdf_inspector: PdfInspector,
    ) -> None:
        self._runner = runner
        self._artifacts = artifact_reader
        self._pdf = pdf_inspector

    async def render(
        self,
        request: MasterResumeRenderRequest,
        *,
        progress: ProgressReporter,
    ) -> MasterResumeRenderResult:
        evidence = request.evidence
        if evidence.source_bundle_artifact is None:
            raise ResumeContractUnavailableError(
                "Pinned evidence has no immutable source bundle",
                details={"capability": "master_resume_contract"},
            )
        if evidence.canonical_evidence_artifact is None:
            raise ResumeContractUnavailableError(
                "Pinned evidence has no canonical evidence artifact",
                details={"capability": "master_resume_contract"},
            )
        if evidence.source_revision is None or evidence.contract_checksum is None:
            raise ResumeContractUnavailableError(
                "Pinned evidence has no contract revision or checksum",
                details={"capability": "master_resume_contract"},
            )
        archive, catalog_bytes = await asyncio.gather(
            self._artifacts.read_bytes(evidence.source_bundle_artifact),
            self._artifacts.read_bytes(evidence.canonical_evidence_artifact),
        )
        catalog = _parse_evidence(
            catalog_bytes,
            expected_revision=evidence.source_revision,
        )
        evidence_checksum = hashlib.sha256(catalog_bytes).hexdigest()
        selection = {
            "schema": "roleloop.tailoring-selection.v1",
            "contract_version": 1,
            "source_revision": evidence.source_revision,
            "evidence_catalog_sha256": evidence_checksum,
            "job_version_id": str(request.job_version.id),
            "headline": request.selection.headline,
            "summary_id": catalog.summary.id,
            "skill_ids": list(request.selection.skill_ids),
            "experiences": [
                {
                    "experience_id": experience.experience_id,
                    "bullet_ids": list(experience.bullet_ids),
                }
                for experience in request.selection.experiences
            ],
            "paper_size": request.profile_version.paper_size,
            "maximum_pages": request.profile_version.page_limit,
        }
        progress.report(
            ProgressUpdate(
                operation="master_resume_render",
                stage="rendering",
                message="Rendering with the pinned master résumé contract",
            )
        )
        rendered = await self._runner.render(
            archive,
            source_revision=evidence.source_revision,
            selection=selection,
            evidence_checksum=evidence_checksum,
            expected_cli_checksum=evidence.contract_checksum,
        )
        pdf = rendered.output("resume.pdf")
        tailored_source_bundle = rendered.output("render-source.tar")
        selection_file = rendered.output("tailoring-selection.json")
        review = rendered.output("REVIEW.md")
        compile_log = rendered.output("compile.log")
        ats_text_output = rendered.output("ats.txt")
        inspection = self._pdf.inspect(pdf.data)
        if not inspection.valid:
            raise ResumeContractError(
                "Contract renderer returned an invalid PDF",
                details={"errors": inspection.errors},
            )
        if inspection.page_count != rendered.page_count:
            raise ResumeContractError("PDF inspection and render receipt page counts disagree")
        if inspection.page_count > request.profile_version.page_limit:
            raise ResumeContractError(
                "Contract renderer exceeded the pinned profile page limit",
                details={
                    "page_count": inspection.page_count,
                    "maximum_pages": request.profile_version.page_limit,
                },
            )
        try:
            contract_ats_text = ats_text_output.data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ResumeContractError("Contract renderer returned invalid ATS text") from error
        if not contract_ats_text.strip():
            raise ResumeContractError("Contract renderer returned empty ATS text")
        independently_extracted = inspection.extracted_text.strip()
        if not independently_extracted:
            raise ResumeContractError("Independent PDF inspection returned empty ATS text")
        if _normalized_ats_text(contract_ats_text) != _normalized_ats_text(independently_extracted):
            raise ResumeContractError("Contract ATS text does not match independent PDF extraction")
        progress.report(
            ProgressUpdate(
                operation="master_resume_render",
                stage="ready",
                message="Pinned résumé PDF is ready for review",
            )
        )
        output_checksums = {output.path: output.checksum for output in rendered.outputs}
        output_checksums[_RENDER_RESULT_NAME] = hashlib.sha256(rendered.receipt).hexdigest()
        return MasterResumeRenderResult(
            pdf=pdf.data,
            receipt=rendered.receipt,
            renderer_version=rendered.renderer_version,
            tailored_source_bundle=tailored_source_bundle.data,
            selection_file=selection_file.data,
            review_file=review.data,
            compile_log=compile_log.data,
            page_count=inspection.page_count,
            ats_text=independently_extracted,
            tool_versions=rendered.tool_versions,
            output_checksums=MappingProxyType(output_checksums),
            renderer_source_revision=rendered.source_revision,
        )


def _normalized_ats_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())
