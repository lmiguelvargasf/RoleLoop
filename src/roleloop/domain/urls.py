"""Canonical job URL handling."""

from __future__ import annotations

import posixpath
import string
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


class InvalidJobUrl(ValueError):
    """Raised when a URL cannot safely identify an HTTP(S) job resource."""


_TRACKING_KEYS = {
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "ref_src",
    "vero_conv",
    "vero_id",
}
_HEX_DIGITS = frozenset(string.hexdigits)
_UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")


def canonicalize_job_url(raw_url: str) -> str:
    """Return a deterministic canonical form for an HTTP(S) job URL.

    Scheme and host casing, IDNs, default ports, path dot-segments, fragments,
    common tracking parameters, and query ordering are normalized.  Meaningful
    query values and the distinction between HTTP and HTTPS are preserved.
    """

    candidate = raw_url.strip()
    if not candidate:
        raise InvalidJobUrl("job URL cannot be empty")

    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError as exc:
        raise InvalidJobUrl("job URL has an invalid host or port") from exc

    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"}:
        raise InvalidJobUrl("job URL must use http or https")
    if not parts.hostname:
        raise InvalidJobUrl("job URL must include a host")
    if parts.username is not None or parts.password is not None:
        raise InvalidJobUrl("job URL must not contain credentials")

    try:
        hostname = parts.hostname.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise InvalidJobUrl("job URL host is invalid") from exc
    if ":" in hostname:  # urlsplit removes IPv6 brackets.
        hostname = f"[{hostname}]"

    include_port = port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    )
    netloc = f"{hostname}:{port}" if include_port else hostname

    raw_path = parts.path or "/"
    had_trailing_slash = raw_path.endswith("/")
    normalized_path = posixpath.normpath(_normalize_path_percent_encoding(raw_path))
    if not normalized_path.startswith("/"):
        normalized_path = "/" + normalized_path
    if normalized_path != "/" and had_trailing_slash:
        normalized_path = normalized_path.rstrip("/")
    path = quote(normalized_path, safe="/%!$&'()*+,;=:@-._~")

    query_items = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        lowered = key.casefold()
        if lowered.startswith("utm_") or lowered in _TRACKING_KEYS:
            continue
        query_items.append((key, value))
    query_items.sort(key=lambda item: (item[0], item[1]))
    query = urlencode(query_items, doseq=True)

    return urlunsplit((scheme, netloc, path, query, ""))


def _normalize_path_percent_encoding(path: str) -> str:
    """Decode only unreserved octets and uppercase every preserved escape.

    Reserved escapes such as ``%2F`` must remain escaped: decoding them can turn
    one path segment into two and make distinct job resources collide.
    """

    normalized: list[str] = []
    index = 0
    while index < len(path):
        character = path[index]
        if character != "%":
            normalized.append(character)
            index += 1
            continue
        if (
            index + 2 >= len(path)
            or path[index + 1] not in _HEX_DIGITS
            or path[index + 2] not in _HEX_DIGITS
        ):
            normalized.append("%25")
            index += 1
            continue
        value = int(path[index + 1 : index + 3], 16)
        decoded = chr(value)
        normalized.append(decoded if decoded in _UNRESERVED else f"%{value:02X}")
        index += 3
    return "".join(normalized)
