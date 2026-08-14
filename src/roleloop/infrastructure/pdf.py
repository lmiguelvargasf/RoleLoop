"""Strict structural and ATS-text validation for generated résumé PDFs."""

from __future__ import annotations

import asyncio
import hashlib
import re
import subprocess
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from roleloop.application.dto import PdfInspection
from roleloop.application.errors import ArtifactError, ProviderUnavailableError

from .runtime import sanitized_subprocess_environment

_DEFAULT_REQUIRED_HEADINGS = ("SUMMARY", "SKILLS", "PROFESSIONAL EXPERIENCE")
_MAX_PDF_BYTES = 20 * 1024 * 1024


class PdfValidationError(ArtifactError):
    code = "pdf_validation_error"


@dataclass(frozen=True, slots=True)
class PdfValidationReport:
    checksum: str
    page_count: int
    extracted_text: str
    media_type: str = "application/pdf"


class PdfDocumentValidator:
    """Validate both PDF structure and the text an ATS-oriented tool sees."""

    def __init__(
        self,
        *,
        pdfinfo_executable: str = "pdfinfo",
        pdftotext_executable: str = "pdftotext",
        command_timeout_seconds: float = 30.0,
        require_poppler: bool = True,
        maximum_pdf_bytes: int = _MAX_PDF_BYTES,
    ) -> None:
        if command_timeout_seconds <= 0:
            raise ValueError("PDF command timeout must be greater than zero")
        if maximum_pdf_bytes <= 0:
            raise ValueError("maximum_pdf_bytes must be greater than zero")
        if not pdfinfo_executable or not pdftotext_executable:
            raise ValueError("Poppler executable names must not be empty")
        self._pdfinfo = pdfinfo_executable
        self._pdftotext = pdftotext_executable
        self._timeout = command_timeout_seconds
        self._require_poppler = require_poppler
        self._maximum_pdf_bytes = maximum_pdf_bytes

    async def validate(
        self,
        data: bytes,
        *,
        maximum_pages: int,
        required_headings: tuple[str, ...] = _DEFAULT_REQUIRED_HEADINGS,
    ) -> PdfValidationReport:
        return await asyncio.to_thread(
            self.validate_sync,
            data,
            maximum_pages=maximum_pages,
            required_headings=required_headings,
        )

    def validate_sync(
        self,
        data: bytes,
        *,
        maximum_pages: int,
        required_headings: tuple[str, ...] = _DEFAULT_REQUIRED_HEADINGS,
    ) -> PdfValidationReport:
        if maximum_pages <= 0:
            raise ValueError("maximum_pages must be greater than zero")
        if not data.startswith(b"%PDF-"):
            raise PdfValidationError("Generated artifact is not a PDF document")
        if len(data) > self._maximum_pdf_bytes:
            raise PdfValidationError(
                "Generated PDF exceeds the configured size limit",
                details={"maximum_bytes": self._maximum_pdf_bytes},
            )

        page_count, library_text = self._read_with_pypdf(data)
        if page_count < 1:
            raise PdfValidationError("Generated PDF contains no pages")
        if page_count > maximum_pages:
            raise PdfValidationError(
                f"Generated PDF has {page_count} pages; limit is {maximum_pages}",
                details={"page_count": page_count, "maximum_pages": maximum_pages},
            )

        poppler_result = self._read_with_poppler(data) if self._require_poppler else None
        if poppler_result is None:
            extracted_text = library_text
        else:
            poppler_pages, extracted_text = poppler_result
            if poppler_pages != page_count:
                raise PdfValidationError(
                    "PDF readers disagree about the generated page count",
                    details={"pypdf_pages": page_count, "pdfinfo_pages": poppler_pages},
                )

        normalized_text = " ".join(extracted_text.upper().split())
        if not normalized_text:
            raise PdfValidationError("Generated PDF contains no extractable text")
        missing = [
            heading for heading in required_headings if heading.upper() not in normalized_text
        ]
        if missing:
            raise PdfValidationError(
                "Generated PDF is missing required ATS headings",
                details={"missing_headings": tuple(missing)},
            )
        return PdfValidationReport(
            checksum=hashlib.sha256(data).hexdigest(),
            page_count=page_count,
            extracted_text=extracted_text,
        )

    @staticmethod
    def _read_with_pypdf(data: bytes) -> tuple[int, str]:
        try:
            reader = PdfReader(BytesIO(data), strict=True)
            if reader.is_encrypted:
                raise PdfValidationError("Generated PDF must not be encrypted")
            pages = list(reader.pages)
            text = "\n".join((page.extract_text() or "").strip() for page in pages).strip()
            return len(pages), text
        except PdfValidationError:
            raise
        except (PdfReadError, OSError, TypeError, ValueError) as error:
            raise PdfValidationError("Generated PDF could not be parsed") from error

    def _read_with_poppler(self, data: bytes) -> tuple[int, str]:
        with tempfile.TemporaryDirectory(prefix="roleloop-pdf-validation-") as directory:
            root = Path(directory).resolve(strict=True)
            source = root / "resume.pdf"
            text_path = root / "resume.txt"
            source.write_bytes(data)
            environment = sanitized_subprocess_environment(root)
            info = self._run(
                [self._pdfinfo, str(source)],
                environment=environment,
                capability="pdfinfo",
            )
            match = re.search(rb"^Pages:\s+(\d+)\s*$", info.stdout, flags=re.MULTILINE)
            if match is None:
                raise PdfValidationError("pdfinfo did not report a page count")
            # Contract v1 defines ATS text with Poppler's layout-preserving mode.
            # Re-run that mode independently so the PDF remains authoritative while
            # exact comparison can still detect a forged or stale contract artifact.
            self._run(
                [
                    self._pdftotext,
                    "-layout",
                    "-enc",
                    "UTF-8",
                    str(source),
                    str(text_path),
                ],
                environment=environment,
                capability="pdftotext",
            )
            try:
                text = text_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as error:
                raise PdfValidationError("pdftotext did not produce valid UTF-8 text") from error
            return int(match.group(1)), text.strip()

    def _run(
        self,
        command: list[str],
        *,
        environment: dict[str, str],
        capability: str,
    ) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(
                command,
                check=True,
                capture_output=True,
                env=environment,
                shell=False,
                stdin=subprocess.DEVNULL,
                timeout=self._timeout,
            )
        except FileNotFoundError as error:
            raise ProviderUnavailableError(
                f"{capability} is required to validate generated PDFs",
                details={"capability": capability},
            ) from error
        except subprocess.TimeoutExpired as error:
            raise PdfValidationError(
                f"{capability} timed out while validating the generated PDF",
                details={"capability": capability, "timeout_seconds": self._timeout},
            ) from error
        except subprocess.CalledProcessError as error:
            raise PdfValidationError(
                f"{capability} rejected the generated PDF",
                details={"capability": capability, "exit_code": error.returncode},
            ) from error
        except OSError as error:
            raise PdfValidationError(
                f"{capability} could not validate the generated PDF"
            ) from error


class StrictPdfInspector:
    """Application-port adapter returning a non-throwing inspection result."""

    def __init__(
        self,
        *,
        maximum_pages: int = 2,
        required_headings: tuple[str, ...] = _DEFAULT_REQUIRED_HEADINGS,
        validator: PdfDocumentValidator | None = None,
    ) -> None:
        if maximum_pages <= 0:
            raise ValueError("maximum_pages must be greater than zero")
        self._maximum_pages = maximum_pages
        self._required_headings = required_headings
        self._validator = validator or PdfDocumentValidator()

    def inspect(self, data: bytes) -> PdfInspection:
        media_type = "application/pdf" if data.startswith(b"%PDF-") else "application/octet-stream"
        try:
            report = self._validator.validate_sync(
                data,
                maximum_pages=self._maximum_pages,
                required_headings=self._required_headings,
            )
        except (ArtifactError, ProviderUnavailableError) as error:
            return PdfInspection(
                valid=False,
                page_count=0,
                media_type=media_type,
                errors=(error.message,),
            )
        return PdfInspection(
            valid=True,
            page_count=report.page_count,
            media_type=report.media_type,
            extracted_text=report.extracted_text,
        )
