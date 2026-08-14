from __future__ import annotations

import json
import os

import pytest

from roleloop.application import ConcurrentInstanceError
from roleloop.infrastructure.process_lock import RoleLoopProcessLock


def test_process_lock_is_exclusive_reports_owner_and_can_be_reacquired(tmp_path) -> None:
    lock_path = tmp_path / ".roleloop.lock"
    database_path = tmp_path / "roleloop.sqlite3"
    first = RoleLoopProcessLock.acquire(lock_path, database_path=database_path)

    metadata = json.loads(lock_path.read_text(encoding="utf-8"))
    assert metadata["pid"] == os.getpid()
    assert metadata["database_path"] == str(database_path)
    assert first.is_held is True

    with pytest.raises(ConcurrentInstanceError) as caught:
        RoleLoopProcessLock.acquire(lock_path, database_path=database_path)
    assert caught.value.code == "concurrent_instance"
    assert caught.value.details == {
        "lock_path": str(lock_path),
        "owner_pid": os.getpid(),
        "reason": "already_locked",
    }
    assert f"owner PID {os.getpid()}" in caught.value.message

    first.close()
    first.close()
    assert first.is_held is False
    with RoleLoopProcessLock.acquire(lock_path, database_path=database_path) as replacement:
        assert replacement.is_held is True
    assert replacement.is_held is False


def test_stale_metadata_does_not_block_a_new_process_owner(tmp_path) -> None:
    lock_path = tmp_path / ".roleloop.lock"
    lock_path.write_text('{"pid":999999}', encoding="utf-8")

    with RoleLoopProcessLock.acquire(
        lock_path,
        database_path=tmp_path / "roleloop.sqlite3",
    ) as process_lock:
        assert process_lock.is_held is True
        assert json.loads(lock_path.read_text(encoding="utf-8"))["pid"] == os.getpid()


def test_symlink_lock_is_rejected_without_touching_its_target(tmp_path) -> None:
    sentinel = tmp_path / "sentinel"
    sentinel.write_bytes(b"do-not-touch")
    sentinel.chmod(0o640)
    original_mode = sentinel.stat().st_mode
    lock_path = tmp_path / ".roleloop.lock"
    lock_path.symlink_to(sentinel)

    with pytest.raises(ConcurrentInstanceError) as caught:
        RoleLoopProcessLock.acquire(
            lock_path,
            database_path=tmp_path / "roleloop.sqlite3",
        )

    assert caught.value.details["reason"] == "unsafe_lock_path"
    assert lock_path.is_symlink()
    assert sentinel.read_bytes() == b"do-not-touch"
    assert sentinel.stat().st_mode == original_mode
