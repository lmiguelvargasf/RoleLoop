from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from roleloop.application.dto import RuntimeCheck, RuntimeReadiness
from roleloop.application.errors import ProviderUnavailableError
from roleloop.domain import AgentKind, AgentProvider, ResumeSourceKind, SearchProfileVersion

OPENAI_MODEL = "gpt-5.6-terra"
OPENAI_REASONING_EFFORT = "medium"
_REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh"})


def _positive_float(value: str | None, *, default: float, name: str) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return parsed


@dataclass(frozen=True, slots=True)
class AgentRuntimeConfig:
    """Non-secret startup defaults for one independently versioned agent."""

    kind: AgentKind
    model: str = OPENAI_MODEL
    reasoning_effort: str = OPENAI_REASONING_EFFORT

    def __post_init__(self) -> None:
        if not self.model.strip() or "\x00" in self.model:
            raise ValueError(f"{self.kind.value} model must not be empty")
        if self.reasoning_effort not in _REASONING_EFFORTS:
            raise ValueError(f"Unsupported {self.kind.value} reasoning effort")


@dataclass(frozen=True, slots=True)
class ProviderRuntimeConfig:
    scout: AgentRuntimeConfig = field(
        default_factory=lambda: AgentRuntimeConfig(kind=AgentKind.SCOUT)
    )
    reviewer: AgentRuntimeConfig = field(
        default_factory=lambda: AgentRuntimeConfig(kind=AgentKind.REVIEWER)
    )
    resume: AgentRuntimeConfig = field(
        default_factory=lambda: AgentRuntimeConfig(kind=AgentKind.RESUME)
    )
    timeout_seconds: float = 90.0
    max_attempts: int = 3

    def __post_init__(self) -> None:
        expected_kinds = (
            (self.scout, AgentKind.SCOUT),
            (self.reviewer, AgentKind.REVIEWER),
            (self.resume, AgentKind.RESUME),
        )
        for configuration, expected_kind in expected_kinds:
            if configuration.kind is not expected_kind:
                raise ValueError(
                    f"{expected_kind.value} runtime configuration has the wrong agent kind"
                )
        if self.timeout_seconds <= 0:
            raise ValueError("OpenAI timeout must be greater than zero")
        if not 1 <= self.max_attempts <= 5:
            raise ValueError("OpenAI attempts must be between one and five")


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    """Startup defaults only; onboarding must still confirm a provider explicitly."""

    provider_default: AgentProvider | None = None
    resume_repository: str | None = None
    resume_repository_kind: ResumeSourceKind | None = None
    resume_ref: str = "HEAD"
    contract_timeout_seconds: float = 120.0
    provider: ProviderRuntimeConfig = field(default_factory=ProviderRuntimeConfig)

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> RuntimeSettings:
        values = os.environ if environment is None else environment
        provider_default_value = values.get("ROLELOOP_AGENT_PROVIDER") or None
        provider_default: AgentProvider | None = None
        if provider_default_value is not None:
            try:
                provider_default = AgentProvider(provider_default_value.strip().lower())
            except ValueError as error:
                raise ValueError("ROLELOOP_AGENT_PROVIDER must be demo or openai") from error
        repository = values.get("ROLELOOP_RESUME_REPOSITORY") or None
        if repository is not None:
            repository = repository.strip() or None
        repository_kind_value = values.get("ROLELOOP_RESUME_REPOSITORY_KIND") or None
        repository_kind: ResumeSourceKind | None = None
        if repository_kind_value is not None:
            try:
                repository_kind = ResumeSourceKind(repository_kind_value.strip().lower())
            except ValueError as error:
                raise ValueError(
                    "ROLELOOP_RESUME_REPOSITORY_KIND must be local_git or remote_git"
                ) from error
        reference = values.get("ROLELOOP_RESUME_REF", "HEAD").strip()
        if not reference:
            raise ValueError("ROLELOOP_RESUME_REF must not be empty")

        def agent(kind: AgentKind) -> AgentRuntimeConfig:
            prefix = f"ROLELOOP_{kind.value.upper()}"
            model = values.get(f"{prefix}_MODEL", OPENAI_MODEL).strip()
            effort = (
                values.get(f"{prefix}_REASONING_EFFORT", OPENAI_REASONING_EFFORT).strip().lower()
            )
            return AgentRuntimeConfig(kind=kind, model=model, reasoning_effort=effort)

        return cls(
            provider_default=provider_default,
            resume_repository=repository,
            resume_repository_kind=repository_kind,
            resume_ref=reference,
            contract_timeout_seconds=_positive_float(
                values.get("ROLELOOP_CONTRACT_TIMEOUT_SECONDS"),
                default=120.0,
                name="ROLELOOP_CONTRACT_TIMEOUT_SECONDS",
            ),
            provider=ProviderRuntimeConfig(
                scout=agent(AgentKind.SCOUT),
                reviewer=agent(AgentKind.REVIEWER),
                resume=agent(AgentKind.RESUME),
                timeout_seconds=_positive_float(
                    values.get("ROLELOOP_OPENAI_TIMEOUT_SECONDS"),
                    default=90.0,
                    name="ROLELOOP_OPENAI_TIMEOUT_SECONDS",
                ),
                # Provider policy is fixed at one request plus two bounded retries.
                # This is deliberately not configurable from the ambient environment.
                max_attempts=3,
            ),
        )


def resolve_provider_runtime_config(
    profile: SearchProfileVersion,
    startup: RuntimeSettings,
) -> ProviderRuntimeConfig:
    """Apply persisted per-agent configuration over environment startup defaults."""

    persisted: dict[AgentKind, AgentRuntimeConfig] = {}
    for configuration in profile.agent_configurations:
        if configuration.provider is not profile.agent_provider:
            continue
        if configuration.kind in persisted:
            raise ValueError(f"Duplicate persisted {configuration.kind.value} configuration")
        persisted[configuration.kind] = AgentRuntimeConfig(
            kind=configuration.kind,
            model=configuration.model,
            reasoning_effort=configuration.reasoning_effort,
        )
    return ProviderRuntimeConfig(
        scout=persisted.get(AgentKind.SCOUT, startup.provider.scout),
        reviewer=persisted.get(AgentKind.REVIEWER, startup.provider.reviewer),
        resume=persisted.get(AgentKind.RESUME, startup.provider.resume),
        timeout_seconds=startup.provider.timeout_seconds,
        max_attempts=startup.provider.max_attempts,
    )


class RuntimeDoctor:
    """Report actionable runtime requirements without exposing secret values."""

    def __init__(
        self,
        *,
        environment: Mapping[str, str] | None = None,
        executable_lookup: Callable[[str], str | None] = shutil.which,
        model_access_checker: Callable[[str, str], bool] | None = None,
        model_access_timeout_seconds: float = 15.0,
    ) -> None:
        if model_access_timeout_seconds <= 0:
            raise ValueError("model access timeout must be greater than zero")
        self._environment = os.environ if environment is None else environment
        self._which = executable_lookup
        self._model_access_checker = model_access_checker or _openai_model_is_available
        self._model_access_timeout = model_access_timeout_seconds
        self._model_access_cache: dict[tuple[str, str], bool] = {}
        self._model_access_lock = asyncio.Lock()

    async def check(
        self,
        profile_version: SearchProfileVersion | None = None,
    ) -> RuntimeReadiness:
        provider = profile_version.agent_provider if profile_version is not None else None
        provider_valid = provider is not None
        checks: list[RuntimeCheck] = [
            RuntimeCheck(
                capability="provider_selection",
                available=provider_valid,
                detail=(
                    f"Provider selected: {provider.value}"
                    if provider is not None
                    else "Choose Demo or OpenAI during profile onboarding"
                ),
            )
        ]
        for executable in ("git", "latexmk", "pdflatex", "pdfinfo", "pdftotext"):
            resolved = self._which(executable)
            checks.append(
                RuntimeCheck(
                    capability=executable,
                    available=bool(resolved),
                    detail=(
                        f"{executable} is available"
                        if resolved
                        else f"Install {executable} before generating a résumé PDF"
                    ),
                )
            )
        if provider is AgentProvider.DEMO:
            checks.append(
                RuntimeCheck(
                    capability="agent_model_access",
                    available=True,
                    detail="Deterministic Demo agents are available offline",
                )
            )
        elif provider is AgentProvider.OPENAI:
            assert profile_version is not None
            key = self._environment.get("OPENAI_API_KEY", "").strip()
            checks.append(
                RuntimeCheck(
                    capability="openai_api_key",
                    available=bool(key),
                    detail=(
                        "OPENAI_API_KEY is available in the process environment"
                        if key
                        else "Set OPENAI_API_KEY before using the OpenAI provider"
                    ),
                )
            )
            configured_models = {item.model for item in profile_version.agent_configurations} or {
                OPENAI_MODEL
            }
            model_access = bool(key) and all(
                [await self._check_model_access(key, model) for model in sorted(configured_models)]
            )
            checks.append(
                RuntimeCheck(
                    capability="agent_model_access",
                    available=model_access,
                    detail=(
                        f"OpenAI account can access {', '.join(sorted(configured_models))}"
                        if model_access
                        else (
                            "Set OPENAI_API_KEY before checking model access"
                            if not key
                            else "OpenAI model access could not be verified"
                        )
                    ),
                )
            )
        return RuntimeReadiness(tuple(checks))

    async def _check_model_access(self, key: str, model: str) -> bool:
        cache_key = (hashlib.sha256(key.encode("utf-8")).hexdigest(), model)
        async with self._model_access_lock:
            cached = self._model_access_cache.get(cache_key)
            if cached is not None:
                return cached
            try:
                available = await asyncio.wait_for(
                    asyncio.to_thread(self._model_access_checker, key, model),
                    timeout=self._model_access_timeout,
                )
            except Exception:
                available = False
            self._model_access_cache[cache_key] = bool(available)
            return bool(available)


def _openai_model_is_available(api_key: str, model: str) -> bool:
    """Probe model metadata without generating content or retaining credentials."""

    try:
        from openai import OpenAI

        result = OpenAI(
            api_key=api_key,
            max_retries=0,
            timeout=10.0,
        ).models.retrieve(model)
    except Exception:
        return False
    return str(getattr(result, "id", "")) == model


def require_openai_api_key(environment: Mapping[str, str] | None = None) -> str:
    """Read the key at call time; callers must never serialize the returned value."""

    values = os.environ if environment is None else environment
    key = values.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ProviderUnavailableError(
            "OPENAI_API_KEY is required for the selected provider",
            details={"capability": "openai", "environment_variable": "OPENAI_API_KEY"},
        )
    return key


def sanitized_subprocess_environment(
    temporary_root: Path,
    *,
    source_date_epoch: int = 0,
    inherited: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Create an allowlisted environment for trusted repository subprocesses."""

    if source_date_epoch < 0:
        raise ValueError("source_date_epoch must not be negative")
    source = os.environ if inherited is None else inherited
    root = temporary_root.resolve(strict=False)
    home = root / "home"
    scratch = root / "tmp"
    home.mkdir(parents=True, exist_ok=True)
    scratch.mkdir(parents=True, exist_ok=True)
    path = source.get("PATH", os.defpath)
    if "\x00" in path:
        path = os.defpath
    return {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": path,
        "PYTHONHASHSEED": "0",
        "PYTHONNOUSERSITE": "1",
        "SOURCE_DATE_EPOCH": str(source_date_epoch),
        "TMPDIR": str(scratch),
        "TZ": "UTC",
    }


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class UUID4Generator:
    def new(self) -> str:
        return str(uuid4())

    def new_id(self) -> str:
        """Compatibility alias for low-level callers outside the application port."""

        return self.new()
