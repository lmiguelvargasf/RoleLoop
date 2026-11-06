from __future__ import annotations

import errno
import hashlib
import io
import os
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import pytest

import roleloop.infrastructure.resume_sources as resume_sources_module
from roleloop.application.dto import ProgressUpdate
from roleloop.application.errors import ProviderUnavailableError, ValidationError
from roleloop.domain import ResumeSource, ResumeSourceKind
from roleloop.infrastructure import GitResumeSourceSynchronizer, ResumeSourceSyncError


class RecordingProgress:
    def __init__(self) -> None:
        self.updates: list[ProgressUpdate] = []

    def report(self, update: ProgressUpdate) -> None:
        self.updates.append(update)


def _git(repository: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _repository(path: Path) -> Path:
    path.mkdir()
    subprocess.run(
        ["git", "init", "-b", "main", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    _git(path, "config", "user.email", "roleloop@example.test")
    _git(path, "config", "user.name", "RoleLoop Tests")
    return path


def _commit(repository: Path, relative_path: str, content: str | bytes, message: str) -> str:
    destination = repository / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        destination.write_bytes(content)
    else:
        destination.write_text(content, encoding="utf-8")
    _git(repository, "add", "--", relative_path)
    _git(repository, "commit", "-m", message)
    return _git(repository, "rev-parse", "HEAD")


def _source(
    repository: Path | str,
    *,
    kind: ResumeSourceKind = ResumeSourceKind.LOCAL_GIT,
    document_path: str = "resume.md",
    ref: str = "HEAD",
) -> ResumeSource:
    return ResumeSource(
        id="source-1",
        profile_id="profile-1",
        kind=kind,
        repository=str(repository),
        ref=ref,
        document_path=document_path,
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
    pytest.fail(f"Git descendant {process_id} survived process-group cleanup")


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group behavior")
@pytest.mark.parametrize("probe_errno", [errno.EPERM, errno.ESRCH])
def test_git_process_group_probe_treats_terminal_errors_as_cleanup_complete(
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
            pytest.fail("cleanup must not terminate an already-exited Git parent")

        def kill(self) -> None:
            pytest.fail("a terminal process-group probe must not escalate")

    def fake_killpg(process_group: int, requested_signal: int) -> None:
        assert process_group == ExitedProcess.pid
        signals.append(requested_signal)
        if requested_signal == 0:
            raise OSError(probe_errno, "process-group probe is terminal")

    monkeypatch.setattr(resume_sources_module.os, "killpg", fake_killpg)

    resume_sources_module._terminate_git_process_group(  # type: ignore[arg-type]
        ExitedProcess()
    )

    assert signals == [resume_sources_module.signal.SIGTERM, 0]


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group behavior")
def test_git_kills_descendants_even_after_successful_parent_exit(tmp_path: Path) -> None:
    pid_path = tmp_path / "git-descendant.pid"
    fake_git = tmp_path / "fake-git"
    fake_git.write_text(
        f"#!{sys.executable}\n"
        "import subprocess\n"
        "import sys\n"
        "from pathlib import Path\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "'import time; time.sleep(60)'])\n"
        f"Path({str(pid_path)!r}).write_text(str(child.pid), encoding='utf-8')\n",
        encoding="utf-8",
    )
    fake_git.chmod(0o700)

    result = GitResumeSourceSynchronizer(
        tmp_path / "cache",
        git_executable=str(fake_git),
    )._run_git(["--version"], error_message="Fake Git could not run")

    assert result.returncode == 0
    _assert_process_exits(int(pid_path.read_text(encoding="utf-8")))


@pytest.mark.asyncio
async def test_clean_local_repository_resolves_an_immutable_markdown_snapshot(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "master-resume")
    revision = _commit(
        repository,
        "documents/resume.md",
        "# Experience\n\nBuilt RoleLoop\n",
        "Add resume",
    )
    progress = RecordingProgress()

    snapshot = await GitResumeSourceSynchronizer(tmp_path / "cache").sync(
        _source(repository, document_path="documents/resume.md"),
        progress=progress,
    )

    assert snapshot.source_bytes == b"# Experience\n\nBuilt RoleLoop\n"
    assert snapshot.extracted_text == "# Experience\n\nBuilt RoleLoop\n"
    assert snapshot.source_name == "resume.md"
    assert snapshot.media_type == "text/markdown"
    assert snapshot.extension == ".md"
    assert snapshot.source_revision == revision
    assert snapshot.content_checksum == hashlib.sha256(snapshot.source_bytes).hexdigest()
    assert [update.stage for update in progress.updates] == ["resolving", "ready"]
    assert not (tmp_path / "cache").exists()


@pytest.mark.asyncio
async def test_clean_local_repository_archives_only_the_resolved_commit(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "master-resume")
    revision = _commit(
        repository,
        "roleloop_contract/v1/cli.py",
        "print('contract')\n",
        "Add contract",
    )
    synchronizer = GitResumeSourceSynchronizer(tmp_path / "cache")

    snapshot = await synchronizer.snapshot_archive(
        _source(repository),
        progress=RecordingProgress(),
    )

    assert snapshot.source_revision == revision
    assert snapshot.checksum == hashlib.sha256(snapshot.data).hexdigest()
    with tarfile.open(fileobj=io.BytesIO(snapshot.data), mode="r:") as archive:
        contract = archive.extractfile("roleloop_contract/v1/cli.py")
        assert contract is not None
        assert contract.read() == b"print('contract')\n"


@pytest.mark.asyncio
async def test_repository_archive_is_streamed_and_rejected_at_live_size_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = _repository(tmp_path / "oversized-master-resume")
    _commit(repository, "large.bin", b"x" * (64 * 1024), "Add oversized fixture")
    monkeypatch.setattr(
        resume_sources_module,
        "_MAX_REPOSITORY_ARCHIVE_BYTES",
        16 * 1024,
    )

    with pytest.raises(ResumeSourceSyncError, match="exceeds the size limit") as failure:
        await GitResumeSourceSynchronizer(tmp_path / "cache").snapshot_archive(
            _source(repository),
            progress=RecordingProgress(),
        )

    assert failure.value.details["limit"] == "archive_bytes"


@pytest.mark.asyncio
async def test_local_repository_must_be_clean(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "master-resume")
    _commit(repository, "resume.md", "Committed resume", "Add resume")
    (repository / "notes.txt").write_text("untracked", encoding="utf-8")

    with pytest.raises(ResumeSourceSyncError, match="commit or stash"):
        await GitResumeSourceSynchronizer(tmp_path / "cache").sync(
            _source(repository),
            progress=RecordingProgress(),
        )


@pytest.mark.asyncio
async def test_remote_repository_is_cloned_once_then_fetched_on_explicit_sync(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A filesystem origin keeps the cache/fetch contract test hermetic. Production
    # validation rejects local paths for REMOTE_GIT before reaching this code.
    monkeypatch.setattr(resume_sources_module, "_validate_remote_repository", lambda _: None)
    origin = _repository(tmp_path / "origin")
    first_revision = _commit(origin, "resume.txt", "First version", "First resume")
    synchronizer = GitResumeSourceSynchronizer(tmp_path / "cache")
    source = _source(
        origin,
        kind=ResumeSourceKind.REMOTE_GIT,
        document_path="resume.txt",
        ref="main",
    )

    first = await synchronizer.sync(source, progress=RecordingProgress())
    cache_repositories = list((tmp_path / "cache").glob("*.git"))
    assert len(cache_repositories) == 1
    cached_repository = cache_repositories[0]
    cached_inode = cached_repository.stat().st_ino

    second_revision = _commit(origin, "resume.txt", "Second version", "Update resume")
    second = await synchronizer.sync(source, progress=RecordingProgress())

    assert first.source_revision == first_revision
    assert first.source_bytes == b"First version"
    assert second.source_revision == second_revision
    assert second.source_bytes == b"Second version"
    assert cached_repository.stat().st_ino == cached_inode
    assert list((tmp_path / "cache").glob("*.git")) == [cached_repository]


@pytest.mark.asyncio
async def test_json_preserves_source_bytes_and_canonicalizes_extracted_text(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "master-resume")
    _commit(
        repository,
        "resume.json",
        '{\n  "z": 1, "skills": {"β": true, "a": [2, 1]}\n}\n',
        "Add JSON resume",
    )

    snapshot = await GitResumeSourceSynchronizer(tmp_path / "cache").sync(
        _source(repository, document_path="resume.json"),
        progress=RecordingProgress(),
    )

    expected_source = '{\n  "z": 1, "skills": {"β": true, "a": [2, 1]}\n}\n'.encode()
    expected_text = '{"skills":{"a":[2,1],"β":true},"z":1}'
    assert snapshot.source_bytes == expected_source
    assert snapshot.extracted_text == expected_text
    assert snapshot.media_type == "application/json"
    assert snapshot.content_checksum == hashlib.sha256(expected_source).hexdigest()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("document_path", "message"),
    [
        ("../resume.md", "safe repository-relative"),
        ("/tmp/resume.md", "safe repository-relative"),
        ("resume\\resume.md", "safe repository-relative"),
        ("resume.pdf", "Unsupported résumé document type"),
    ],
)
async def test_unsafe_paths_and_unknown_document_types_are_rejected(
    tmp_path: Path,
    document_path: str,
    message: str,
) -> None:
    repository = _repository(tmp_path / document_path.encode().hex())
    _commit(repository, "resume.md", "Resume", "Add resume")

    with pytest.raises(ValidationError, match=message):
        await GitResumeSourceSynchronizer(tmp_path / "cache").sync(
            _source(repository, document_path=document_path),
            progress=RecordingProgress(),
        )


@pytest.mark.asyncio
async def test_invalid_text_and_json_are_rejected(tmp_path: Path) -> None:
    invalid_text = _repository(tmp_path / "invalid-text")
    _commit(invalid_text, "resume.typ", b"RoleLoop\xff", "Add invalid text")
    with pytest.raises(ResumeSourceSyncError, match="UTF-8"):
        await GitResumeSourceSynchronizer(tmp_path / "cache-text").sync(
            _source(invalid_text, document_path="resume.typ"),
            progress=RecordingProgress(),
        )

    duplicate_json = _repository(tmp_path / "duplicate-json")
    _commit(duplicate_json, "resume.json", '{"skill": 1, "skill": 2}', "Add invalid JSON")
    with pytest.raises(ResumeSourceSyncError, match="JSON document is invalid"):
        await GitResumeSourceSynchronizer(tmp_path / "cache-json").sync(
            _source(duplicate_json, document_path="resume.json"),
            progress=RecordingProgress(),
        )


@pytest.mark.asyncio
async def test_unsafe_ref_and_password_bearing_remote_are_rejected(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "master-resume")
    _commit(repository, "resume.md", "Resume", "Add resume")
    synchronizer = GitResumeSourceSynchronizer(tmp_path / "cache")

    with pytest.raises(ValidationError, match="safe Git revision"):
        await synchronizer.sync(
            _source(repository, ref="--upload-pack=malicious"),
            progress=RecordingProgress(),
        )
    with pytest.raises(ValidationError, match="must not contain a password"):
        await synchronizer.sync(
            _source(
                "https://user:secret@example.test/resume.git",
                kind=ResumeSourceKind.REMOTE_GIT,
                ref="main",
            ),
            progress=RecordingProgress(),
        )
    with pytest.raises(ValidationError, match="must not contain user information"):
        await synchronizer.sync(
            _source(
                "https://token@example.test/resume.git",
                kind=ResumeSourceKind.REMOTE_GIT,
                ref="main",
            ),
            progress=RecordingProgress(),
        )
    with pytest.raises(ValidationError, match="must not contain a query or fragment"):
        await synchronizer.sync(
            _source(
                "https://example.test/resume.git?token=secret",
                kind=ResumeSourceKind.REMOTE_GIT,
                ref="main",
            ),
            progress=RecordingProgress(),
        )
    with pytest.raises(ValidationError, match="must use an HTTP"):
        await synchronizer.sync(
            _source(repository, kind=ResumeSourceKind.REMOTE_GIT, ref="main"),
            progress=RecordingProgress(),
        )
    with pytest.raises(ValidationError, match="must use an HTTP"):
        await synchronizer.sync(
            _source(
                "ext::sh -c malicious",
                kind=ResumeSourceKind.REMOTE_GIT,
                ref="main",
            ),
            progress=RecordingProgress(),
        )


@pytest.mark.asyncio
async def test_missing_git_executable_raises_provider_unavailable(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "master-resume")
    _commit(repository, "resume.md", "Resume", "Add resume")
    synchronizer = GitResumeSourceSynchronizer(
        tmp_path / "cache",
        git_executable="roleloop-test-git-does-not-exist",
    )

    with pytest.raises(ProviderUnavailableError, match="Git is required"):
        await synchronizer.sync(_source(repository), progress=RecordingProgress())


def test_git_subprocesses_are_strictly_noninteractive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 123456

        def poll(self) -> int:
            return 0

        def wait(self, *, timeout: float) -> int:
            del timeout
            return 0

    def fake_popen(arguments: list[str], **kwargs: object) -> FakeProcess:
        captured["arguments"] = arguments
        captured.update(kwargs)
        stdout = kwargs["stdout"]
        assert hasattr(stdout, "write")
        stdout.write(b"git version 2.0\n")  # type: ignore[union-attr]
        environment = kwargs["env"]
        assert isinstance(environment, dict)
        global_config = Path(environment["GIT_CONFIG_GLOBAL"])
        captured["global_config_was_empty"] = global_config.read_bytes() == b""
        return FakeProcess()

    monkeypatch.setenv("OPENAI_API_KEY", "must-not-cross-git-boundary")
    monkeypatch.setenv("ROLELOOP_TEST_SECRET", "must-not-cross-git-boundary")
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.fsmonitor")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "/tmp/ambient-fsmonitor")
    monkeypatch.setenv("GIT_CONFIG_PARAMETERS", "'core.hooksPath'='/tmp/hooks'")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/tmp/malicious-global-config")
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", "/tmp/malicious-system-config")
    monkeypatch.setenv("GIT_EXEC_PATH", "/tmp/malicious-git-exec-path")
    monkeypatch.setenv("GIT_EXTERNAL_DIFF", "/tmp/malicious-diff")
    monkeypatch.setenv("GIT_ASKPASS", "/tmp/malicious-askpass")
    monkeypatch.setenv("GIT_PROXY_COMMAND", "/tmp/malicious-proxy")
    monkeypatch.setenv("GIT_EDITOR", "/tmp/malicious-editor")
    monkeypatch.setenv("GIT_TRACE2_EVENT", "/tmp/leaked-git-trace")
    monkeypatch.setenv("GIT_SSH", "/tmp/malicious-ssh")
    monkeypatch.setenv("GIT_SSH_COMMAND", "malicious-ssh --leak-secret")
    monkeypatch.setenv("GIT_DIR", "/tmp/malicious-git-dir")
    monkeypatch.setenv("GIT_WORK_TREE", "/tmp/malicious-work-tree")
    monkeypatch.setenv("SSH_AUTH_SOCK", "/tmp/roleloop-test-agent.sock")
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(resume_sources_module, "_terminate_git_process_group", lambda _: None)
    synchronizer = GitResumeSourceSynchronizer(tmp_path / "cache")
    synchronizer._run_git(["--version"], error_message="Git could not run")

    environment = captured["env"]
    assert isinstance(environment, dict)
    arguments = captured["arguments"]
    assert isinstance(arguments, list)
    configured_values = {
        arguments[index + 1] for index, argument in enumerate(arguments[:-1]) if argument == "-c"
    }
    assert captured["stdin"] is subprocess.DEVNULL
    assert captured["shell"] is False
    assert captured["global_config_was_empty"] is True
    assert "core.fsmonitor=false" in configured_values
    assert f"core.hooksPath={resume_sources_module.os.devnull}" in configured_values
    assert "credential.interactive=never" in configured_values
    assert "protocol.ext.allow=never" in configured_values
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert environment["GIT_SSH_COMMAND"] == "ssh -oBatchMode=yes"
    assert environment["SSH_AUTH_SOCK"] == "/tmp/roleloop-test-agent.sock"
    assert environment["GIT_CONFIG_NOSYSTEM"] == "1"
    assert environment["GIT_CONFIG_SYSTEM"] == resume_sources_module.os.devnull
    assert "OPENAI_API_KEY" not in environment
    assert "ROLELOOP_TEST_SECRET" not in environment
    assert "GIT_CONFIG_COUNT" not in environment
    assert "GIT_CONFIG_KEY_0" not in environment
    assert "GIT_CONFIG_VALUE_0" not in environment
    assert "GIT_CONFIG_PARAMETERS" not in environment
    assert environment["GIT_CONFIG_GLOBAL"] != "/tmp/malicious-global-config"
    assert environment["GIT_CONFIG_SYSTEM"] != "/tmp/malicious-system-config"
    assert "GIT_EXEC_PATH" not in environment
    assert "GIT_EXTERNAL_DIFF" not in environment
    assert "GIT_ASKPASS" not in environment
    assert "GIT_PROXY_COMMAND" not in environment
    assert "GIT_EDITOR" not in environment
    assert "GIT_TRACE2_EVENT" not in environment
    assert "GIT_SSH" not in environment
    assert "GIT_DIR" not in environment
    assert "GIT_WORK_TREE" not in environment


@pytest.mark.asyncio
async def test_local_and_global_fsmonitor_programs_never_run_or_receive_secrets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = _repository(tmp_path / "master-resume")
    _commit(repository, "resume.md", "Committed resume", "Add resume")
    sentinel = tmp_path / "fsmonitor-secret.txt"
    fsmonitor = tmp_path / "malicious-fsmonitor.sh"
    fsmonitor.write_text(
        f"#!/bin/sh\nprintf '%s' \"${{ROLELOOP_TEST_SECRET-missing}}\" > '{sentinel}'\n",
        encoding="utf-8",
    )
    fsmonitor.chmod(0o700)
    _git(repository, "config", "core.fsmonitor", str(fsmonitor))

    malicious_home = tmp_path / "malicious-home"
    malicious_home.mkdir()
    (malicious_home / ".gitconfig").write_text(
        f"[core]\n\tfsmonitor = {fsmonitor}\n\thooksPath = {tmp_path / 'hooks'}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(malicious_home))
    monkeypatch.setenv("ROLELOOP_TEST_SECRET", "ambient-secret")

    snapshot = await GitResumeSourceSynchronizer(tmp_path / "cache").sync(
        _source(repository),
        progress=RecordingProgress(),
    )

    assert snapshot.source_bytes == b"Committed resume"
    assert not sentinel.exists()


def test_regular_git_stdout_and_stderr_are_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    synchronizer = GitResumeSourceSynchronizer(tmp_path / "cache")
    monkeypatch.setattr(resume_sources_module, "_MAX_GIT_STDOUT_BYTES", 1)
    with pytest.raises(ResumeSourceSyncError, match="output exceeds") as stdout_failure:
        synchronizer._run_git(["--version"], error_message="Git could not run")
    assert stdout_failure.value.details == {
        "operation": "resume_source_sync",
        "limit": "stdout_bytes",
        "maximum_bytes": 1,
    }

    monkeypatch.setattr(
        resume_sources_module,
        "_MAX_GIT_STDOUT_BYTES",
        4 * 1024 * 1024,
    )
    monkeypatch.setattr(resume_sources_module, "_MAX_GIT_STDERR_BYTES", 1)
    with pytest.raises(ResumeSourceSyncError, match="output exceeds") as stderr_failure:
        synchronizer._run_git(
            ["roleloop-command-that-does-not-exist"],
            error_message="Git could not run",
        )
    assert stderr_failure.value.details == {
        "operation": "resume_source_sync",
        "limit": "stderr_bytes",
        "maximum_bytes": 1,
    }


def test_remote_cache_lock_is_cross_connection_and_bounded(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    first = GitResumeSourceSynchronizer(cache_root)
    contender = GitResumeSourceSynchronizer(cache_root, command_timeout_seconds=0.01)
    first._ensure_cache_root()

    with (
        first._remote_cache_lock("a" * 64),
        pytest.raises(ResumeSourceSyncError, match="busy or unavailable"),
        contender._remote_cache_lock("a" * 64),
    ):
        raise AssertionError("a shared cache lock must not be entered concurrently")
