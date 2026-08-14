from __future__ import annotations

import pytest

from roleloop.application.errors import ProviderUnavailableError
from roleloop.application.ports import NullProgressReporter
from roleloop.infrastructure import (
    UnavailableDiscoveryProvider,
    UnavailablePdfCompiler,
    UnavailableResumeGenerator,
    UnavailableResumeValidator,
    UnavailableReviewAnalyzer,
    provider_capabilities,
)


@pytest.mark.asyncio
async def test_unavailable_providers_raise_typed_errors() -> None:
    progress = NullProgressReporter()

    with pytest.raises(ProviderUnavailableError) as discovery:
        await UnavailableDiscoveryProvider().discover(None, limit=10, progress=progress)  # type: ignore[arg-type]
    assert discovery.value.details == {"capability": "discovery"}

    with pytest.raises(ProviderUnavailableError):
        await UnavailableReviewAnalyzer().analyze(None, progress=progress)  # type: ignore[arg-type]
    with pytest.raises(ProviderUnavailableError):
        await UnavailableResumeGenerator().generate(None, progress=progress)  # type: ignore[arg-type]
    with pytest.raises(ProviderUnavailableError):
        await UnavailableResumeValidator().validate(None, None, progress=progress)  # type: ignore[arg-type]
    with pytest.raises(ProviderUnavailableError):
        await UnavailablePdfCompiler().compile(None, None, progress=progress)  # type: ignore[arg-type]


def test_provider_capability_summary_reports_unavailable_adapters() -> None:
    capabilities = provider_capabilities(
        discovery=UnavailableDiscoveryProvider(),
        review=UnavailableReviewAnalyzer(),
    )

    assert capabilities == {"discovery": False, "review": False}
