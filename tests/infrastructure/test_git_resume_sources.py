from __future__ import annotations

import hashlib
import subprocess
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
    monkeypatch.delenv("GIT_SSH_COMMAND", raising=False)
    captured: dict[str, object] = {}

    def fake_run(arguments: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        captured["arguments"] = arguments
        captured.update(kwargs)
        return subprocess.CompletedProcess(arguments, 0, stdout=b"git version 2.0\n", stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)
    synchronizer = GitResumeSourceSynchronizer(tmp_path / "cache")
    synchronizer._run_git(["--version"], error_message="Git could not run")

    environment = captured["env"]
    assert isinstance(environment, dict)
    assert captured["stdin"] is subprocess.DEVNULL
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert environment["GIT_SSH_COMMAND"] == "ssh -oBatchMode=yes"

    monkeypatch.setenv("GIT_SSH_COMMAND", "custom-ssh --identity configured-key")
    synchronizer._run_git(["--version"], error_message="Git could not run")
    configured_environment = captured["env"]
    assert isinstance(configured_environment, dict)
    assert configured_environment["GIT_SSH_COMMAND"] == "custom-ssh --identity configured-key"


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
