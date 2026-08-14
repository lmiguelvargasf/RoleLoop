from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from roleloop.adapters.serialization import to_primitive


class State(StrEnum):
    READY = "ready"


@dataclass(frozen=True)
class Record:
    state: State
    created_at: datetime


def test_to_primitive_serializes_dataclasses_enums_and_utc_timestamps() -> None:
    assert to_primitive(Record(State.READY, datetime(2026, 8, 13, tzinfo=UTC))) == {
        "state": "ready",
        "created_at": "2026-08-13T00:00:00Z",
    }
