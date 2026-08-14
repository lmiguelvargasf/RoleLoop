"""Strict user-input mapping shared by the CLI and Textual adapters."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from roleloop.application.dto import ProfileDraft, ResumeSourceDraft
from roleloop.application.errors import ValidationError
from roleloop.domain import (
    AgentConfiguration,
    AgentKind,
    AgentProvider,
    RemotePreference,
    ResumeSourceKind,
)

_AGENT_KINDS = (AgentKind.SCOUT, AgentKind.REVIEWER, AgentKind.RESUME)
_REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh"})
_PAPER_SIZES = frozenset({"a4paper", "letterpaper"})
_FIXED_BRIDGE_PATH = "roleloop_contract/v1/cli.py"
_PROFILE_FIELDS = frozenset(
    {
        "name",
        "target_roles",
        "locations",
        "remote_preference",
        "employment_types",
        "seniority",
        "annual_salary_floor",
        "salary_currency",
        "include_keywords",
        "exclude_keywords",
        "constraints",
        "agent_provider",
        "residence_country",
        "timezone",
        "target_hq_countries",
        "startup_required",
        "accepted_remote_arrangements",
        "accepted_hiring_arrangements",
        "search_queries",
        "paper_size",
        "page_limit",
        "agent_configurations",
    }
)
_AGENT_CONFIGURATION_FIELDS = frozenset({"kind", "provider", "model", "reasoning_effort"})
_RESUME_SOURCE_FIELDS = frozenset(
    {"repository", "kind", "ref", "document_path", "trust_repository"}
)


def profile_draft_from_mapping(values: Mapping[str, Any]) -> ProfileDraft:
    """Build one complete profile version without silently choosing a provider."""

    _reject_unknown_fields(values, _PROFILE_FIELDS, "profile")
    name = _required_string(values.get("name"), "Profile name")
    target_roles = _strings(values.get("target_roles"), "Target roles")
    if not target_roles:
        raise ValidationError("Enter at least one target role.")
    try:
        provider = AgentProvider(_required_string(values.get("agent_provider"), "Agent provider"))
        remote_preference = RemotePreference(
            _required_string(values.get("remote_preference", "any"), "Remote preference")
        )
    except ValueError as error:
        raise ValidationError(str(error)) from error

    configurations = _agent_configurations(values, provider)
    page_limit = _optional_integer(values.get("page_limit"), default=2)
    if not 1 <= page_limit <= 5:
        raise ValidationError("Résumé page limit must be between 1 and 5.")
    paper_size = _required_string(values.get("paper_size", "a4paper"), "Résumé paper size").lower()
    if paper_size not in _PAPER_SIZES:
        raise ValidationError("Résumé paper size must be a4paper or letterpaper.")
    timezone = _required_string(values.get("timezone", "America/Guayaquil"), "Profile timezone")
    try:
        ZoneInfo(timezone)
    except ZoneInfoNotFoundError as error:
        raise ValidationError(f"Unknown profile timezone: {timezone}") from error

    salary_floor = values.get("annual_salary_floor")
    if salary_floor is None:
        parsed_salary: int | None = None
    else:
        parsed_salary = _optional_integer(salary_floor, default=0)
        if parsed_salary < 0:
            raise ValidationError("Minimum annual salary cannot be negative.")

    return ProfileDraft(
        name=name,
        target_roles=target_roles,
        locations=_strings(values.get("locations"), "Locations"),
        remote_preference=remote_preference,
        employment_types=_strings(values.get("employment_types"), "Employment types"),
        seniority=_strings(values.get("seniority"), "Seniority"),
        annual_salary_floor=parsed_salary,
        salary_currency=_required_string(
            values.get("salary_currency", "USD"), "Salary currency"
        ).upper(),
        include_keywords=_strings(values.get("include_keywords"), "Include keywords"),
        exclude_keywords=_strings(values.get("exclude_keywords"), "Exclude keywords"),
        constraints=_optional_string(values.get("constraints", ""), "Constraints"),
        agent_provider=provider,
        residence_country=_required_string(
            values.get("residence_country", "Ecuador"), "Residence country"
        ),
        timezone=timezone,
        target_hq_countries=_strings(
            values.get("target_hq_countries"), "Target headquarters countries"
        ),
        startup_required=_boolean(values.get("startup_required", False), "Startup requirement"),
        accepted_remote_arrangements=_strings(
            values.get("accepted_remote_arrangements"), "Accepted remote arrangements"
        ),
        accepted_hiring_arrangements=_strings(
            values.get("accepted_hiring_arrangements"), "Accepted hiring arrangements"
        ),
        search_queries=_strings(values.get("search_queries"), "Search queries"),
        paper_size=paper_size,
        page_limit=page_limit,
        agent_configurations=configurations,
    )


def resume_source_draft_from_mapping(values: Mapping[str, Any]) -> ResumeSourceDraft:
    _reject_unknown_fields(values, _RESUME_SOURCE_FIELDS, "résumé source")
    repository = _required_string(values.get("repository"), "Résumé repository")
    trusted = _boolean(values.get("trust_repository", False), "Repository trust")
    if not trusted:
        raise ValidationError(
            "Explicitly acknowledge that the configured repository executes its trusted bridge."
        )
    try:
        kind = ResumeSourceKind(_required_string(values.get("kind"), "Repository kind"))
    except ValueError as error:
        raise ValidationError(str(error)) from error
    document_path = values.get("document_path", _FIXED_BRIDGE_PATH)
    if _required_string(document_path, "Résumé bridge path") != _FIXED_BRIDGE_PATH:
        raise ValidationError(f"Résumé bridge path must be {_FIXED_BRIDGE_PATH}.")
    ref_value = values.get("ref")
    ref = None if ref_value is None else _optional_string(ref_value, "Repository ref") or None
    return ResumeSourceDraft(
        repository=repository,
        kind=kind,
        document_path=_FIXED_BRIDGE_PATH,
        ref=ref,
        trust_repository=True,
    )


def local_date_time(value: str, timezone: str) -> datetime:
    """Represent a user-selected calendar date at local midnight."""

    try:
        selected = date.fromisoformat(value)
        zone = ZoneInfo(timezone)
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise ValidationError("Date must use YYYY-MM-DD in a valid profile timezone.") from error
    return datetime.combine(selected, time.min, zone)


def _agent_configurations(
    values: Mapping[str, Any],
    provider: AgentProvider,
) -> tuple[AgentConfiguration, ...]:
    raw_items = values.get("agent_configurations", ()) or ()
    by_kind: dict[AgentKind, AgentConfiguration] = {}
    if isinstance(raw_items, (str, bytes)) or not isinstance(raw_items, Sequence):
        raise ValidationError("Agent configurations must be an array.")
    for raw in raw_items:
        if isinstance(raw, AgentConfiguration):
            configuration = raw
        elif isinstance(raw, Mapping):
            _reject_unknown_fields(
                raw,
                _AGENT_CONFIGURATION_FIELDS,
                "agent configuration",
            )
            try:
                kind = AgentKind(_required_string(raw.get("kind"), "Agent kind"))
                configured_provider = AgentProvider(
                    _required_string(raw.get("provider", provider.value), "Agent provider")
                )
            except ValueError as error:
                raise ValidationError(str(error)) from error
            model = _required_string(raw.get("model", "gpt-5.6-terra"), f"{kind.value} model")
            effort = _required_string(
                raw.get("reasoning_effort", "medium"),
                f"{kind.value} reasoning effort",
            ).lower()
            configuration = AgentConfiguration(kind, configured_provider, model, effort)
        else:
            raise ValidationError("Each agent configuration must be an object.")
        if configuration.kind in by_kind:
            raise ValidationError(f"Duplicate {configuration.kind.value} configuration.")
        if configuration.provider is not provider:
            raise ValidationError("All three agents must use the profile's selected provider.")
        if configuration.reasoning_effort not in _REASONING_EFFORTS:
            raise ValidationError(
                f"Unsupported {configuration.kind.value} reasoning effort: "
                f"{configuration.reasoning_effort}"
            )
        by_kind[configuration.kind] = configuration

    if not by_kind:
        by_kind = {
            kind: AgentConfiguration(kind, provider, "gpt-5.6-terra", "medium")
            for kind in _AGENT_KINDS
        }
    missing = [kind.value for kind in _AGENT_KINDS if kind not in by_kind]
    if missing:
        raise ValidationError(f"Missing agent configurations: {', '.join(missing)}")
    return tuple(by_kind[kind] for kind in _AGENT_KINDS)


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{label} must be a string.")
    normalized = value.strip()
    if not normalized:
        raise ValidationError(f"{label} is required.")
    if any(ord(character) < 32 for character in normalized):
        raise ValidationError(f"{label} contains a control character.")
    return normalized


def _optional_string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{label} must be a string.")
    normalized = value.strip()
    if any(ord(character) < 32 for character in normalized):
        raise ValidationError(f"{label} contains a control character.")
    return normalized


def _strings(value: Any, label: str) -> tuple[str, ...]:
    if value is None or value == "":
        return ()
    if isinstance(value, str) or not isinstance(value, Sequence):
        raise ValidationError(f"{label} must be an array of strings.")
    if any(not isinstance(item, str) for item in value):
        raise ValidationError(f"{label} must contain only strings.")
    result = tuple(item.strip() for item in value if item.strip())
    if any(any(ord(character) < 32 for character in item) for item in result):
        raise ValidationError(f"{label} contains a control character.")
    if len(result) != len(set(result)):
        raise ValidationError(f"{label} cannot contain duplicates.")
    return result


def _optional_integer(value: Any, *, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError("Expected an integer value.")
    return int(value)


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValidationError(f"{label} must be true or false.")
    return value


def _reject_unknown_fields(
    values: Mapping[str, Any],
    allowed: frozenset[str],
    label: str,
) -> None:
    unknown = sorted(key for key in values if key not in allowed)
    if unknown:
        raise ValidationError(f"Unknown {label} fields: {', '.join(unknown)}.")


__all__ = [
    "local_date_time",
    "profile_draft_from_mapping",
    "resume_source_draft_from_mapping",
]
