"""Canonical evidence extraction and native LaTeX rendering for contract v1.

This module is deliberately deterministic.  Model calls belong to RoleLoop;
the master-resume bridge only exports source evidence, validates an ID-only
selection, and renders that selection with the repository's LaTeX layout.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import signal
import subprocess  # nosec B404
import sys
import tarfile
import tempfile
import threading
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, BinaryIO

from .types import (
    RENDERER_VERSION,
    ActiveExperienceV1,
    AllowedSkillV1,
    ArtifactFileV1,
    EvidenceBulletV1,
    ExactSelection,
    RenderChecksV1,
    RendererToolchainV1,
    RenderResultV1,
    ResumeEvidence,
    SummaryEvidenceV1,
    validate_source_revision,
)

RESUME_ID = "resume.primary"
MAX_CAPTURE_BYTES = 1024 * 1024
MAX_PDF_BYTES = 10 * 1024 * 1024
_EXPERIENCE_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


class ContractError(ValueError):
    """A stable, user-actionable contract failure."""

    def __init__(
        self, message: str, *, code: str = "contract_error", retryable: bool = False
    ):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class RenderUnavailableError(ContractError):
    def __init__(self, message: str):
        super().__init__(message, code="renderer_unavailable")


class RenderFailedError(ContractError):
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message, code="render_failed", retryable=retryable)


@dataclass(frozen=True, slots=True)
class RenderExperience:
    id: str
    header_tex: str
    project_headings_tex: dict[str, str]


@dataclass(frozen=True, slots=True)
class ExtractedResume:
    evidence: ResumeEvidence
    render_experiences: dict[str, RenderExperience]


@dataclass(frozen=True, slots=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bytes_sha256(value: bytes) -> str:
    return sha256(value).hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    if hasattr(value, "to_dict"):
        value = value.to_dict()
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def evidence_bytes(evidence: ResumeEvidence) -> bytes:
    return canonical_json_bytes(evidence)


def evidence_sha256(evidence: ResumeEvidence) -> str:
    return bytes_sha256(evidence_bytes(evidence))


def selection_sha256(selection: ExactSelection) -> str:
    return bytes_sha256(canonical_json_bytes(selection))


def latex_escape(text: str) -> str:
    if any(ord(character) < 32 and character not in "\n\t" for character in text):
        raise ContractError(
            "rendered text contains a control character", code="invalid_text"
        )
    replacements = {
        "\\": r"\textbackslash{}",
        "{": r"\{",
        "}": r"\}",
        "$": r"\$",
        "%": r"\%",
        "&": r"\&",
        "#": r"\#",
        "_": r"\_",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    return "".join(replacements.get(character, character) for character in text)


def _without_tex_comment(line: str) -> str:
    for index, character in enumerate(line):
        if character != "%":
            continue
        preceding_backslashes = 0
        cursor = index - 1
        while cursor >= 0 and line[cursor] == "\\":
            preceding_backslashes += 1
            cursor -= 1
        if preceding_backslashes % 2 == 0:
            return line[:index]
    return line


def _strip_tex(text: str) -> str:
    text = "\n".join(_without_tex_comment(line) for line in text.splitlines())
    text = re.sub(r"\\href\{[^{}]*\}\{([^{}]*)\}", r"\1", text)
    for command in ("textbf", "textit", "emph"):
        text = re.sub(rf"\\{command}\{{([^{{}}]*)\}}", r"\1", text)
    text = text.replace(r"\LaTeX", "LaTeX")
    text = text.replace(r"\$", "$").replace(r"\%", "%").replace(r"\&", "&")
    text = text.replace(r"\_", "_").replace("~", " ")
    text = re.sub(r"\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?", " ", text)
    text = text.replace("{", "").replace("}", "")
    text = text.replace(r"\\", " ")
    return re.sub(r"\s+", " ", text).strip(" .\n")


def _split_top_level_commas(value: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    for index, character in enumerate(value):
        if character == "(":
            depth += 1
        elif character == ")":
            depth = max(0, depth - 1)
        elif character == "," and depth == 0:
            parts.append(value[start:index].strip())
            start = index + 1
    parts.append(value[start:].strip())
    return [_strip_tex(part) for part in parts if _strip_tex(part)]


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", ".", value.lower()).strip(".")
    return normalized or sha256(value.encode("utf-8")).hexdigest()[:12]


def _content_id(prefix: str, value: str) -> str:
    """Return a readable ID whose identity does not depend on source order."""
    normalized = re.sub(r"\s+", " ", value.strip())
    digest = sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}.{_slug(normalized)}.{digest}"


def _source_file(repo_root: Path, relative: str) -> Path:
    candidate = repo_root / relative
    if candidate.is_symlink() or not candidate.is_file():
        raise ContractError(
            f"required source file is missing or is a symbolic link: {relative}",
            code="invalid_source",
        )
    resolved = candidate.resolve()
    try:
        resolved.relative_to(repo_root)
    except ValueError as error:
        raise ContractError(
            f"source file escapes the repository snapshot: {relative}",
            code="invalid_source",
        ) from error
    return resolved


class ResumeEvidenceExtractor:
    """Extract the one canonical public evidence document and render metadata."""

    def __init__(self, repo_root: Path, source_revision: str):
        self.repo_root = repo_root.resolve(strict=True)
        try:
            self.source_revision = validate_source_revision(source_revision)
        except ValueError as error:
            raise ContractError(str(error), code="invalid_source_revision") from error

    def extract(self) -> ExtractedResume:
        experience_relative = "sections/professional_experience"
        experience_dir = self.repo_root / experience_relative
        manifest_path = _source_file(
            self.repo_root, f"{experience_relative}/experience.tex"
        )
        manifest_text = "\n".join(
            _without_tex_comment(line)
            for line in manifest_path.read_text(encoding="utf-8").splitlines()
        )
        active_order = re.findall(r"\\subfile\{\./([^}]+)\.tex\}", manifest_text)
        if not active_order or len(active_order) != len(set(active_order)):
            raise ContractError(
                "professional experience manifest is empty or contains duplicates",
                code="invalid_evidence",
            )
        unsafe_ids = sorted(
            experience_id
            for experience_id in active_order
            if not _EXPERIENCE_ID.fullmatch(experience_id)
        )
        if unsafe_ids:
            raise ContractError(
                f"professional experience IDs are unsafe: {unsafe_ids}",
                code="invalid_evidence",
            )
        active_set = set(active_order)

        experiences: list[ActiveExperienceV1] = []
        render_experiences: dict[str, RenderExperience] = {}
        source_manifest: dict[str, str] = {}

        for path in sorted(experience_dir.glob("*.tex")):
            if path.name == "experience.tex":
                continue
            relative = path.relative_to(self.repo_root).as_posix()
            safe_path = _source_file(self.repo_root, relative)
            if not _EXPERIENCE_ID.fullmatch(safe_path.stem):
                raise ContractError(
                    f"professional experience filename is unsafe: {relative}",
                    code="invalid_evidence",
                )
            raw = safe_path.read_text(encoding="utf-8")
            source_hash = file_sha256(safe_path)
            source_manifest[relative] = source_hash
            parsed, header, project_headings = self._parse_experience(
                safe_path.stem,
                raw,
                relative,
            )
            if not parsed:
                continue
            render_experiences[safe_path.stem] = RenderExperience(
                id=safe_path.stem,
                header_tex=header,
                project_headings_tex=project_headings,
            )
            if safe_path.stem in active_set:
                experiences.append(
                    ActiveExperienceV1(
                        id=safe_path.stem,
                        source_path=relative,
                        source_sha256=source_hash,
                        bullets=tuple(parsed),
                    )
                )

        required = (
            "main.tex",
            "res.cls",
            "sections/info.tex",
            "sections/summary.tex",
            "sections/skills.tex",
            "sections/education.tex",
            "sections/honors_awards.tex",
            "sections/professional_experience/experience.tex",
            "roleloop_contract/__init__.py",
            "roleloop_contract/v1/__init__.py",
            "roleloop_contract/v1/cli.py",
            "roleloop_contract/v1/core.py",
            "roleloop_contract/v1/types.py",
            "roleloop_contract/v1/schemas/bridge-description.schema.json",
            "roleloop_contract/v1/schemas/evidence-catalog.schema.json",
            "roleloop_contract/v1/schemas/render-result.schema.json",
            "roleloop_contract/v1/schemas/tailoring-selection.schema.json",
        )
        for relative in required:
            source_manifest[relative] = file_sha256(
                _source_file(self.repo_root, relative)
            )

        missing_active = active_set - {experience.id for experience in experiences}
        if missing_active:
            raise ContractError(
                f"active experiences have no extractable evidence: {sorted(missing_active)}",
                code="invalid_evidence",
            )

        summary_path = _source_file(self.repo_root, "sections/summary.tex")
        summary_text = self._extract_summary(summary_path.read_text(encoding="utf-8"))
        summary = SummaryEvidenceV1(
            id="summary.current",
            text=summary_text,
            source_path="sections/summary.tex",
            source_sha256=sha256(summary_text.encode("utf-8")).hexdigest(),
        )

        skills_path = _source_file(self.repo_root, "sections/skills.tex")
        allowed_skills = self._extract_skills(skills_path.read_text(encoding="utf-8"))
        evidence = ResumeEvidence(
            source_revision=self.source_revision,
            resume_id=RESUME_ID,
            summary=summary,
            active_experiences=tuple(
                sorted(experiences, key=lambda item: active_order.index(item.id))
            ),
            allowed_skills=tuple(allowed_skills),
            active_experience_order=tuple(active_order),
            renderer_version=RENDERER_VERSION,
            tracked_manifest=dict(sorted(source_manifest.items())),
        )
        return ExtractedResume(evidence=evidence, render_experiences=render_experiences)

    @staticmethod
    def _parse_experience(
        experience_id: str,
        raw: str,
        source_path: str,
    ) -> tuple[list[EvidenceBulletV1], str, dict[str, str]]:
        lines = raw.splitlines()
        semantic_lines = [_without_tex_comment(line) for line in lines]
        project_headings: dict[str, str] = {}
        block_projects: dict[int, str | None] = {}

        begins = [
            index
            for index, line in enumerate(semantic_lines)
            if r"\begin{itemize}" in line
        ]
        ends = [
            index
            for index, line in enumerate(semantic_lines)
            if r"\end{itemize}" in line
        ]
        if len(begins) != len(ends) or any(
            not previous_end < begin < end
            for previous_end, begin, end in zip([-1, *ends], begins, ends)
        ):
            raise ContractError(
                f"unbalanced or nested itemize blocks in {source_path}",
                code="invalid_evidence",
            )

        first_project_line: int | None = None
        if len(begins) > 1:
            previous_end = -1
            seen_project_ids: set[str] = set()
            for begin, end in zip(begins, ends):
                candidates = [
                    index
                    for index in range(previous_end + 1, begin)
                    if semantic_lines[index].strip()
                ]
                if not candidates:
                    raise ContractError(
                        f"an itemize block has no project heading in {source_path}",
                        code="invalid_evidence",
                    )
                heading_index = candidates[-1]
                heading_tex = semantic_lines[heading_index].strip()
                if not heading_tex.startswith(r"\textbf{"):
                    raise ContractError(
                        f"multi-project heading must use \\textbf in {source_path}",
                        code="invalid_evidence",
                    )
                heading_text = _strip_tex(heading_tex)
                project_id = _content_id("project", heading_text)
                if project_id in seen_project_ids:
                    raise ContractError(
                        f"duplicate project heading in {source_path}: {heading_text}",
                        code="invalid_evidence",
                    )
                seen_project_ids.add(project_id)
                project_headings[project_id] = heading_tex
                block_projects[begin] = project_id
                first_project_line = (
                    heading_index if first_project_line is None else first_project_line
                )
                previous_end = end
        elif begins:
            block_projects[begins[0]] = None

        first_itemize = begins[0] if begins else len(lines)
        header_end = (
            first_project_line if first_project_line is not None else first_itemize
        )
        header = "\n".join(lines[:header_end]).strip()

        items: list[EvidenceBulletV1] = []
        seen_ids: set[str] = set()
        current_text: list[str] | None = None
        current_project: str | None = None

        def flush() -> None:
            nonlocal current_text
            if current_text is None:
                return
            text = _strip_tex(" ".join(current_text))
            if text:
                claim_hash = sha256(text.encode("utf-8")).hexdigest()
                evidence_id = f"{experience_id}.claim.{claim_hash[:16]}"
                if evidence_id in seen_ids:
                    raise ContractError(
                        f"duplicate normalized claim in {source_path}: {text}",
                        code="invalid_evidence",
                    )
                seen_ids.add(evidence_id)
                items.append(
                    EvidenceBulletV1(
                        id=evidence_id,
                        experience_id=experience_id,
                        project_id=current_project,
                        text=text,
                        source_path=source_path,
                        source_sha256=claim_hash,
                    )
                )
            current_text = None

        item_pattern = re.compile(r"\\item(?:\[[^\]]*\])?\s*(.*)")
        for index, line in enumerate(semantic_lines):
            if index in block_projects:
                current_project = block_projects[index]
            match = item_pattern.search(line)
            if match:
                flush()
                current_text = [match.group(1)]
                continue
            if current_text is not None:
                if r"\end{itemize}" in line:
                    flush()
                else:
                    current_text.append(line.strip())
        flush()
        return items, header, project_headings

    @staticmethod
    def _extract_summary(raw: str) -> str:
        raw = "\n".join(_without_tex_comment(line) for line in raw.splitlines())
        match = re.search(
            r"\\section\{SUMMARY\}\s*\{\s*\\drawline\s*(.*?)\n\}", raw, re.DOTALL
        )
        if match is None:
            raise ContractError(
                "could not parse sections/summary.tex", code="invalid_evidence"
            )
        return _strip_tex(match.group(1))

    @staticmethod
    def _extract_skills(raw: str) -> list[AllowedSkillV1]:
        skills: list[AllowedSkillV1] = []
        used_skill_text: set[str] = set()
        pattern = re.compile(r"\\item\s+\\textbf\{(.+?):\}\s*(.*)")
        for raw_line in raw.splitlines():
            line = _without_tex_comment(raw_line)
            match = pattern.search(line)
            if not match:
                continue
            name = _strip_tex(match.group(1))
            group_id = _content_id("skill-group", name)
            for skill_text in _split_top_level_commas(match.group(2)):
                normalized = re.sub(r"\s+", " ", skill_text.strip()).casefold()
                if normalized in used_skill_text:
                    raise ContractError(
                        f"duplicate normalized skill: {skill_text}",
                        code="invalid_evidence",
                    )
                used_skill_text.add(normalized)
                skills.append(
                    AllowedSkillV1(
                        id=_content_id("skill", skill_text),
                        text=skill_text,
                        group_id=group_id,
                        group_name=name,
                    )
                )
        if not skills:
            raise ContractError(
                "could not parse sections/skills.tex", code="invalid_evidence"
            )
        return skills


def validate_selection(
    selection: ExactSelection,
    extracted: ExtractedResume,
) -> None:
    evidence = extracted.evidence
    actual_checksum = evidence_sha256(evidence)
    if selection.source_revision != evidence.source_revision:
        raise ContractError(
            "selection source revision does not match this source snapshot",
            code="source_revision_mismatch",
        )
    if selection.evidence_catalog_sha256 != actual_checksum:
        raise ContractError(
            "selection evidence checksum does not match this source snapshot",
            code="evidence_mismatch",
        )
    if selection.summary_id != evidence.summary.id:
        raise ContractError(
            "selection must use the canonical summary ID", code="invalid_selection"
        )
    if len(selection.experiences) > 6:
        raise ContractError("too many experiences selected", code="invalid_selection")
    bullet_count = sum(len(item.bullet_ids) for item in selection.experiences)
    if bullet_count > 12:
        raise ContractError("too many bullets selected", code="invalid_selection")
    if len(selection.skill_ids) > 18:
        raise ContractError("too many skills selected", code="invalid_selection")

    experience_map = {item.id: item for item in evidence.active_experiences}
    item_map = {
        bullet.id: bullet
        for experience in evidence.active_experiences
        for bullet in experience.bullets
    }
    allowed_skills = {skill.id for skill in evidence.allowed_skills}
    unknown_skills = sorted(set(selection.skill_ids) - allowed_skills)
    if unknown_skills:
        raise ContractError(
            f"selection contains unknown skill IDs: {unknown_skills}",
            code="invalid_selection",
        )

    seen_bullets: set[str] = set()
    for experience in selection.experiences:
        source = experience_map.get(experience.experience_id)
        if source is None:
            raise ContractError(
                f"unknown experience ID: {experience.experience_id}",
                code="invalid_selection",
            )
        for bullet_id in experience.bullet_ids:
            bullet = item_map.get(bullet_id)
            if bullet is None:
                raise ContractError(
                    f"unknown bullet ID: {bullet_id}", code="invalid_selection"
                )
            if bullet.experience_id != experience.experience_id:
                raise ContractError(
                    f"{bullet_id} does not belong to {experience.experience_id}",
                    code="invalid_selection",
                )
            if bullet_id in seen_bullets:
                raise ContractError(
                    f"duplicate bullet selection: {bullet_id}",
                    code="invalid_selection",
                )
            seen_bullets.add(bullet_id)


def _verify_sources(repo_root: Path, evidence: ResumeEvidence) -> None:
    changed = [
        relative
        for relative, expected in evidence.tracked_manifest.items()
        if file_sha256(_source_file(repo_root, relative)) != expected
    ]
    if changed:
        raise ContractError(
            f"master resume changed after evidence export: {changed}",
            code="source_changed",
            retryable=True,
        )


def _write_main(repo_root: Path, package_dir: Path, paper_size: str) -> None:
    raw = _source_file(repo_root, "main.tex").read_text(encoding="utf-8")
    raw, replacements = re.subn(
        r"\b(?:a4paper|letterpaper)\b", paper_size, raw, count=1
    )
    if replacements != 1:
        raise ContractError(
            "could not locate the paper-size option in main.tex",
            code="invalid_source",
        )
    if r"\usepackage{needspace}" not in raw:
        raw = raw.replace(
            r"\usepackage{enumitem}",
            "\\usepackage{enumitem}\n\\usepackage{needspace}",
        )
    (package_dir / "main.tex").write_text(raw, encoding="utf-8")


def _write_info(repo_root: Path, sections_dir: Path, job_title: str) -> None:
    lines = (
        _source_file(repo_root, "sections/info.tex")
        .read_text(encoding="utf-8")
        .splitlines()
    )
    found_name = False
    replaced = False
    for index, line in enumerate(lines):
        if r"\textbf{\Large" in line:
            found_name = True
            continue
        if (
            found_name
            and line.strip().startswith("{")
            and line.strip().endswith(r"}\\")
        ):
            indent = line[: len(line) - len(line.lstrip())]
            lines[index] = f"{indent}{{{latex_escape(job_title)}}}\\\\"
            replaced = True
            break
    if not replaced:
        raise ContractError("could not locate headline in sections/info.tex")
    (sections_dir / "info.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_summary(sections_dir: Path, summary: SummaryEvidenceV1) -> None:
    content = (
        "\\documentclass[main.tex]{subfiles}\n\n"
        "\\begin{document}\n"
        "\\section{SUMMARY} {\n"
        "  \\drawline\n"
        f"  {latex_escape(summary.text)}\n"
        "}\n"
        "\\end{document}\n"
    )
    (sections_dir / "summary.tex").write_text(content, encoding="utf-8")


def _write_skills(
    sections_dir: Path,
    selection: ExactSelection,
    evidence: ResumeEvidence,
) -> None:
    lines = [
        r"\documentclass[main.tex]{subfiles}",
        "",
        r"\begin{document}",
        r"\section{SKILLS} {",
        r"  \drawline",
        r"  \begin{itemize}[leftmargin=0pt, label={}, itemsep=0pt, topsep=0pt]",
    ]
    skill_map = {skill.id: skill for skill in evidence.allowed_skills}
    ordered_groups: list[tuple[tuple[str, str], list[AllowedSkillV1]]] = []
    for skill_id in selection.skill_ids:
        skill = skill_map[skill_id]
        group = (skill.group_id, skill.group_name)
        if ordered_groups and ordered_groups[-1][0] == group:
            ordered_groups[-1][1].append(skill)
        else:
            ordered_groups.append((group, [skill]))
    for (_, group_name), skills in ordered_groups:
        lines.append(
            "    \\item \\textbf{"
            + latex_escape(group_name)
            + ":} "
            + ", ".join(latex_escape(skill.text) for skill in skills)
        )
    lines.extend([r"  \end{itemize}", "}", r"\end{document}"])
    (sections_dir / "skills.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_experience(
    sections_dir: Path,
    selection: ExactSelection,
    extracted: ExtractedResume,
) -> None:
    item_map = {
        bullet.id: bullet
        for experience in extracted.evidence.active_experiences
        for bullet in experience.bullets
    }
    lines = [
        r"\documentclass[main.tex]{subfiles}",
        "",
        r"\begin{document}",
        r"\section{PROFESSIONAL EXPERIENCE} {",
        r"  \drawline",
    ]
    for selected_experience in selection.experiences:
        source = extracted.render_experiences[selected_experience.experience_id]
        project_runs: list[tuple[str | None, list[EvidenceBulletV1]]] = []
        for bullet_id in selected_experience.bullet_ids:
            bullet = item_map[bullet_id]
            if project_runs and project_runs[-1][0] == bullet.project_id:
                project_runs[-1][1].append(bullet)
            else:
                project_runs.append((bullet.project_id, [bullet]))
        header = source.header_tex
        if any(project_id is not None for project_id, _ in project_runs):
            header = header.rstrip()
            if not header.endswith(r"\\"):
                header += r"\\"
        lines.extend([r"  \Needspace{7\baselineskip}", header])
        for project_id, bullets in project_runs:
            if project_id:
                try:
                    lines.append(source.project_headings_tex[project_id])
                except KeyError as error:
                    raise ContractError(
                        f"missing render heading for project {project_id}",
                        code="invalid_source",
                    ) from error
            lines.append(r"  \begin{itemize}[]")
            for bullet in bullets:
                lines.append(f"    \\item[--] {latex_escape(bullet.text)}")
            lines.append(r"  \end{itemize}")
    lines.extend(["}", r"\end{document}"])
    target = sections_dir / "professional_experience"
    target.mkdir()
    (target / "experience.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _sanitized_environment(
    work_dir: Path,
    latexmk_path: Path,
    *tool_paths: Path,
) -> dict[str, str]:
    home = work_dir / ".home"
    tmp = work_dir / ".tmp"
    texmf = work_dir / ".texmf"
    for directory in (home, tmp, texmf):
        directory.mkdir(exist_ok=True)
    path_entries = [str(path.parent) for path in (latexmk_path, *tool_paths)] + [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    return {
        "PATH": os.pathsep.join(dict.fromkeys(path_entries)),
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "TEXMFHOME": str(texmf),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        "SOURCE_DATE_EPOCH": "946684800",
        "FORCE_SOURCE_DATE": "1",
    }


def _drain_bounded(stream: BinaryIO, result: list[tuple[bytes, int]]) -> None:
    captured = bytearray()
    total = 0
    while chunk := stream.read(64 * 1024):
        total += len(chunk)
        remaining = MAX_CAPTURE_BYTES - len(captured)
        if remaining > 0:
            captured.extend(chunk[:remaining])
    result.append((bytes(captured), total))


def _decode_capture(raw: bytes, size: int) -> str:
    text = raw.decode("utf-8", errors="replace")
    if size > MAX_CAPTURE_BYTES:
        text += f"\n[output truncated after {MAX_CAPTURE_BYTES} bytes]\n"
    return text


def _run_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int,
) -> CommandResult:
    # Every caller supplies a resolved executable and fixed argv; no shell is used.
    process = subprocess.Popen(  # nosec B603
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        start_new_session=os.name == "posix",
    )
    if process.stdout is None or process.stderr is None:  # pragma: no cover
        process.kill()
        raise RenderFailedError("renderer output capture could not be initialized")
    stdout_result: list[tuple[bytes, int]] = []
    stderr_result: list[tuple[bytes, int]] = []
    readers = (
        threading.Thread(
            target=_drain_bounded,
            args=(process.stdout, stdout_result),
            daemon=True,
        ),
        threading.Thread(
            target=_drain_bounded,
            args=(process.stderr, stderr_result),
            daemon=True,
        ),
    )
    for reader in readers:
        reader.start()
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait()
        raise RenderFailedError(
            f"renderer exceeded its {timeout}-second timeout", retryable=True
        ) from error
    finally:
        for reader in readers:
            reader.join()
        process.stdout.close()
        process.stderr.close()
    stdout_raw, stdout_size = stdout_result[0]
    stderr_raw, stderr_size = stderr_result[0]
    return CommandResult(
        returncode=returncode,
        stdout=_decode_capture(stdout_raw, stdout_size),
        stderr=_decode_capture(stderr_raw, stderr_size),
    )


def _first_line(value: str) -> str:
    return next(
        (line.strip() for line in value.splitlines() if line.strip()), "unknown"
    )


def _command_version(result: CommandResult, tool_name: str) -> str:
    version = _first_line(result.stdout + "\n" + result.stderr)
    if result.returncode != 0 or version == "unknown":
        raise RenderFailedError(f"could not determine {tool_name} version")
    return version


def _sanitize_diagnostic(value: str, work_dir: Path) -> str:
    sanitized = value.replace(str(work_dir), "<render-work>")
    sanitized = sanitized.replace(str(work_dir.parent), "<render-temp>")
    sanitized = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", sanitized)
    return sanitized


def _compile_pdf(
    work_dir: Path,
    *,
    maximum_pages: int,
) -> tuple[Path, str, str, int, str, RendererToolchainV1]:
    executable = shutil.which("latexmk")
    if executable is None:
        raise RenderUnavailableError("latexmk is required to render a tailored PDF")
    # Keep the discovered TeX bin directory in PATH.  On macOS the executable
    # is normally a symlink into TeX Live's scripts directory while pdflatex
    # remains beside the symlink in /Library/TeX/texbin.
    latexmk = Path(executable).absolute()
    pdftex_executable = shutil.which("pdflatex")
    if pdftex_executable is None:
        raise RenderUnavailableError("pdflatex is required to render a tailored PDF")
    pdftex_path = Path(pdftex_executable).absolute()
    pdfinfo_executable = shutil.which("pdfinfo")
    if pdfinfo_executable is None:
        raise RenderUnavailableError("pdfinfo is required to verify PDF page count")
    pdftotext_executable = shutil.which("pdftotext")
    if pdftotext_executable is None:
        raise RenderUnavailableError("pdftotext is required to verify ATS text")
    pdfinfo_path = Path(pdfinfo_executable).absolute()
    pdftotext_path = Path(pdftotext_executable).absolute()
    env = _sanitized_environment(
        work_dir, latexmk, pdftex_path, pdfinfo_path, pdftotext_path
    )
    command = [
        str(latexmk),
        "-norc",
        "-pdf",
        "-no-shell-escape",
        "-no-mktex=tex",
        "-no-mktex=tfm",
        "-no-mktex=pk",
        "-no-parse-first-line",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-recorder",
        "-jobname=resume",
        "main.tex",
    ]
    compiled = _run_command(command, cwd=work_dir, env=env, timeout=120)
    compile_log = compiled.stdout + ("\n" if compiled.stdout else "") + compiled.stderr
    compile_log = _sanitize_diagnostic(compile_log, work_dir)
    pdf_path = work_dir / "resume.pdf"
    if compiled.returncode != 0:
        raise RenderFailedError(
            f"latexmk exited with status {compiled.returncode}: "
            f"{_first_line(compile_log)}"
        )
    if not pdf_path.is_file() or not pdf_path.read_bytes().startswith(b"%PDF-"):
        raise RenderFailedError("renderer did not produce a valid PDF header")
    if pdf_path.stat().st_size > MAX_PDF_BYTES:
        raise RenderFailedError("rendered PDF exceeds the 10 MiB contract limit")

    info = _run_command(
        [str(pdfinfo_path), "resume.pdf"], cwd=work_dir, env=env, timeout=30
    )
    if info.returncode != 0:
        raise RenderFailedError(f"pdfinfo failed: {_first_line(info.stderr)}")
    match = re.search(r"^Pages:\s+(\d+)", info.stdout, re.MULTILINE)
    if match is None:
        raise RenderFailedError("pdfinfo did not report a page count")
    page_count = int(match.group(1))
    if page_count < 1:
        raise RenderFailedError("rendered PDF has no pages")
    if page_count > maximum_pages:
        raise RenderFailedError(
            f"resume is {page_count} pages; limit is {maximum_pages}"
        )

    extracted = _run_command(
        [str(pdftotext_path), "-layout", "resume.pdf", "-"],
        cwd=work_dir,
        env=env,
        timeout=30,
    )
    if extracted.returncode != 0:
        raise RenderFailedError(f"pdftotext failed: {_first_line(extracted.stderr)}")
    ats_text = extracted.stdout
    if not ats_text.strip():
        raise RenderFailedError("rendered PDF has no extractable ATS text")

    latexmk_version = _run_command(
        [str(latexmk), "-version"], cwd=work_dir, env=env, timeout=10
    )
    pdftex_version = _run_command(
        [str(pdftex_path), "--version"], cwd=work_dir, env=env, timeout=10
    )
    pdfinfo_version = _run_command(
        [str(pdfinfo_path), "-v"], cwd=work_dir, env=env, timeout=10
    )
    pdftotext_version = _run_command(
        [str(pdftotext_path), "-v"], cwd=work_dir, env=env, timeout=10
    )
    toolchain = RendererToolchainV1(
        python_version=sys.version.split()[0],
        latexmk_version=_command_version(latexmk_version, "latexmk"),
        pdftex_version=_command_version(pdftex_version, "pdfTeX"),
        pdfinfo_version=_command_version(pdfinfo_version, "pdfinfo"),
        pdftotext_version=_command_version(pdftotext_version, "pdftotext"),
    )
    fls = (work_dir / "resume.fls").read_text(encoding="utf-8", errors="replace")
    fls = _sanitize_diagnostic(fls, work_dir)
    return pdf_path, compile_log, fls, page_count, ats_text, toolchain


def _markdown_inline(value: str) -> str:
    escaped = html.escape(value, quote=True)
    markdown_punctuation = frozenset(r"\`*_{}[]()#+-!|")
    return "".join(
        f"\\{character}" if character in markdown_punctuation else character
        for character in escaped
    )


def _review_markdown(selection: ExactSelection) -> str:
    evidence_ids = [
        bullet_id
        for experience in selection.experiences
        for bullet_id in experience.bullet_ids
    ]
    return f"""# Tailored résumé review

Source revision: `{selection.source_revision}`

Job version: {_markdown_inline(selection.job_version_id)}

Headline: {_markdown_inline(selection.headline)}

## Human gate 2

- [ ] I opened and read `resume.pdf`.
- [ ] Every selected claim is accurate and belongs to my experience.
- [ ] I reviewed unresolved eligibility, location, and compensation questions.
- [ ] I will answer legal, demographic, consent, and attestation fields myself.
- [ ] I will personally perform the final Submit action.

## Selected evidence IDs

{chr(10).join(f"- `{item}`" for item in evidence_ids)}
"""


def _create_source_archive(work_dir: Path, destination: Path) -> None:
    paths = [work_dir / "main.tex", work_dir / "res.cls"]
    paths.extend(sorted((work_dir / "sections").rglob("*")))
    with tarfile.open(destination, "w", format=tarfile.USTAR_FORMAT) as archive:
        for path in paths:
            if not path.is_file():
                continue
            relative = path.relative_to(work_dir).as_posix()
            data = path.read_bytes()
            info = tarfile.TarInfo(relative)
            info.size = len(data)
            info.mode = 0o644
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            with tempfile.SpooledTemporaryFile() as payload:
                payload.write(data)
                payload.seek(0)
                archive.addfile(info, payload)


def _artifact(path: Path, media_type: str) -> ArtifactFileV1:
    return ArtifactFileV1(
        file_name=path.name,
        media_type=media_type,
        sha256=file_sha256(path),
        size_bytes=path.stat().st_size,
    )


def _ensure_output_is_external(repo_root: Path, output_dir: Path) -> None:
    resolved_parent = output_dir.parent.resolve(strict=True)
    candidate = resolved_parent / output_dir.name
    try:
        candidate.relative_to(repo_root)
    except ValueError:
        pass
    else:
        raise ContractError(
            "contract outputs must be stored outside the master-resume repository",
            code="unsafe_output_path",
        )
    if output_dir.exists():
        raise ContractError(
            "output directory already exists; bridge outputs are immutable",
            code="output_exists",
        )


def export_resume(repo_root: Path, source_revision: str) -> ResumeEvidence:
    repo_root = repo_root.resolve(strict=True)
    return ResumeEvidenceExtractor(repo_root, source_revision).extract().evidence


def render_resume(
    repo_root: Path,
    selection: ExactSelection,
    output_dir: Path,
) -> RenderResultV1:
    repo_root = repo_root.resolve(strict=True)
    if output_dir.is_symlink():
        raise ContractError(
            "render output cannot be a symbolic link",
            code="unsafe_output_path",
        )
    output_dir = output_dir.resolve(strict=False)
    _ensure_output_is_external(repo_root, output_dir)
    extracted = ResumeEvidenceExtractor(repo_root, selection.source_revision).extract()
    validate_selection(selection, extracted)
    _verify_sources(repo_root, extracted.evidence)

    with tempfile.TemporaryDirectory(
        dir=output_dir.parent, prefix=".roleloop-render-"
    ) as temporary:
        temporary_root = Path(temporary)
        work_dir = temporary_root / "work"
        delivery = temporary_root / "delivery"
        work_dir.mkdir()
        delivery.mkdir()
        sections_dir = work_dir / "sections"
        sections_dir.mkdir()
        shutil.copy2(_source_file(repo_root, "res.cls"), work_dir / "res.cls")
        _write_main(repo_root, work_dir, selection.paper_size)
        _write_info(repo_root, sections_dir, selection.headline)
        _write_summary(sections_dir, extracted.evidence.summary)
        _write_skills(sections_dir, selection, extracted.evidence)
        _write_experience(sections_dir, selection, extracted)
        for filename in ("education.tex", "honors_awards.tex"):
            shutil.copy2(
                _source_file(repo_root, f"sections/{filename}"), sections_dir / filename
            )

        (work_dir / "evidence-catalog.json").write_bytes(
            evidence_bytes(extracted.evidence)
        )
        (work_dir / "tailoring-selection.json").write_bytes(
            canonical_json_bytes(selection)
        )
        pdf, log, fls, pages, ats, toolchain = _compile_pdf(
            work_dir, maximum_pages=selection.maximum_pages
        )

        shutil.copy2(pdf, delivery / "resume.pdf")
        (delivery / "compile.log").write_text(log, encoding="utf-8")
        (delivery / "resume.fls").write_text(fls, encoding="utf-8")
        (delivery / "ats.txt").write_text(ats, encoding="utf-8")
        (delivery / "REVIEW.md").write_text(
            _review_markdown(selection), encoding="utf-8"
        )
        (delivery / "evidence-catalog.json").write_bytes(
            evidence_bytes(extracted.evidence)
        )
        (delivery / "tailoring-selection.json").write_bytes(
            canonical_json_bytes(selection)
        )
        _create_source_archive(work_dir, delivery / "render-source.tar")

        files = [
            _artifact(delivery / "resume.pdf", "application/pdf"),
            _artifact(delivery / "render-source.tar", "application/x-tar"),
            _artifact(delivery / "compile.log", "text/plain; charset=utf-8"),
            _artifact(delivery / "resume.fls", "text/plain; charset=utf-8"),
            _artifact(delivery / "ats.txt", "text/plain; charset=utf-8"),
            _artifact(delivery / "REVIEW.md", "text/markdown; charset=utf-8"),
            _artifact(delivery / "evidence-catalog.json", "application/json"),
            _artifact(delivery / "tailoring-selection.json", "application/json"),
        ]
        result = RenderResultV1(
            source_revision=selection.source_revision,
            resume_id=extracted.evidence.resume_id,
            evidence_catalog_sha256=evidence_sha256(extracted.evidence),
            selection_sha256=selection_sha256(selection),
            files=tuple(files),
            toolchain=toolchain,
            checks=RenderChecksV1(
                valid_pdf_header=True,
                page_count=pages,
                ats_text_nonempty=bool(ats.strip()),
                compile_log_sanitized=True,
            ),
        )
        (delivery / "render-result.json").write_bytes(canonical_json_bytes(result))
        os.replace(delivery, output_dir)
    return result
