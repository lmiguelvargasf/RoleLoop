from __future__ import annotations

from datetime import datetime

import pytest

from roleloop.adapters.inputs import (
    local_date_time,
    profile_draft_from_mapping,
    resume_source_draft_from_mapping,
)
from roleloop.application.errors import ValidationError
from roleloop.domain import AgentKind, AgentProvider, ResumeSourceKind


def _profile_values() -> dict[str, object]:
    return {
        "name": "US startup search",
        "target_roles": ("Staff Engineer",),
        "agent_provider": "demo",
        "residence_country": "Ecuador",
        "timezone": "America/Guayaquil",
        "target_hq_countries": ("United States",),
        "startup_required": True,
        "accepted_remote_arrangements": ("remote from Ecuador",),
        "accepted_hiring_arrangements": ("contractor", "employer of record"),
        "search_queries": ("US startup staff engineer remote Ecuador",),
        "paper_size": "letterpaper",
        "page_limit": 2,
    }


def test_profile_input_requires_provider_and_builds_exact_three_agent_configs() -> None:
    values = _profile_values()
    draft = profile_draft_from_mapping(values)

    assert draft.agent_provider is AgentProvider.DEMO
    assert tuple(configuration.kind for configuration in draft.agent_configurations) == (
        AgentKind.SCOUT,
        AgentKind.REVIEWER,
        AgentKind.RESUME,
    )
    assert all(
        configuration.model == "gpt-5.6-terra" for configuration in draft.agent_configurations
    )
    assert draft.paper_size == "letterpaper"
    assert draft.startup_required

    values.pop("agent_provider")
    with pytest.raises(ValidationError, match="Agent provider"):
        profile_draft_from_mapping(values)


def test_profile_input_rejects_partial_agents_and_invalid_runtime_values() -> None:
    values = _profile_values()
    values["agent_configurations"] = (
        {
            "kind": "scout",
            "provider": "demo",
            "model": "gpt-5.6-terra",
            "reasoning_effort": "medium",
        },
    )
    with pytest.raises(ValidationError, match="Missing agent configurations"):
        profile_draft_from_mapping(values)

    values = _profile_values()
    values["page_limit"] = 6
    with pytest.raises(ValidationError, match="between 1 and 5"):
        profile_draft_from_mapping(values)


def test_resume_source_input_uses_fixed_bridge_and_explicit_trust() -> None:
    with pytest.raises(ValidationError, match="Explicitly acknowledge"):
        resume_source_draft_from_mapping(
            {
                "repository": "/work/master-resume",
                "kind": "local_git",
            }
        )

    with pytest.raises(ValidationError, match="bridge path"):
        resume_source_draft_from_mapping(
            {
                "repository": "/work/master-resume",
                "kind": "local_git",
                "ref": "HEAD",
                "trust_repository": True,
                "document_path": "attacker-controlled.py",
            }
        )

    draft = resume_source_draft_from_mapping(
        {
            "repository": "/work/master-resume",
            "kind": "local_git",
            "ref": "HEAD",
            "trust_repository": True,
            "document_path": "roleloop_contract/v1/cli.py",
        }
    )
    assert draft.kind is ResumeSourceKind.LOCAL_GIT
    assert draft.document_path == "roleloop_contract/v1/cli.py"
    assert draft.trust_repository


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("startup_required", "false", "must be true or false"),
        ("target_roles", ("Engineer", 7), "contain only strings"),
        ("page_limit", "2", "integer"),
    ],
)
def test_profile_input_rejects_type_coercion(
    field: str,
    value: object,
    message: str,
) -> None:
    values = _profile_values()
    values[field] = value

    with pytest.raises(ValidationError, match=message):
        profile_draft_from_mapping(values)


def test_mapping_inputs_reject_unknown_fields_and_string_trust() -> None:
    profile = _profile_values()
    profile["startup_requred"] = True
    with pytest.raises(ValidationError, match="Unknown profile fields"):
        profile_draft_from_mapping(profile)

    with pytest.raises(ValidationError, match="must be true or false"):
        resume_source_draft_from_mapping(
            {
                "repository": "/work/master-resume",
                "kind": "local_git",
                "trust_repository": "false",
            }
        )


def test_local_date_uses_the_profile_timezone_without_calculating_another_date() -> None:
    value = local_date_time("2026-08-21", "America/Guayaquil")

    assert isinstance(value, datetime)
    assert value.isoformat() == "2026-08-21T00:00:00-05:00"

    with pytest.raises(ValidationError, match="YYYY-MM-DD"):
        local_date_time("next Friday", "America/Guayaquil")
