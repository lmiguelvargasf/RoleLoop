from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from pathlib import Path, PurePosixPath

from roleloop.application.errors import ArtifactError
from roleloop.application.ports import IdGenerator
from roleloop.domain import ArtifactRef

from .runtime import UUID4Generator

_SAFE_COMPONENT = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
_SAFE_SUFFIX = re.compile(r"^(?:\.[a-zA-Z0-9]+)?$")


class ArtifactStoreError(ArtifactError):
    pass


class ArtifactNotFoundError(ArtifactStoreError):
    pass


class ArtifactCollisionError(ArtifactStoreError):
    pass


class FileSystemArtifactStore:
    """Immutable, app-managed artifact storage rooted below a single directory."""

    def __init__(self, root: Path, *, id_generator: IdGenerator | None = None) -> None:
        self.root = root.resolve(strict=False)
        self.root.mkdir(parents=True, exist_ok=True)
        self._ids = id_generator or UUID4Generator()

    async def put_bytes(
        self,
        data: bytes,
        *,
        media_type: str,
        extension: str,
    ) -> ArtifactRef:
        identifier = self._ids.new()
        return await asyncio.to_thread(
            self._put_bytes_sync,
            data,
            identifier=identifier,
            media_type=media_type,
            extension=extension,
        )

    def _put_bytes_sync(
        self,
        data: bytes,
        *,
        identifier: str,
        media_type: str,
        extension: str,
    ) -> ArtifactRef:
        if not _SAFE_SUFFIX.fullmatch(extension):
            raise ArtifactStoreError(f"Unsafe artifact extension: {extension!r}")
        digest = hashlib.sha256(data).hexdigest()
        key = str(PurePosixPath("sha256") / digest[:2] / digest)
        size = self._store_content(data, key=key, digest=digest)
        return ArtifactRef(
            id=identifier,
            checksum=digest,
            uri=key,
            media_type=media_type,
            size_bytes=size,
        )

    def _store_content(
        self,
        data: bytes,
        *,
        key: str,
        digest: str,
    ) -> int:
        destination = self._path_for_key(key)
        destination.parent.mkdir(parents=True, exist_ok=True)

        if destination.exists():
            existing = destination.read_bytes()
            self._verify_existing(existing, data=data, digest=digest, key=key)
            return len(existing)

        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=destination.parent,
                prefix=f".{digest}-",
                suffix=".tmp",
                delete=False,
            ) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
                temporary_path = Path(stream.name)
            try:
                os.link(temporary_path, destination)
            except FileExistsError:
                existing = destination.read_bytes()
                self._verify_existing(existing, data=data, digest=digest, key=key)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()

        return len(data)

    @staticmethod
    def _verify_existing(
        existing: bytes,
        *,
        data: bytes,
        digest: str,
        key: str,
    ) -> None:
        if hashlib.sha256(existing).hexdigest() != digest or existing != data:
            raise ArtifactCollisionError(f"Content-addressed artifact collision at: {key}")

    def read_bytes(self, key: str) -> bytes:
        path = self._path_for_key(key)
        try:
            return path.read_bytes()
        except FileNotFoundError as error:
            raise ArtifactNotFoundError(f"Artifact does not exist: {key}") from error

    def path_for(self, key: str) -> Path:
        path = self._path_for_key(key)
        if not path.is_file():
            raise ArtifactNotFoundError(f"Artifact does not exist: {key}")
        return path

    def exists(self, key: str) -> bool:
        return self._path_for_key(key).is_file()

    def _path_for_key(self, key: str) -> Path:
        relative = PurePosixPath(key)
        if relative.is_absolute() or not relative.parts or ".." in relative.parts:
            raise ValueError(f"Unsafe artifact key: {key!r}")
        if any(
            not _SAFE_COMPONENT.fullmatch(part.split(".", maxsplit=1)[0]) for part in relative.parts
        ):
            raise ValueError(f"Unsafe artifact key: {key!r}")
        path = (self.root / Path(*relative.parts)).resolve(strict=False)
        if not path.is_relative_to(self.root):
            raise ValueError(f"Artifact key escapes storage root: {key!r}")
        return path
