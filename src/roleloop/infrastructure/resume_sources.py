"""Git-backed synchronization for versioned master-resume sources."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import os
import signal
import sqlite3
import subprocess
import tempfile
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from roleloop.application.dto import ProgressUpdate, ResumeSourceSnapshot
from roleloop.application.errors import (
    ProviderFailureError,
    ProviderUnavailableError,
    ValidationError,
)
from roleloop.application.ports import ProgressReporter
from roleloop.domain import ResumeSource, ResumeSourceKind
from roleloop.domain.git import (
    InvalidGitRef,
    InvalidGitRemote,
    validate_git_ref,
    validate_remote_git_repository,
)

_DEFAULT_COMMAND_TIMEOUT_SECONDS = 60.0
_MAX_REPOSITORY_ARCHIVE_BYTES = 100 * 1024 * 1024
_MAX_GIT_STDOUT_BYTES = 4 * 1024 * 1024
_MAX_GIT_STDERR_BYTES = 512 * 1024
_SYNC_OPERATION = "resume_source_sync"
_GIT_SSH_COMMAND = "ssh -oBatchMode=yes"
_GIT_SAFE_CONFIG_OVERRIDES = (
    ("core.fsmonitor", "false"),
    ("core.hooksPath", os.devnull),
    ("core.pager", "cat"),
    ("core.sshCommand", _GIT_SSH_COMMAND),
    ("credential.helper", ""),
    ("credential.interactive", "never"),
    ("protocol.ext.allow", "never"),
)
_GIT_INHERITED_ENVIRONMENT_ALLOWLIST = (
    # HOME preserves noninteractive SSH identities/known-hosts and HTTPS netrc
    # credentials while the separately pinned GIT_CONFIG_GLOBAL prevents Git from
    # loading ~/.gitconfig.
    "HOME",
    "PATH",
    "SSH_AUTH_SOCK",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    # Required by Git/SSH subprocess discovery on Windows packaging smoke tests.
    "COMSPEC",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
)
_SUPPORTED_DOCUMENTS = {
    ".json": "application/json",
    ".md": "text/markdown",
    ".tex": "text/plain",
    ".toml": "text/plain",
    ".txt": "text/plain",
    ".typ": "text/plain",
    ".yaml": "text/plain",
    ".yml": "text/plain",
}


class ResumeSourceSyncError(ProviderFailureError):
    """A configured master-resume repository could not be synchronized."""

    code = "resume_source_sync_error"


@dataclass(frozen=True, slots=True)
class _GitRepository:
    path: Path
    bare: bool

    def command_prefix(self) -> list[str]:
        if self.bare:
            return ["--git-dir", str(self.path)]
        return ["-C", str(self.path)]


@dataclass(frozen=True, slots=True)
class GitRepositoryArchive:
    """Tracked files from one exact Git commit, encoded as a tar archive."""

    source_revision: str
    data: bytes
    checksum: str


class GitResumeSourceSynchronizer:
    """Resolve master-resume files from clean local or cached remote Git repositories.

    Local repositories are only inspected. Remote repositories are cloned once as
    bare mirrors below ``cache_root`` and fetched on later explicit synchronizations.
    Source content is always read from an immutable commit, never from a live working
    tree.
    """

    def __init__(
        self,
        cache_root: Path,
        *,
        git_executable: str = "git",
        command_timeout_seconds: float = _DEFAULT_COMMAND_TIMEOUT_SECONDS,
    ) -> None:
        if command_timeout_seconds <= 0:
            raise ValueError("Git command timeout must be greater than zero")
        if not git_executable or "\x00" in git_executable:
            raise ValueError("Git executable must be a non-empty command")
        self.cache_root = cache_root.expanduser().resolve(strict=False)
        self._git_executable = git_executable
        self._command_timeout_seconds = command_timeout_seconds

    async def sync(
        self,
        source: ResumeSource,
        *,
        progress: ProgressReporter,
    ) -> ResumeSourceSnapshot:
        progress.report(
            ProgressUpdate(
                operation=_SYNC_OPERATION,
                stage="resolving",
                message="Resolving the configured master résumé revision",
            )
        )
        snapshot = await asyncio.to_thread(self._sync, source)
        progress.report(
            ProgressUpdate(
                operation=_SYNC_OPERATION,
                stage="ready",
                message="Master résumé snapshot is ready",
            )
        )
        return snapshot

    async def snapshot_archive(
        self,
        source: ResumeSource,
        *,
        progress: ProgressReporter,
    ) -> GitRepositoryArchive:
        """Archive every tracked file at the exact resolved commit.

        This is used only for an explicitly trusted résumé contract. It deliberately
        ignores ``document_path`` because contract v1 has a fixed CLI entrypoint.
        """

        progress.report(
            ProgressUpdate(
                operation=_SYNC_OPERATION,
                stage="archiving",
                message="Archiving the trusted master résumé revision",
            )
        )
        archive = await asyncio.to_thread(self._snapshot_archive, source)
        progress.report(
            ProgressUpdate(
                operation=_SYNC_OPERATION,
                stage="archived",
                message="Trusted master résumé revision is archived",
            )
        )
        return archive

    def _sync(self, source: ResumeSource) -> ResumeSourceSnapshot:
        document_path, extension, media_type = _validated_document_path(source.document_path)
        ref = _validated_ref(source.ref)

        if source.kind is ResumeSourceKind.LOCAL_GIT:
            repository = self._open_local_repository(source.repository)
            return self._snapshot_repository(
                repository,
                ref=ref,
                document_path=document_path,
                extension=extension,
                media_type=media_type,
            )
        elif source.kind is ResumeSourceKind.REMOTE_GIT:
            _validate_remote_repository(source.repository)
            self._ensure_cache_root()
            cache_key = hashlib.sha256(source.repository.encode("utf-8")).hexdigest()
            with self._remote_cache_lock(cache_key):
                repository = self._sync_remote_repository(source.repository)
                return self._snapshot_repository(
                    repository,
                    ref=ref,
                    document_path=document_path,
                    extension=extension,
                    media_type=media_type,
                )
        else:  # pragma: no cover - enum exhaustiveness guard
            raise ValidationError(f"Unsupported résumé source kind: {source.kind}")

    def _snapshot_archive(self, source: ResumeSource) -> GitRepositoryArchive:
        ref = _validated_ref(source.ref)
        if source.kind is ResumeSourceKind.LOCAL_GIT:
            repository = self._open_local_repository(source.repository)
            return self._archive_repository(repository, ref=ref)
        if source.kind is ResumeSourceKind.REMOTE_GIT:
            _validate_remote_repository(source.repository)
            self._ensure_cache_root()
            cache_key = hashlib.sha256(source.repository.encode("utf-8")).hexdigest()
            with self._remote_cache_lock(cache_key):
                repository = self._sync_remote_repository(source.repository)
                return self._archive_repository(repository, ref=ref)
        raise ValidationError(f"Unsupported résumé source kind: {source.kind}")

    def _archive_repository(
        self,
        repository: _GitRepository,
        *,
        ref: str,
    ) -> GitRepositoryArchive:
        revision = self._resolve_revision(repository, ref)
        archive = self._run_git_archive(
            [
                *repository.command_prefix(),
                "archive",
                "--format=tar",
                revision,
                "--",
            ],
            error_message="Trusted master résumé revision could not be archived",
        )
        if not archive:
            raise ResumeSourceSyncError("Trusted master résumé archive is empty")
        if len(archive) > _MAX_REPOSITORY_ARCHIVE_BYTES:
            raise ResumeSourceSyncError(
                "Trusted master résumé archive exceeds the size limit",
                details={"maximum_bytes": _MAX_REPOSITORY_ARCHIVE_BYTES},
            )
        return GitRepositoryArchive(
            source_revision=revision,
            data=archive,
            checksum=hashlib.sha256(archive).hexdigest(),
        )

    def _snapshot_repository(
        self,
        repository: _GitRepository,
        *,
        ref: str,
        document_path: PurePosixPath,
        extension: str,
        media_type: str,
    ) -> ResumeSourceSnapshot:
        revision = self._resolve_revision(repository, ref)
        content = self._copy_document_at_revision(repository, revision, document_path)
        source_bytes, extracted_text = _decode_document(content, extension)
        return ResumeSourceSnapshot(
            source_bytes=source_bytes,
            extracted_text=extracted_text,
            source_name=document_path.name,
            media_type=media_type,
            extension=extension,
            source_revision=revision,
            content_checksum=hashlib.sha256(source_bytes).hexdigest(),
        )

    @contextmanager
    def _remote_cache_lock(self, cache_key: str) -> Iterator[None]:
        """Serialize mutation and reads of one cached bare repository."""

        lock_path = self.cache_root / f".{cache_key}.lock.sqlite3"
        if lock_path.is_symlink():
            raise ResumeSourceSyncError("Managed résumé repository lock contains an unsafe link")
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(
                lock_path,
                timeout=self._command_timeout_seconds,
                isolation_level=None,
            )
            timeout_ms = max(1, int(self._command_timeout_seconds * 1_000))
            connection.execute(f"PRAGMA busy_timeout = {timeout_ms}")
            connection.execute("BEGIN EXCLUSIVE")
        except sqlite3.Error as error:
            if connection is not None:
                connection.close()
            raise ResumeSourceSyncError(
                "Managed résumé repository cache is busy or unavailable",
                details={
                    "operation": _SYNC_OPERATION,
                    "timeout_seconds": self._command_timeout_seconds,
                },
            ) from error
        assert connection is not None
        try:
            yield
        finally:
            if connection.in_transaction:
                connection.rollback()
            connection.close()

    def _open_local_repository(self, configured_path: str) -> _GitRepository:
        if not configured_path.strip() or "\x00" in configured_path:
            raise ValidationError("Local résumé repository path must not be empty")
        try:
            candidate = Path(configured_path).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ResumeSourceSyncError("Local résumé repository does not exist") from error
        if not candidate.is_dir():
            raise ResumeSourceSyncError("Local résumé repository must be a directory")

        result = self._run_git(
            ["-C", str(candidate), "rev-parse", "--show-toplevel"],
            error_message="Local résumé repository is not a Git working tree",
        )
        try:
            repository_root = Path(result.stdout.decode("utf-8").strip()).resolve(strict=True)
        except (OSError, UnicodeDecodeError) as error:
            raise ResumeSourceSyncError("Git returned an invalid local repository path") from error

        work_tree = _GitRepository(path=repository_root, bare=False)
        status = self._run_git(
            [
                *work_tree.command_prefix(),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ],
            error_message="Local résumé repository status could not be inspected",
        )
        if status.stdout:
            raise ResumeSourceSyncError(
                "Local résumé repository has uncommitted changes; "
                "commit or stash them before syncing",
                details={"repository_kind": ResumeSourceKind.LOCAL_GIT.value},
            )
        return work_tree

    def _sync_remote_repository(self, repository_url: str) -> _GitRepository:
        _validate_remote_repository(repository_url)
        self._ensure_cache_root()
        cache_key = hashlib.sha256(repository_url.encode("utf-8")).hexdigest()
        cache_path = self.cache_root / f"{cache_key}.git"
        if cache_path.is_symlink():
            raise ResumeSourceSyncError("Managed résumé repository cache contains an unsafe link")

        cloned = False
        if not cache_path.exists():
            cloned = self._clone_remote_repository(repository_url, cache_path)
        repository = _GitRepository(path=cache_path, bare=True)
        self._verify_cached_repository(repository, repository_url)
        if not cloned:
            self._run_git(
                [
                    *repository.command_prefix(),
                    "fetch",
                    "--prune",
                    "--force",
                    "origin",
                ],
                error_message="Remote résumé repository updates could not be fetched",
            )
        return repository

    def _clone_remote_repository(self, repository_url: str, cache_path: Path) -> bool:
        try:
            temporary_parent = tempfile.TemporaryDirectory(
                prefix=f".{cache_path.stem}-",
                dir=self.cache_root,
            )
        except OSError as error:
            raise ResumeSourceSyncError(
                "Managed résumé repository cache could not be created"
            ) from error

        with temporary_parent as temporary_directory:
            candidate = Path(temporary_directory) / "repository.git"
            self._run_git(
                ["clone", "--mirror", "--", repository_url, str(candidate)],
                error_message="Remote résumé repository could not be cloned",
            )
            try:
                candidate.rename(cache_path)
                return True
            except OSError as error:
                # Another synchronizer may have won the atomic cache population race.
                if cache_path.exists() and cache_path.is_dir() and not cache_path.is_symlink():
                    return False
                raise ResumeSourceSyncError(
                    "Remote résumé repository cache could not be installed"
                ) from error

    def _verify_cached_repository(
        self,
        repository: _GitRepository,
        expected_url: str,
    ) -> None:
        if not repository.path.is_dir():
            raise ResumeSourceSyncError("Managed résumé repository cache is invalid")
        root = repository.path.resolve(strict=True)
        if not root.is_relative_to(self.cache_root):
            raise ResumeSourceSyncError("Managed résumé repository cache escapes its root")

        bare = self._run_git(
            [*repository.command_prefix(), "rev-parse", "--is-bare-repository"],
            error_message="Managed résumé repository cache is not a Git repository",
        )
        if bare.stdout.strip() != b"true":
            raise ResumeSourceSyncError("Managed résumé repository cache is not bare")
        origin = self._run_git(
            [*repository.command_prefix(), "remote", "get-url", "origin"],
            error_message="Managed résumé repository cache has no origin",
        )
        try:
            actual_url = origin.stdout.decode("utf-8").strip()
        except UnicodeDecodeError as error:
            raise ResumeSourceSyncError(
                "Managed résumé repository cache has an invalid origin"
            ) from error
        if actual_url != expected_url:
            raise ResumeSourceSyncError("Managed résumé repository cache origin does not match")

    def _resolve_revision(self, repository: _GitRepository, ref: str) -> str:
        result = self._run_git(
            [
                *repository.command_prefix(),
                "rev-parse",
                "--verify",
                "--end-of-options",
                f"{ref}^{{commit}}",
            ],
            error_message=f"Configured résumé source ref does not resolve to a commit: {ref}",
        )
        try:
            revision = result.stdout.decode("ascii").strip().lower()
        except UnicodeDecodeError as error:  # pragma: no cover - Git hashes are ASCII
            raise ResumeSourceSyncError("Git returned an invalid commit revision") from error
        if not revision or any(character not in "0123456789abcdef" for character in revision):
            raise ResumeSourceSyncError("Git returned an invalid commit revision")
        return revision

    def _copy_document_at_revision(
        self,
        repository: _GitRepository,
        revision: str,
        document_path: PurePosixPath,
    ) -> bytes:
        listed = self._run_git(
            [
                *repository.command_prefix(),
                "ls-tree",
                "-z",
                revision,
                "--",
                document_path.as_posix(),
            ],
            error_message="Résumé document could not be resolved at the selected revision",
        )
        blob_id = _regular_blob_id(listed.stdout, document_path)
        content = self._run_git(
            [*repository.command_prefix(), "cat-file", "blob", blob_id],
            error_message="Résumé document could not be read at the selected revision",
        ).stdout

        # Materialize only the selected tracked blob in an isolated directory. This
        # avoids touching a local working tree and avoids running checkout filters or
        # hooks from a remote repository.
        try:
            with tempfile.TemporaryDirectory(prefix="roleloop-resume-source-") as directory:
                checkout_root = Path(directory).resolve(strict=True)
                destination = checkout_root.joinpath(*document_path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
                resolved_destination = destination.resolve(strict=True)
                if not resolved_destination.is_relative_to(checkout_root):  # pragma: no cover
                    raise ResumeSourceSyncError("Résumé document escapes its temporary checkout")
                return resolved_destination.read_bytes()
        except ResumeSourceSyncError:
            raise
        except OSError as error:
            raise ResumeSourceSyncError(
                "Résumé document temporary copy could not be created"
            ) from error

    def _ensure_cache_root(self) -> None:
        try:
            self.cache_root.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ResumeSourceSyncError("Managed résumé repository cache is unavailable") from error
        if not self.cache_root.is_dir():
            raise ResumeSourceSyncError("Managed résumé repository cache is not a directory")

    def _run_git(
        self,
        arguments: Sequence[str],
        *,
        error_message: str,
    ) -> subprocess.CompletedProcess[bytes]:
        return self._run_git_bounded(
            arguments,
            error_message=error_message,
            stdout_limit=_MAX_GIT_STDOUT_BYTES,
            stdout_limit_name="stdout_bytes",
            output_limit_message="Git command output exceeds the size limit",
        )

    def _run_git_archive(
        self,
        arguments: Sequence[str],
        *,
        error_message: str,
    ) -> bytes:
        """Stream a potentially large Git archive to bounded temporary storage."""

        return self._run_git_bounded(
            arguments,
            error_message=error_message,
            stdout_limit=_MAX_REPOSITORY_ARCHIVE_BYTES,
            stdout_limit_name="archive_bytes",
            output_limit_message="Trusted master résumé archive exceeds the size limit",
        ).stdout

    def _run_git_bounded(
        self,
        arguments: Sequence[str],
        *,
        error_message: str,
        stdout_limit: int,
        stdout_limit_name: str,
        output_limit_message: str,
    ) -> subprocess.CompletedProcess[bytes]:
        """Run Git with fixed config and environment boundaries and bounded output."""

        command = _git_command(self._git_executable, arguments)
        process: subprocess.Popen[bytes] | None = None
        try:
            with tempfile.TemporaryDirectory(prefix="roleloop-git-command-") as directory:
                root = Path(directory).resolve(strict=True)
                empty_global_config = root / "global.gitconfig"
                empty_global_config.write_bytes(b"")
                scratch = root / "tmp"
                scratch.mkdir()
                stdout_path = root / "git.stdout"
                stderr_path = root / "git.stderr"
                with (
                    stdout_path.open("wb") as stdout_stream,
                    stderr_path.open("wb") as stderr_stream,
                ):
                    process = subprocess.Popen(
                        command,
                        env=_git_environment(
                            empty_global_config=empty_global_config,
                            scratch=scratch,
                        ),
                        shell=False,
                        stdin=subprocess.DEVNULL,
                        stdout=stdout_stream,
                        stderr=stderr_stream,
                        start_new_session=os.name == "posix",
                    )
                    deadline = time.monotonic() + self._command_timeout_seconds
                    while True:
                        violation = _git_output_limit_violation(
                            stdout_path,
                            stderr_path,
                            stdout_limit=stdout_limit,
                            stdout_limit_name=stdout_limit_name,
                        )
                        if violation is not None:
                            _terminate_git_process_group(process)
                            limit_name, maximum_bytes = violation
                            raise ResumeSourceSyncError(
                                output_limit_message,
                                details={
                                    "operation": _SYNC_OPERATION,
                                    "limit": limit_name,
                                    "maximum_bytes": maximum_bytes,
                                },
                            )
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            _terminate_git_process_group(process)
                            raise subprocess.TimeoutExpired(
                                command,
                                self._command_timeout_seconds,
                            )
                        try:
                            return_code = process.wait(timeout=min(0.05, remaining))
                            break
                        except subprocess.TimeoutExpired:
                            continue
                    _terminate_git_process_group(process)
                    violation = _git_output_limit_violation(
                        stdout_path,
                        stderr_path,
                        stdout_limit=stdout_limit,
                        stdout_limit_name=stdout_limit_name,
                    )
                    if violation is not None:
                        limit_name, maximum_bytes = violation
                        raise ResumeSourceSyncError(
                            output_limit_message,
                            details={
                                "operation": _SYNC_OPERATION,
                                "limit": limit_name,
                                "maximum_bytes": maximum_bytes,
                            },
                        )
                    if return_code != 0:
                        raise subprocess.CalledProcessError(return_code, command)
                return subprocess.CompletedProcess(
                    args=command,
                    returncode=return_code,
                    stdout=stdout_path.read_bytes(),
                    stderr=stderr_path.read_bytes(),
                )
        except FileNotFoundError as error:
            raise ProviderUnavailableError(
                "Git is required to synchronize a master résumé repository",
                details={"capability": _SYNC_OPERATION},
            ) from error
        except subprocess.TimeoutExpired as error:
            if process is not None:
                _terminate_git_process_group(process)
            raise ResumeSourceSyncError(
                f"{error_message} before the Git command timed out",
                details={
                    "operation": _SYNC_OPERATION,
                    "timeout_seconds": self._command_timeout_seconds,
                },
            ) from error
        except subprocess.CalledProcessError as error:
            raise ResumeSourceSyncError(
                error_message,
                details={"operation": _SYNC_OPERATION, "exit_code": error.returncode},
            ) from error
        except ResumeSourceSyncError:
            raise
        except OSError as error:
            if process is not None:
                _terminate_git_process_group(process)
            raise ResumeSourceSyncError(error_message) from error


def _git_command(executable: str, arguments: Sequence[str]) -> list[str]:
    command = [executable, "--no-pager"]
    for key, value in _GIT_SAFE_CONFIG_OVERRIDES:
        command.extend(("-c", f"{key}={value}"))
    command.extend(arguments)
    return command


def _git_environment(
    *,
    empty_global_config: Path,
    scratch: Path,
    inherited: Mapping[str, str] | None = None,
) -> dict[str, str]:
    source = os.environ if inherited is None else inherited
    environment = {
        key: value
        for key in _GIT_INHERITED_ENVIRONMENT_ALLOWLIST
        if (value := source.get(key)) is not None and "\x00" not in value
    }
    environment.setdefault("PATH", os.defpath)
    environment.update(
        {
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(empty_global_config),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_LITERAL_PATHSPECS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_PAGER": "cat",
            "GIT_SSH_COMMAND": _GIT_SSH_COMMAND,
            "GIT_SSH_VARIANT": "ssh",
            "GIT_TERMINAL_PROMPT": "0",
            "LANG": "C",
            "LC_ALL": "C",
            "PAGER": "cat",
            "TMPDIR": str(scratch),
        }
    )
    return environment


def _git_output_limit_violation(
    stdout_path: Path,
    stderr_path: Path,
    *,
    stdout_limit: int,
    stdout_limit_name: str,
) -> tuple[str, int] | None:
    try:
        if stdout_path.stat().st_size > stdout_limit:
            return stdout_limit_name, stdout_limit
        if stderr_path.stat().st_size > _MAX_GIT_STDERR_BYTES:
            return "stderr_bytes", _MAX_GIT_STDERR_BYTES
    except FileNotFoundError:
        return None
    except OSError:
        return "unsafe_output", max(stdout_limit, _MAX_GIT_STDERR_BYTES)
    return None


def _terminate_git_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None and os.name != "posix":
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:  # pragma: no cover - Windows packaging smoke only
            process.terminate()
    except ProcessLookupError:
        return
    except OSError:
        with suppress(OSError):
            process.terminate()
    with suppress(subprocess.TimeoutExpired):
        process.wait(timeout=0.5)
    if os.name == "posix":
        try:
            os.killpg(process.pid, 0)
        except OSError as error:
            # A post-wait process-group probe can report EPERM on macOS after
            # the group leader exits. Treat EPERM and ESRCH as terminal cleanup
            # states instead of falling back to the already-exited parent.
            if error.errno in {errno.EPERM, errno.ESRCH}:
                return
            raise
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:  # pragma: no cover - Windows packaging smoke only
            process.kill()
    except ProcessLookupError:
        return
    except OSError:
        with suppress(OSError):
            process.kill()
    with suppress(subprocess.TimeoutExpired):
        process.wait(timeout=0.5)


def _validated_document_path(value: str) -> tuple[PurePosixPath, str, str]:
    raw_path = value.strip()
    document_path = PurePosixPath(raw_path)
    if (
        not raw_path
        or "\x00" in raw_path
        or "\\" in raw_path
        or document_path.is_absolute()
        or not document_path.parts
        or any(part in {"", ".", ".."} for part in document_path.parts)
        or any(ord(character) < 32 for character in raw_path)
    ):
        raise ValidationError("Résumé document path must be a safe repository-relative path")
    extension = document_path.suffix.lower()
    try:
        media_type = _SUPPORTED_DOCUMENTS[extension]
    except KeyError as error:
        supported = ", ".join(sorted(_SUPPORTED_DOCUMENTS))
        raise ValidationError(
            f"Unsupported résumé document type {extension or '(none)'}; "
            f"supported types: {supported}"
        ) from error
    return document_path, extension, media_type


def _validated_ref(value: str) -> str:
    try:
        return validate_git_ref(value)
    except InvalidGitRef as error:
        raise ValidationError(str(error)) from error


def _validate_remote_repository(value: str) -> None:
    try:
        validate_remote_git_repository(value)
    except InvalidGitRemote as error:
        raise ValidationError(str(error)) from error


def _regular_blob_id(tree_output: bytes, document_path: PurePosixPath) -> str:
    records = [record for record in tree_output.split(b"\x00") if record]
    if len(records) != 1:
        raise ResumeSourceSyncError(
            f"Résumé document is not tracked at the selected revision: {document_path.as_posix()}"
        )
    try:
        metadata, encoded_path = records[0].split(b"\t", maxsplit=1)
        mode, object_type, encoded_blob_id = metadata.split()
        listed_path = encoded_path.decode("utf-8")
        blob_id = encoded_blob_id.decode("ascii")
    except (UnicodeDecodeError, ValueError) as error:
        raise ResumeSourceSyncError("Git returned invalid résumé document metadata") from error
    if listed_path != document_path.as_posix():
        raise ResumeSourceSyncError("Git resolved an unexpected résumé document path")
    if mode not in {b"100644", b"100755"} or object_type != b"blob":
        raise ResumeSourceSyncError("Résumé document must be a regular tracked file")
    if not blob_id or any(character not in "0123456789abcdef" for character in blob_id.lower()):
        raise ResumeSourceSyncError("Git returned an invalid résumé document object")
    return blob_id


def _decode_document(content: bytes, extension: str) -> tuple[bytes, str]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ResumeSourceSyncError("Résumé source document must be UTF-8 encoded") from error
    if extension != ".json":
        return content, text

    try:
        document = json.loads(
            text,
            object_pairs_hook=_json_object_without_duplicate_keys,
            parse_constant=_reject_nonstandard_json_constant,
        )
        canonical_text = json.dumps(
            document,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise ResumeSourceSyncError("Résumé JSON document is invalid") from error
    return content, canonical_text


def _json_object_without_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON object key: {key}")
        result[key] = value
    return result


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError(f"Non-standard JSON constant: {value}")
