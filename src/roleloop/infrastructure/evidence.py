from __future__ import annotations

import asyncio
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from roleloop.application.dto import EvidenceImport, ExtractedEvidence
from roleloop.application.errors import ValidationError
from roleloop.domain import EvidenceSourceKind

PDF_MEDIA_TYPE = "application/pdf"
PLAIN_TEXT_MEDIA_TYPES = frozenset({"text/plain", "text/markdown"})


class EvidenceExtractionError(ValidationError):
    pass


@dataclass(frozen=True, slots=True)
class ExtractedText:
    text: str
    media_type: str
    page_count: int | None = None


class LocalEvidenceExtractor:
    """Deterministic extraction for managed PDF and plain-text evidence."""

    async def extract(self, request: EvidenceImport) -> ExtractedEvidence:
        return await asyncio.to_thread(self._extract_sync, request)

    def _extract_sync(self, request: EvidenceImport) -> ExtractedEvidence:
        if request.source_kind is EvidenceSourceKind.PASTED_TEXT:
            if request.text is None:
                raise EvidenceExtractionError("Pasted evidence requires text")
            source_name = request.source_name or "pasted-resume.txt"
            source_bytes = request.text.encode("utf-8")
            extracted = self.extract_bytes(source_bytes, "text/plain")
            return ExtractedEvidence(
                source_kind=request.source_kind,
                source_name=source_name,
                source_bytes=source_bytes,
                extracted_text=extracted.text,
                media_type=extracted.media_type,
                extension=".txt",
            )

        path = _required_file(request.path)
        source_bytes = _read_source(path)
        if request.source_kind is EvidenceSourceKind.PDF:
            extracted = self.extract_bytes(source_bytes, PDF_MEDIA_TYPE)
            extension = ".pdf"
        elif request.source_kind is EvidenceSourceKind.TEXT_FILE:
            extracted = self.extract_bytes(source_bytes, "text/plain")
            extension = path.suffix.lower() if path.suffix.lower() in {".txt", ".md"} else ".txt"
        else:  # pragma: no cover - enum exhaustiveness guard
            raise EvidenceExtractionError(
                f"Unsupported evidence source kind: {request.source_kind}"
            )
        return ExtractedEvidence(
            source_kind=request.source_kind,
            source_name=request.source_name or path.name,
            source_bytes=source_bytes,
            extracted_text=extracted.text,
            media_type=extracted.media_type,
            extension=extension,
        )

    def extract_bytes(self, content: bytes, media_type: str) -> ExtractedText:
        normalized_media_type = media_type.partition(";")[0].strip().lower()
        if normalized_media_type == PDF_MEDIA_TYPE:
            return self._extract_pdf(content)
        if normalized_media_type in PLAIN_TEXT_MEDIA_TYPES:
            return self._extract_plain_text(content, normalized_media_type)
        raise EvidenceExtractionError(f"Unsupported evidence media type: {media_type}")

    def _extract_plain_text(self, content: bytes, media_type: str) -> ExtractedText:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise EvidenceExtractionError("Plain-text evidence must be UTF-8 encoded") from error
        return ExtractedText(text=_normalize_text(text), media_type=media_type)

    def _extract_pdf(self, content: bytes) -> ExtractedText:
        try:
            reader = PdfReader(BytesIO(content))
            if reader.is_encrypted and not reader.decrypt(""):
                raise EvidenceExtractionError("Encrypted PDF evidence requires a password")
            pages = [page.extract_text() or "" for page in reader.pages]
        except EvidenceExtractionError:
            raise
        except (PdfReadError, OSError, ValueError) as error:
            raise EvidenceExtractionError("PDF evidence could not be read") from error

        text = _normalize_text("\n\n".join(pages))
        if not text:
            raise EvidenceExtractionError(
                "PDF evidence contains no extractable text; scanned PDFs require OCR"
            )
        return ExtractedText(text=text, media_type=PDF_MEDIA_TYPE, page_count=len(reader.pages))


def _normalize_text(value: str) -> str:
    lines = [line.rstrip() for line in value.replace("\x00", "").splitlines()]
    return "\n".join(lines).strip()


def _required_file(path: Path | None) -> Path:
    if path is None:
        raise EvidenceExtractionError("File evidence requires a path")
    if not path.is_file():
        raise EvidenceExtractionError(f"Evidence file does not exist: {path}")
    return path


def _read_source(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise EvidenceExtractionError(f"Evidence file could not be read: {path}") from error
