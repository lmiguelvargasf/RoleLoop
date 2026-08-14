from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures" / "master_resume_contract"
BRIDGE_FILES = (
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


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _coordinated_master_root() -> Path | None:
    configured = os.environ.get("ROLELOOP_MASTER_RESUME_REPOSITORY")
    candidates = (
        Path(configured).expanduser() if configured else None,
        Path.cwd().parent / "master-resume",
        Path.cwd().parent.parent / "master-resume",
    )
    return next(
        (candidate.resolve() for candidate in candidates if candidate and candidate.is_dir()),
        None,
    )


def test_vendored_contract_matches_coordinated_master_repository() -> None:
    master_root = _coordinated_master_root()
    if master_root is None:
        pytest.skip("no coordinated master-resume checkout is available")
    missing = [relative for relative in BRIDGE_FILES if not (master_root / relative).is_file()]
    assert not missing, f"coordinated master repository is missing bridge files: {missing}"

    drift = {
        relative: (_digest(FIXTURE_ROOT / relative), _digest(master_root / relative))
        for relative in BRIDGE_FILES
        if _digest(FIXTURE_ROOT / relative) != _digest(master_root / relative)
    }
    assert not drift, "vendored contract drifted from the coordinated master repository"
