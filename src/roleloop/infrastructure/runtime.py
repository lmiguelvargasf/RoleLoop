from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class UUID4Generator:
    def new(self) -> str:
        return str(uuid4())

    def new_id(self) -> str:
        """Compatibility alias for low-level callers outside the application port."""

        return self.new()
