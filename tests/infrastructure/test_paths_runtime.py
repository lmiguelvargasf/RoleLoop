from __future__ import annotations

from datetime import UTC
from pathlib import Path
from uuid import UUID

import pytest

from roleloop.domain import (
    AgentProvider,
    ResumeSourceKind,
    SearchProfileVersion,
)
from roleloop.infrastructure import RoleLoopPaths, SystemClock, UUID4Generator
from roleloop.infrastructure.runtime import (
    OPENAI_MODEL,
    RuntimeDoctor,
    RuntimeSettings,
    sanitized_subprocess_environment,
)


def test_data_directory_override_controls_managed_paths(tmp_path: Path) -> None:
    paths = RoleLoopPaths.from_environment({"ROLELOOP_DATA_DIR": str(tmp_path)})

    assert paths.data_dir == tmp_path
    assert paths.database_path == tmp_path / "roleloop.sqlite3"
    assert paths.artifacts_dir == tmp_path / "artifacts"
    assert paths.process_lock_path == tmp_path / ".roleloop.sqlite3.roleloop.lock"
    assert paths.resume_sources_dir == tmp_path / "resume-sources"

    paths.ensure_directories()
    assert paths.artifacts_dir.is_dir()
    assert paths.resume_sources_dir.is_dir()


def test_database_override_uses_its_parent_for_other_managed_data(tmp_path: Path) -> None:
    database_path = tmp_path / "custom" / "state.db"
    paths = RoleLoopPaths.from_environment({"ROLELOOP_DB_PATH": str(database_path)})

    assert paths.database_path == database_path
    assert paths.data_dir == database_path.parent
    assert paths.artifacts_dir == database_path.parent / "artifacts"
    assert paths.resume_sources_dir == database_path.parent / "resume-sources"


def test_system_clock_and_uuid_generator_produce_port_values() -> None:
    now = SystemClock().now()
    identifier = UUID4Generator().new()

    assert now.tzinfo is UTC
    assert str(UUID(identifier)) == identifier


def test_runtime_settings_use_locked_environment_names_and_independent_agents() -> None:
    settings = RuntimeSettings.from_environment(
        {
            "ROLELOOP_AGENT_PROVIDER": "openai",
            "ROLELOOP_SCOUT_MODEL": "gpt-5.6-terra",
            "ROLELOOP_SCOUT_REASONING_EFFORT": "medium",
            "ROLELOOP_REVIEWER_MODEL": "gpt-5.6-terra",
            "ROLELOOP_REVIEWER_REASONING_EFFORT": "high",
            "ROLELOOP_RESUME_MODEL": "gpt-5.6-terra",
            "ROLELOOP_RESUME_REASONING_EFFORT": "low",
            "ROLELOOP_RESUME_REPOSITORY": "/resume",
            "ROLELOOP_RESUME_REPOSITORY_KIND": "local_git",
            "ROLELOOP_RESUME_REF": "main",
            "ROLELOOP_OPENAI_MAX_ATTEMPTS": "5",
        }
    )

    assert settings.provider_default is AgentProvider.OPENAI
    assert settings.provider.scout.model == OPENAI_MODEL
    assert settings.provider.reviewer.model == OPENAI_MODEL
    assert settings.provider.reviewer.reasoning_effort == "high"
    assert settings.provider.resume.model == OPENAI_MODEL
    assert settings.resume_repository == "/resume"
    assert settings.resume_repository_kind is ResumeSourceKind.LOCAL_GIT
    assert settings.resume_ref == "main"
    assert settings.provider.max_attempts == 3


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("ROLELOOP_AGENT_PROVIDER", "automatic"),
        ("ROLELOOP_RESUME_REPOSITORY_KIND", "filesystem"),
        ("ROLELOOP_SCOUT_REASONING_EFFORT", "extreme"),
        ("ROLELOOP_REVIEWER_MODEL", ""),
    ],
)
def test_runtime_settings_reject_invalid_startup_defaults(name: str, value: str) -> None:
    with pytest.raises(ValueError):
        RuntimeSettings.from_environment({name: value})


def test_runtime_settings_retain_independent_model_defaults() -> None:
    settings = RuntimeSettings.from_environment(
        {
            "ROLELOOP_SCOUT_MODEL": "gpt-scout-example",
            "ROLELOOP_REVIEWER_MODEL": "gpt-reviewer-example",
            "ROLELOOP_RESUME_MODEL": "gpt-resume-example",
        }
    )

    assert settings.provider.scout.model == "gpt-scout-example"
    assert settings.provider.reviewer.model == "gpt-reviewer-example"
    assert settings.provider.resume.model == "gpt-resume-example"


@pytest.mark.asyncio
async def test_runtime_doctor_never_reports_the_openai_key() -> None:
    secret = "sk-test-do-not-leak"
    doctor = RuntimeDoctor(
        environment={"OPENAI_API_KEY": secret},
        executable_lookup=lambda executable: f"/tools/{executable}",
        model_access_checker=lambda key, model: key == secret and model == OPENAI_MODEL,
    )
    profile_version = SearchProfileVersion(
        id="profile-version",
        profile_id="profile",
        version_number=1,
        name="OpenAI profile",
        agent_provider=AgentProvider.OPENAI,
    )

    report = await doctor.check(profile_version)

    assert report.ready
    key_check = next(check for check in report.checks if check.capability == "openai_api_key")
    assert key_check.available
    model_check = next(check for check in report.checks if check.capability == "agent_model_access")
    assert model_check.available
    assert secret not in repr(report)


@pytest.mark.asyncio
async def test_runtime_doctor_is_dynamic_for_onboarding_and_demo() -> None:
    doctor = RuntimeDoctor(
        environment={},
        executable_lookup=lambda executable: f"/tools/{executable}",
    )

    onboarding = await doctor.check()
    assert not onboarding.ready
    assert all(check.capability != "openai_api_key" for check in onboarding.checks)

    demo = await doctor.check(
        SearchProfileVersion(
            id="profile-version",
            profile_id="profile",
            version_number=1,
            name="Demo profile",
            agent_provider=AgentProvider.DEMO,
        )
    )
    assert demo.ready
    assert all(check.capability != "openai_api_key" for check in demo.checks)


def test_sanitized_subprocess_environment_uses_an_allowlist(tmp_path: Path) -> None:
    environment = sanitized_subprocess_environment(
        tmp_path,
        source_date_epoch=123,
        inherited={
            "PATH": "/tools",
            "OPENAI_API_KEY": "secret",
            "GITHUB_TOKEN": "secret",
            "PYTHONPATH": "/untrusted",
            "SSH_AUTH_SOCK": "/agent",
        },
    )

    assert environment["PATH"] == "/tools"
    assert environment["SOURCE_DATE_EPOCH"] == "123"
    assert environment["HOME"] == str(tmp_path / "home")
    assert "OPENAI_API_KEY" not in environment
    assert "GITHUB_TOKEN" not in environment
    assert "PYTHONPATH" not in environment
    assert "SSH_AUTH_SOCK" not in environment
