"""Small, framework-independent helpers for rendering application DTOs."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from pathlib import Path
from typing import Any

_MISSING = object()


def field(value: Any, *names: str, default: Any = None) -> Any:
    """Read the first available name from either a mapping or an object."""

    for name in names:
        if isinstance(value, Mapping):
            candidate = value.get(name, _MISSING)
        else:
            candidate = getattr(value, name, _MISSING)
        if candidate is not _MISSING and candidate is not None:
            return candidate
    return default


def enum_text(value: Any, default: str = "-") -> str:
    """Return a stable user-facing string for enums and scalar values."""

    if value is None:
        return default
    raw = getattr(value, "value", value)
    text = str(raw).strip()
    return text.replace("_", " ") if text else default


def item_id(value: Any, *names: str) -> str:
    raw = field(value, *names, "id", default="")
    return str(raw)


def as_items(value: Any) -> list[Any]:
    """Normalize a page, mapping, or sequence into a list of rows."""

    if value is None:
        return []
    nested = field(value, "items", "jobs", "applications", "profiles", default=_MISSING)
    if nested is not _MISSING and nested is not value:
        return list(nested or [])
    if isinstance(value, Mapping):
        return list(value.values())
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    return [value]


def compact_date(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, (datetime, date)):
        return (
            value.isoformat(timespec="minutes")
            if isinstance(value, datetime)
            else value.isoformat()
        )
    return str(value)


def csv_values(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def csv_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, Iterable):
        return ", ".join(str(item) for item in value)
    return str(value)


def evidence_name(value: Any) -> str:
    source = field(value, "source_path", "path", "filename", default="")
    return Path(str(source)).name if source else "No evidence imported"


def operation_error(error: BaseException) -> str:
    """Produce concise, actionable error copy without exposing tracebacks."""

    message = str(error).strip()
    class_name = type(error).__name__
    if "provider" in class_name.lower() or "config" in class_name.lower():
        return message or "The required provider is not configured. Check Settings."
    return message or class_name


def progress_parts(update: Any) -> tuple[str, str]:
    if isinstance(update, str):
        return update, ""
    stage = enum_text(field(update, "stage", "status", default="Working"), "Working")
    detail = str(field(update, "detail", "message", default="") or "")
    return stage, detail
