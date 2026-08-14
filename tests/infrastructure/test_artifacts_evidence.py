from __future__ import annotations

import hashlib
import threading
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

from roleloop.application.dto import EvidenceImport
from roleloop.application.errors import ArtifactError, ValidationError
from roleloop.domain import EvidenceSourceKind
from roleloop.infrastructure import FileSystemArtifactStore, LocalEvidenceExtractor
from roleloop.infrastructure.artifacts import ArtifactCollisionError, FileSystemArtifactAccess


class FixedIds:
    def __init__(self, identifier: str = "artifact-1") -> None:
        self.identifier = identifier

    def new(self) -> str:
        return self.identifier


class SequentialIds:
    def __init__(self) -> None:
        self._next = 0

    def new(self) -> str:
        self._next += 1
        return f"artifact-{self._next}"


class RecordingArtifactStore(FileSystemArtifactStore):
    worker_thread_id: int | None = None

    def _put_bytes_sync(self, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        self.worker_thread_id = threading.get_ident()
        return super()._put_bytes_sync(*args, **kwargs)  # type: ignore[arg-type]


class RecordingEvidenceExtractor(LocalEvidenceExtractor):
    worker_thread_id: int | None = None

    def _extract_sync(self, request: EvidenceImport):  # type: ignore[no-untyped-def]
        self.worker_thread_id = threading.get_ident()
        return super()._extract_sync(request)


@pytest.mark.asyncio
async def test_artifact_store_writes_immutable_content_below_root(tmp_path: Path) -> None:
    store = FileSystemArtifactStore(tmp_path, id_generator=SequentialIds())

    ref = await store.put_bytes(
        b"resume",
        media_type="application/pdf",
        extension=".pdf",
    )

    digest = hashlib.sha256(b"resume").hexdigest()
    assert ref.id == "artifact-1"
    assert ref.uri == f"sha256/{digest[:2]}/{digest}"
    assert ref.checksum == digest
    assert ref.size_bytes == 6
    assert store.read_bytes(ref.uri) == b"resume"
    assert store.path_for(ref.uri).is_relative_to(tmp_path)

    duplicate = await store.put_bytes(
        b"resume",
        media_type="application/pdf",
        extension=".pdf",
    )
    assert duplicate.id == "artifact-2"
    assert duplicate.uri == ref.uri
    assert duplicate.checksum == ref.checksum
    assert len([path for path in tmp_path.rglob("*") if path.is_file()]) == 1

    store.path_for(ref.uri).write_bytes(b"corrupt")
    with pytest.raises(ArtifactCollisionError):
        await store.put_bytes(
            b"resume",
            media_type="application/pdf",
            extension=".pdf",
        )


@pytest.mark.asyncio
async def test_artifact_store_rejects_unsafe_extensions_and_keys(tmp_path: Path) -> None:
    store = FileSystemArtifactStore(tmp_path, id_generator=FixedIds())

    with pytest.raises(ArtifactError):
        await store.put_bytes(b"data", media_type="text/plain", extension="../escape")
    with pytest.raises(ValueError, match="Unsafe artifact key"):
        store.read_bytes("../escape")


@pytest.mark.asyncio
async def test_artifact_access_verifies_reads_and_exports_without_overwriting(
    tmp_path: Path,
) -> None:
    root = tmp_path / "artifacts"
    store = FileSystemArtifactStore(root, id_generator=FixedIds())
    artifact = await store.put_bytes(b"pdf-data", media_type="application/pdf", extension=".pdf")
    access = FileSystemArtifactAccess(root)

    assert await access.read_bytes(artifact) == b"pdf-data"
    destination = tmp_path / "exports" / "resume.pdf"
    assert await access.export(artifact, destination) == destination
    assert destination.read_bytes() == b"pdf-data"
    assert await access.export(artifact, destination) == destination

    destination.write_bytes(b"other")
    with pytest.raises(ArtifactError, match="already exists"):
        await access.export(artifact, destination)


@pytest.mark.asyncio
async def test_artifact_access_rejects_tampered_managed_content(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = FileSystemArtifactStore(root, id_generator=FixedIds())
    artifact = await store.put_bytes(b"original", media_type="text/plain", extension=".txt")
    store.path_for(artifact.uri).write_bytes(b"tampered")

    with pytest.raises(ArtifactError, match="immutable reference"):
        await FileSystemArtifactAccess(root).read_bytes(artifact)


@pytest.mark.asyncio
async def test_evidence_extractor_supports_pasted_and_text_file_sources(
    tmp_path: Path,
) -> None:
    extractor = LocalEvidenceExtractor()
    pasted = await extractor.extract(
        EvidenceImport(
            source_kind=EvidenceSourceKind.PASTED_TEXT,
            text="Skills  \r\nPython\x00\n",
            source_name="resume.txt",
        )
    )
    assert pasted.extracted_text == "Skills\nPython"
    assert pasted.source_bytes == b"Skills  \r\nPython\x00\n"
    assert pasted.extension == ".txt"

    source = tmp_path / "resume.md"
    source.write_text("# Experience\n\nBuilt RoleLoop", encoding="utf-8")
    extracted_file = await extractor.extract(
        EvidenceImport(source_kind=EvidenceSourceKind.TEXT_FILE, path=source)
    )
    assert extracted_file.source_name == "resume.md"
    assert extracted_file.extracted_text.endswith("Built RoleLoop")
    assert extracted_file.extension == ".md"


@pytest.mark.asyncio
async def test_evidence_extractor_reads_pdf_text(tmp_path: Path) -> None:
    source = tmp_path / "resume.pdf"
    source.write_bytes(_text_pdf("RoleLoop evidence"))

    extracted = await LocalEvidenceExtractor().extract(
        EvidenceImport(source_kind=EvidenceSourceKind.PDF, path=source)
    )

    assert "RoleLoop evidence" in extracted.extracted_text
    assert extracted.media_type == "application/pdf"
    assert extracted.extension == ".pdf"


@pytest.mark.asyncio
async def test_evidence_extractor_rejects_missing_and_image_only_sources(
    tmp_path: Path,
) -> None:
    extractor = LocalEvidenceExtractor()
    with pytest.raises(ValidationError, match="requires a path"):
        await extractor.extract(EvidenceImport(source_kind=EvidenceSourceKind.PDF))

    image_only = tmp_path / "image-only.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with image_only.open("wb") as stream:
        writer.write(stream)
    with pytest.raises(ValidationError, match="no extractable text"):
        await extractor.extract(EvidenceImport(source_kind=EvidenceSourceKind.PDF, path=image_only))


@pytest.mark.asyncio
async def test_blocking_artifact_and_evidence_work_runs_off_event_loop(
    tmp_path: Path,
) -> None:
    event_loop_thread = threading.get_ident()
    store = RecordingArtifactStore(tmp_path, id_generator=FixedIds())
    extractor = RecordingEvidenceExtractor()

    await store.put_bytes(b"resume", media_type="text/plain", extension=".txt")
    await extractor.extract(
        EvidenceImport(source_kind=EvidenceSourceKind.PASTED_TEXT, text="resume")
    )

    assert store.worker_thread_id is not None
    assert extractor.worker_thread_id is not None
    assert store.worker_thread_id != event_loop_thread
    assert extractor.worker_thread_id != event_loop_thread


def _text_pdf(text: str) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    stream = StreamObject()
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
