from __future__ import annotations

from collections.abc import Sequence
from typing import NoReturn

from roleloop.application.dto import (
    CompiledDocument,
    DiscoveredJob,
    GenerationContext,
    ResumeDraft,
    ReviewAnalysis,
    ReviewContext,
)
from roleloop.application.errors import ProviderUnavailableError
from roleloop.application.ports import ProgressReporter
from roleloop.domain import SearchProfile, ValidationFinding

UNAVAILABLE_VERSION = "unavailable"


class _UnavailableProvider:
    capability = "provider"
    version = UNAVAILABLE_VERSION
    available = False

    def _raise(self) -> NoReturn:
        raise ProviderUnavailableError(
            f"{self.capability} provider is unavailable",
            details={"capability": self.capability},
        )


class UnavailableDiscoveryProvider(_UnavailableProvider):
    capability = "discovery"

    async def discover(
        self,
        profile: SearchProfile,
        *,
        limit: int,
        progress: ProgressReporter,
    ) -> Sequence[DiscoveredJob]:
        del profile, limit, progress
        self._raise()


class UnavailableReviewAnalyzer(_UnavailableProvider):
    capability = "review"

    async def analyze(
        self,
        context: ReviewContext,
        *,
        progress: ProgressReporter,
    ) -> ReviewAnalysis:
        del context, progress
        self._raise()


class UnavailableResumeGenerator(_UnavailableProvider):
    capability = "resume_generation"

    async def generate(
        self,
        context: GenerationContext,
        *,
        progress: ProgressReporter,
    ) -> ResumeDraft:
        del context, progress
        self._raise()


class UnavailableResumeValidator(_UnavailableProvider):
    capability = "resume_validation"

    async def validate(
        self,
        context: GenerationContext,
        draft: ResumeDraft,
        *,
        progress: ProgressReporter,
    ) -> Sequence[ValidationFinding]:
        del context, draft, progress
        self._raise()


class UnavailablePdfCompiler(_UnavailableProvider):
    capability = "pdf_compilation"

    async def compile(
        self,
        context: GenerationContext,
        draft: ResumeDraft,
        *,
        progress: ProgressReporter,
    ) -> CompiledDocument:
        del context, draft, progress
        self._raise()


def provider_capabilities(**providers: object) -> dict[str, bool]:
    return {
        capability: bool(getattr(provider, "available", True))
        for capability, provider in providers.items()
    }
