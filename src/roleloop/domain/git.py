"""Pure validation for Git source identifiers shared across application layers."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

_SCP_REMOTE = re.compile(r"[^/@:\s]+@[^/:\s]+:[^\s]+")


class InvalidGitRemote(ValueError):
    pass


class InvalidGitRef(ValueError):
    pass


def validate_remote_git_repository(value: str) -> str:
    """Return a safe supported Git remote without embedded HTTP credentials."""

    repository = value.strip()
    if not repository or any(ord(character) < 32 for character in repository):
        raise InvalidGitRemote("Remote résumé repository URL must not be empty")
    if _SCP_REMOTE.fullmatch(repository):
        return repository

    try:
        parsed = urlsplit(repository)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
    except ValueError as error:
        raise InvalidGitRemote("Remote résumé repository URL is invalid") from error

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https", "ssh", "git"} or not hostname:
        raise InvalidGitRemote(
            "Remote résumé repository must use an HTTP(S), SSH, Git, or scp-style URL"
        )
    if password is not None:
        raise InvalidGitRemote(
            "Remote résumé repository URL must not contain a password; "
            "use configured Git credentials"
        )
    if scheme in {"http", "https"} and username is not None:
        raise InvalidGitRemote(
            "Remote HTTP(S) résumé repository URL must not contain user information; "
            "use configured Git credentials"
        )
    if parsed.query or parsed.fragment:
        raise InvalidGitRemote("Remote résumé repository URL must not contain a query or fragment")
    return repository


def validate_git_ref(value: str) -> str:
    """Return a revision that cannot be interpreted as a Git option or ref expression."""

    ref = value.strip()
    if (
        not ref
        or ref.startswith(("-", "/"))
        or ref.endswith(("/", ".", ".lock"))
        or ".." in ref
        or "//" in ref
        or "@{" in ref
        or any(
            character.isspace() or ord(character) < 32 or character in "~^:?*[\\"
            for character in ref
        )
    ):
        raise InvalidGitRef("Résumé source ref is not a safe Git revision")
    return ref
