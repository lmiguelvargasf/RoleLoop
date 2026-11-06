"""Process-lifetime ownership for RoleLoop's authoritative local state."""

from __future__ import annotations

import errno
import fcntl
import json
import os
import stat
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Self

from roleloop.application import ConcurrentInstanceError, RoleLoopService

_OWNER_METADATA_LIMIT = 4 * 1024


class RoleLoopProcessLock:
    """Exclusive, non-blocking advisory lock retained for a process lifetime.

    The lock file is intentionally persistent. Unlinking a held advisory-lock
    file permits another process to lock a different inode at the same path.
    The operating system releases the lock automatically after a crash.
    """

    def __init__(self, path: Path, descriptor: int) -> None:
        self.path = path
        self._descriptor: int | None = descriptor

    @classmethod
    def acquire(cls, path: Path, *, database_path: Path) -> Self:
        """Acquire exclusive ownership or fail immediately with a typed error."""

        # Canonicalize only the parent. Resolving the leaf would follow an
        # attacker-controlled symlink before O_NOFOLLOW can protect the open.
        resolved_parent = path.parent.resolve(strict=False)
        resolved_parent.mkdir(parents=True, exist_ok=True)
        lock_path = resolved_parent / path.name
        try:
            existing = lock_path.lstat()
        except FileNotFoundError:
            existing = None
        except OSError as exc:
            raise ConcurrentInstanceError(
                "RoleLoop could not inspect its local process-lock path.",
                details={"lock_path": str(lock_path), "reason": "inspect_failed"},
            ) from exc
        if existing is not None and (not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1):
            raise ConcurrentInstanceError(
                "RoleLoop's process-lock path is not a safe regular file.",
                details={"lock_path": str(lock_path), "reason": "unsafe_lock_path"},
            )
        flags = os.O_RDWR | os.O_CREAT
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise ConcurrentInstanceError(
                "RoleLoop could not secure its local data directory; check lock-file permissions.",
                details={"lock_path": str(lock_path), "reason": "open_failed"},
            ) from exc

        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise ConcurrentInstanceError(
                    "RoleLoop's process-lock path is not a regular file.",
                    details={"lock_path": str(lock_path), "reason": "unsafe_lock_path"},
                )
            if existing is not None and (opened.st_dev, opened.st_ino) != (
                existing.st_dev,
                existing.st_ino,
            ):
                raise ConcurrentInstanceError(
                    "RoleLoop's process-lock path changed while it was being secured.",
                    details={"lock_path": str(lock_path), "reason": "lock_path_changed"},
                )
            os.fchmod(descriptor, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN}:
                    raise ConcurrentInstanceError(
                        "RoleLoop could not acquire its local process lock.",
                        details={"lock_path": str(lock_path), "reason": "lock_failed"},
                    ) from exc
                owner_pid = _owner_pid(descriptor)
                owner = f" (owner PID {owner_pid})" if owner_pid is not None else ""
                raise ConcurrentInstanceError(
                    "Another RoleLoop process is already using this data directory"
                    f"{owner}. Close it or wait for it to finish, then retry.",
                    details={
                        "lock_path": str(lock_path),
                        "owner_pid": owner_pid,
                        "reason": "already_locked",
                    },
                ) from exc

            metadata = json.dumps(
                {
                    "database_path": str(database_path.resolve(strict=False)),
                    "locked_at": datetime.now(UTC).isoformat(),
                    "pid": os.getpid(),
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            os.ftruncate(descriptor, 0)
            os.lseek(descriptor, 0, os.SEEK_SET)
            _write_all(descriptor, metadata)
            os.fsync(descriptor)
            return cls(lock_path, descriptor)
        except BaseException:
            os.close(descriptor)
            raise

    @property
    def is_held(self) -> bool:
        return self._descriptor is not None

    def close(self) -> None:
        """Release ownership. Calling close more than once is safe."""

        descriptor = self._descriptor
        if descriptor is None:
            return
        self._descriptor = None
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback
        self.close()

    def __del__(self) -> None:
        with suppress(BaseException):
            self.close()


class ManagedRoleLoopService(RoleLoopService):
    """A composed service that owns the process lock for its whole lifetime."""

    _process_lock: RoleLoopProcessLock | None = None

    def attach_process_lock(self, process_lock: RoleLoopProcessLock) -> None:
        if self._process_lock is not None:
            raise RuntimeError("RoleLoop service already owns a process lock")
        self._process_lock = process_lock

    def close(self) -> None:
        """Release process ownership after all service work has stopped."""

        process_lock = self._process_lock
        self._process_lock = None
        if process_lock is not None:
            process_lock.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback
        self.close()

    def __del__(self) -> None:
        with suppress(BaseException):
            self.close()


def _owner_pid(descriptor: int) -> int | None:
    try:
        payload = os.pread(descriptor, _OWNER_METADATA_LIMIT, 0)
        metadata = json.loads(payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(metadata, dict):
        return None
    pid = metadata.get("pid")
    return pid if isinstance(pid, int) and pid > 0 else None


def _write_all(descriptor: int, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("could not write process-lock metadata")
        remaining = remaining[written:]


__all__ = ["ManagedRoleLoopService", "RoleLoopProcessLock"]
