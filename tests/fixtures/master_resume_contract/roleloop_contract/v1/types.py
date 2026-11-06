"""Standard-library-only JSON boundary types for contract v1.

The bridge is executed from an immutable Git snapshot and must not depend on a
virtual environment. Parsing is deliberately strict: required fields must be
present and unknown fields are rejected.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

CONTRACT_NAME = "roleloop.master-resume"
CONTRACT_VERSION = 1
BRIDGE_VERSION = "1.0.0"
EVIDENCE_SCHEMA_VERSION = 1
SELECTION_SCHEMA_VERSION = 1
RENDER_RESULT_SCHEMA_VERSION = 1
RENDERER_NAME = "master-resume-latex"
RENDERER_VERSION = "1.0.0"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_GIT_OID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_QUANTITATIVE_HEADLINE = re.compile(
    r"\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|"
    r"twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|"
    r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|"
    r"million|billion|percent|percentage|years?)\b",
    re.IGNORECASE,
)


class TypeValidationError(ValueError):
    pass


def _object(
    value: Any,
    *,
    name: str,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise TypeValidationError(f"{name} must be a JSON object")
    optional = optional or set()
    missing = required - set(value)
    unknown = set(value) - required - optional
    if missing:
        raise TypeValidationError(f"{name} is missing fields: {sorted(missing)}")
    if unknown:
        raise TypeValidationError(f"{name} has unknown fields: {sorted(unknown)}")
    return value


def _string(value: Any, *, name: str, maximum: int = 10_000) -> str:
    if not isinstance(value, str):
        raise TypeValidationError(f"{name} must be a string")
    normalized = value.strip()
    if not normalized:
        raise TypeValidationError(f"{name} cannot be blank")
    if len(normalized) > maximum:
        raise TypeValidationError(f"{name} exceeds {maximum} characters")
    if any(ord(character) < 32 for character in normalized):
        raise TypeValidationError(f"{name} contains a control character")
    return normalized


def _string_list(value: Any, *, name: str, maximum: int) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise TypeValidationError(f"{name} must be an array")
    if len(value) > maximum:
        raise TypeValidationError(f"{name} has more than {maximum} entries")
    result = tuple(_string(item, name=f"{name} item", maximum=200) for item in value)
    if len(result) != len(set(result)):
        raise TypeValidationError(f"{name} cannot contain duplicates")
    return result


def validate_source_revision(value: Any) -> str:
    revision = _string(value, name="source_revision", maximum=64).lower()
    if not _GIT_OID.fullmatch(revision):
        raise TypeValidationError(
            "source_revision must be a full 40- or 64-digit Git OID"
        )
    return revision


def validate_sha256(value: Any, *, name: str) -> str:
    checksum = _string(value, name=name, maximum=64).lower()
    if not _SHA256.fullmatch(checksum):
        raise TypeValidationError(f"{name} must be a lowercase SHA-256 digest")
    return checksum


@dataclass(frozen=True, slots=True)
class SummaryEvidenceV1:
    id: str
    text: str
    source_path: str
    source_sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_path": self.source_path,
            "source_sha256": self.source_sha256,
            "text": self.text,
        }


@dataclass(frozen=True, slots=True)
class EvidenceBulletV1:
    id: str
    experience_id: str
    project_id: str | None
    text: str
    source_path: str
    source_sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "experience_id": self.experience_id,
            "id": self.id,
            "project_id": self.project_id,
            "source_path": self.source_path,
            "source_sha256": self.source_sha256,
            "text": self.text,
        }


@dataclass(frozen=True, slots=True)
class ActiveExperienceV1:
    id: str
    source_path: str
    source_sha256: str
    bullets: tuple[EvidenceBulletV1, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "bullets": [bullet.to_dict() for bullet in self.bullets],
            "id": self.id,
            "source_path": self.source_path,
            "source_sha256": self.source_sha256,
        }


@dataclass(frozen=True, slots=True)
class AllowedSkillV1:
    id: str
    text: str
    group_id: str
    group_name: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "group_id": self.group_id,
            "group_name": self.group_name,
            "id": self.id,
            "text": self.text,
        }


@dataclass(frozen=True, slots=True)
class EvidenceCatalogV1:
    source_revision: str
    resume_id: str
    summary: SummaryEvidenceV1
    active_experiences: tuple[ActiveExperienceV1, ...]
    allowed_skills: tuple[AllowedSkillV1, ...]
    active_experience_order: tuple[str, ...]
    renderer_version: str
    tracked_manifest: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "active_experience_order": list(self.active_experience_order),
            "active_experiences": [item.to_dict() for item in self.active_experiences],
            "allowed_skills": [item.to_dict() for item in self.allowed_skills],
            "contract_version": CONTRACT_VERSION,
            "renderer_version": self.renderer_version,
            "resume_id": self.resume_id,
            "schema": "roleloop.evidence-catalog.v1",
            "source_revision": self.source_revision,
            "summary": self.summary.to_dict(),
            "tracked_manifest": dict(sorted(self.tracked_manifest.items())),
        }


@dataclass(frozen=True, slots=True)
class ExperienceSelectionV1:
    experience_id: str
    bullet_ids: tuple[str, ...]

    @classmethod
    def from_dict(cls, value: Any) -> ExperienceSelectionV1:
        data = _object(
            value,
            name="experience selection",
            required={"experience_id", "bullet_ids"},
        )
        bullet_ids = _string_list(data["bullet_ids"], name="bullet_ids", maximum=12)
        if not bullet_ids:
            raise TypeValidationError(
                "an experience selection needs at least one bullet"
            )
        return cls(
            experience_id=_string(
                data["experience_id"], name="experience_id", maximum=200
            ),
            bullet_ids=bullet_ids,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "bullet_ids": list(self.bullet_ids),
            "experience_id": self.experience_id,
        }


@dataclass(frozen=True, slots=True)
class TailoringSelectionV1:
    source_revision: str
    evidence_catalog_sha256: str
    job_version_id: str
    headline: str
    summary_id: str
    skill_ids: tuple[str, ...]
    experiences: tuple[ExperienceSelectionV1, ...]
    paper_size: str
    maximum_pages: int

    @classmethod
    def from_dict(cls, value: Any) -> TailoringSelectionV1:
        data = _object(
            value,
            name="tailoring selection",
            required={
                "schema",
                "contract_version",
                "source_revision",
                "evidence_catalog_sha256",
                "job_version_id",
                "headline",
                "summary_id",
                "skill_ids",
                "experiences",
                "paper_size",
                "maximum_pages",
            },
        )
        if data["schema"] != "roleloop.tailoring-selection.v1":
            raise TypeValidationError("unsupported tailoring selection schema")
        if (
            isinstance(data["contract_version"], bool)
            or not isinstance(data["contract_version"], int)
            or data["contract_version"] != CONTRACT_VERSION
        ):
            raise TypeValidationError("unsupported contract version")
        raw_experiences = data["experiences"]
        if not isinstance(raw_experiences, list) or not raw_experiences:
            raise TypeValidationError("experiences must be a non-empty array")
        if len(raw_experiences) > 6:
            raise TypeValidationError("experiences has more than 6 entries")
        experiences = tuple(
            ExperienceSelectionV1.from_dict(item) for item in raw_experiences
        )
        experience_ids = [item.experience_id for item in experiences]
        if len(experience_ids) != len(set(experience_ids)):
            raise TypeValidationError("experience selections cannot be duplicated")
        paper_size = data["paper_size"]
        if not isinstance(paper_size, str):
            raise TypeValidationError("paper_size must be a string")
        if paper_size not in {"a4paper", "letterpaper"}:
            raise TypeValidationError("paper_size must be a4paper or letterpaper")
        maximum_pages = data["maximum_pages"]
        if isinstance(maximum_pages, bool) or not isinstance(maximum_pages, int):
            raise TypeValidationError("maximum_pages must be an integer")
        if not 1 <= maximum_pages <= 5:
            raise TypeValidationError("maximum_pages must be between 1 and 5")
        headline = _string(data["headline"], name="headline", maximum=200)
        if any(character.isdigit() for character in headline) or (
            _QUANTITATIVE_HEADLINE.search(headline) is not None
        ):
            raise TypeValidationError(
                "headline cannot contain digits or unsupported numeric claims"
            )
        return cls(
            source_revision=validate_source_revision(data["source_revision"]),
            evidence_catalog_sha256=validate_sha256(
                data["evidence_catalog_sha256"], name="evidence_catalog_sha256"
            ),
            job_version_id=_string(
                data["job_version_id"], name="job_version_id", maximum=200
            ),
            headline=headline,
            summary_id=_string(data["summary_id"], name="summary_id", maximum=200),
            skill_ids=_string_list(data["skill_ids"], name="skill_ids", maximum=18),
            experiences=experiences,
            paper_size=paper_size,
            maximum_pages=maximum_pages,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "contract_version": CONTRACT_VERSION,
            "evidence_catalog_sha256": self.evidence_catalog_sha256,
            "experiences": [item.to_dict() for item in self.experiences],
            "headline": self.headline,
            "job_version_id": self.job_version_id,
            "maximum_pages": self.maximum_pages,
            "paper_size": self.paper_size,
            "schema": "roleloop.tailoring-selection.v1",
            "skill_ids": list(self.skill_ids),
            "source_revision": self.source_revision,
            "summary_id": self.summary_id,
        }


@dataclass(frozen=True, slots=True)
class ArtifactFileV1:
    file_name: str
    media_type: str
    sha256: str
    size_bytes: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_name": self.file_name,
            "media_type": self.media_type,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
        }


@dataclass(frozen=True, slots=True)
class RendererToolchainV1:
    python_version: str
    latexmk_version: str
    pdftex_version: str
    pdfinfo_version: str
    pdftotext_version: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "latexmk_version": self.latexmk_version,
            "pdfinfo_version": self.pdfinfo_version,
            "pdftotext_version": self.pdftotext_version,
            "pdftex_version": self.pdftex_version,
            "python_version": self.python_version,
        }


@dataclass(frozen=True, slots=True)
class RenderChecksV1:
    valid_pdf_header: bool
    page_count: int
    ats_text_nonempty: bool
    compile_log_sanitized: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "ats_text_nonempty": self.ats_text_nonempty,
            "compile_log_sanitized": self.compile_log_sanitized,
            "page_count": self.page_count,
            "valid_pdf_header": self.valid_pdf_header,
        }


@dataclass(frozen=True, slots=True)
class RenderResultV1:
    source_revision: str
    resume_id: str
    evidence_catalog_sha256: str
    selection_sha256: str
    files: tuple[ArtifactFileV1, ...]
    toolchain: RendererToolchainV1
    checks: RenderChecksV1
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "checks": self.checks.to_dict(),
            "contract_version": CONTRACT_VERSION,
            "evidence_catalog_sha256": self.evidence_catalog_sha256,
            "files": [item.to_dict() for item in self.files],
            "renderer_version": RENDERER_VERSION,
            "resume_id": self.resume_id,
            "schema": "roleloop.render-result.v1",
            "selection_sha256": self.selection_sha256,
            "source_revision": self.source_revision,
            "status": "ok",
            "toolchain": self.toolchain.to_dict(),
            "warnings": list(self.warnings),
        }


def describe_v1() -> dict[str, Any]:
    return {
        "bridge_version": BRIDGE_VERSION,
        "commands": ["describe", "export", "render"],
        "contract_name": CONTRACT_NAME,
        "contract_version": CONTRACT_VERSION,
        "renderer_version": RENDERER_VERSION,
        "schema": "roleloop.bridge-description.v1",
        "schemas": {
            "evidence_catalog": EVIDENCE_SCHEMA_VERSION,
            "render_result": RENDER_RESULT_SCHEMA_VERSION,
            "tailoring_selection": SELECTION_SCHEMA_VERSION,
        },
        "supported_paper_sizes": ["a4paper", "letterpaper"],
    }


def error_v1(code: str, message: str, retryable: bool = False) -> dict[str, Any]:
    return {
        "code": code,
        "contract_version": CONTRACT_VERSION,
        "message": message,
        "retryable": retryable,
        "schema": "roleloop.bridge-error.v1",
        "status": "error",
    }


# Readable compatibility aliases for code written during the v1 rollout.
ExactSelection = TailoringSelectionV1
ExperienceSelection = ExperienceSelectionV1
ResumeEvidence = EvidenceCatalogV1
RenderResult = RenderResultV1
