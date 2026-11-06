from __future__ import annotations

import subprocess
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

from roleloop.application.errors import ArtifactError
from roleloop.infrastructure.pdf import PdfDocumentValidator, StrictPdfInspector


def _text_pdf(text: str, *, pages: int = 1) -> bytes:
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    for _ in range(pages):
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
        )
        stream = StreamObject()
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.mark.asyncio
async def test_pdf_validator_checks_structure_pages_and_required_headings() -> None:
    data = _text_pdf("SUMMARY SKILLS PROFESSIONAL EXPERIENCE")

    report = await PdfDocumentValidator(require_poppler=False).validate(
        data,
        maximum_pages=2,
    )

    assert report.page_count == 1
    assert report.media_type == "application/pdf"
    assert len(report.checksum) == 64
    assert "PROFESSIONAL EXPERIENCE" in report.extracted_text


def test_pdf_validator_rejects_corrupt_overlong_and_incomplete_documents() -> None:
    validator = PdfDocumentValidator(require_poppler=False)
    with pytest.raises(ArtifactError, match="not a PDF"):
        validator.validate_sync(b"not-pdf", maximum_pages=2)
    with pytest.raises(ArtifactError, match="2 pages"):
        validator.validate_sync(
            _text_pdf("SUMMARY SKILLS PROFESSIONAL EXPERIENCE", pages=2),
            maximum_pages=1,
        )
    with pytest.raises(ArtifactError, match="headings"):
        validator.validate_sync(_text_pdf("SUMMARY only"), maximum_pages=2)


def test_strict_pdf_inspector_exposes_independently_extracted_text() -> None:
    inspection = StrictPdfInspector(validator=PdfDocumentValidator(require_poppler=False)).inspect(
        _text_pdf("SUMMARY SKILLS PROFESSIONAL EXPERIENCE")
    )

    assert inspection.valid
    assert "PROFESSIONAL EXPERIENCE" in inspection.extracted_text


def test_pdf_validator_runs_poppler_with_a_sanitized_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[list[str]] = []
    environments: list[dict[str, str]] = []

    def fake_run(
        command: list[str],
        **kwargs: object,
    ) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        environment = kwargs["env"]
        assert isinstance(environment, dict)
        environments.append(environment)
        if command[0] == "pdfinfo":
            return subprocess.CompletedProcess(command, 0, stdout=b"Pages: 1\n", stderr=b"")
        Path(command[-1]).write_text(
            "SUMMARY\nSKILLS\nPROFESSIONAL EXPERIENCE\n",
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")

    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-poppler")
    monkeypatch.setattr("roleloop.infrastructure.pdf.subprocess.run", fake_run)

    report = PdfDocumentValidator().validate_sync(
        _text_pdf("SUMMARY SKILLS PROFESSIONAL EXPERIENCE"),
        maximum_pages=2,
    )

    assert report.page_count == 1
    assert len(environments) == 2
    assert commands[1][1:4] == ["-layout", "-enc", "UTF-8"]
    assert all("OPENAI_API_KEY" not in environment for environment in environments)
    assert all(environment["GIT_TERMINAL_PROMPT"] == "0" for environment in environments)


def test_pdf_validator_preserves_layout_mode_ats_reading_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract_layout_text = (
        "SUMMARY\n"
        "SKILLS\n"
        "PROFESSIONAL EXPERIENCE\n"
        "LEFT ALPHA       RIGHT BETA\n"
        "LEFT GAMMA       RIGHT DELTA\n"
    )
    plain_reading_text = (
        "SUMMARY\n"
        "SKILLS\n"
        "PROFESSIONAL EXPERIENCE\n"
        "LEFT ALPHA\n"
        "LEFT GAMMA\n"
        "RIGHT BETA\n"
        "RIGHT DELTA\n"
    )

    def fake_run(
        command: list[str],
        **_: object,
    ) -> subprocess.CompletedProcess[bytes]:
        if command[0] == "pdfinfo":
            return subprocess.CompletedProcess(command, 0, stdout=b"Pages: 1\n", stderr=b"")
        extracted = contract_layout_text if "-layout" in command else plain_reading_text
        Path(command[-1]).write_text(extracted, encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr("roleloop.infrastructure.pdf.subprocess.run", fake_run)

    report = PdfDocumentValidator().validate_sync(
        _text_pdf("SUMMARY SKILLS PROFESSIONAL EXPERIENCE"),
        maximum_pages=2,
    )

    normalized = " ".join(report.extracted_text.split())
    assert normalized == " ".join(contract_layout_text.split())
    assert normalized != " ".join(plain_reading_text.split())


def test_pdf_inspector_implements_non_throwing_application_port() -> None:
    inspector = StrictPdfInspector(
        maximum_pages=2,
        validator=PdfDocumentValidator(require_poppler=False),
    )

    accepted = inspector.inspect(_text_pdf("SUMMARY SKILLS PROFESSIONAL EXPERIENCE"))
    rejected = inspector.inspect(b"not a pdf")

    assert accepted.valid
    assert accepted.page_count == 1
    assert not rejected.valid
    assert rejected.media_type == "application/octet-stream"
    assert rejected.errors
