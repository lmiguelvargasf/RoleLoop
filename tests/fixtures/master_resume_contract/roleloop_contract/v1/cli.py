"""Fixed subprocess bridge used by RoleLoop.

Protocol:

* ``describe``: no stdin; one JSON object on stdout.
* ``export``: no stdin; one ``EvidenceCatalogV1`` JSON object on stdout.
* ``render``: one ``TailoringSelectionV1`` JSON object on stdin; one
  ``RenderResultV1`` JSON object on stdout and immutable files in ``--output-dir``.

The file is directly executable with ``python -I`` from an unpacked, pinned Git
snapshot.  It intentionally imports only Python's standard library and this
versioned package.
"""

# The fixed script must amend ``sys.path`` before importing its package when
# Python isolated mode executes it directly from a Git snapshot.
# ruff: noqa: I001

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import NoReturn


if __package__ in {None, ""}:
    # ``python -I path/to/cli.py`` omits the repository from sys.path.  The
    # source root is derived from this trusted fixed path, never from argv.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from roleloop_contract.v1.core import (
    ContractError,
    canonical_json_bytes,
    export_resume,
    render_resume,
)
from roleloop_contract.v1.types import (
    CONTRACT_VERSION,
    TailoringSelectionV1,
    TypeValidationError,
    describe_v1,
    error_v1,
    validate_source_revision,
)


MAX_STDIN_BYTES = 2 * 1024 * 1024


class ContractArgumentParser(argparse.ArgumentParser):
    """Turn argparse failures into the bridge's structured error protocol."""

    def error(self, message: str) -> NoReturn:
        raise TypeValidationError(message)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _write_stdout(value: object) -> None:
    sys.stdout.buffer.write(canonical_json_bytes(value))
    sys.stdout.buffer.flush()


def _write_error(code: str, message: str, *, retryable: bool = False) -> None:
    sys.stderr.buffer.write(canonical_json_bytes(error_v1(code, message, retryable)))
    sys.stderr.buffer.flush()


def _selection_from_stdin() -> TailoringSelectionV1:
    payload = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if not payload:
        raise TypeValidationError("render requires a JSON selection on stdin")
    if len(payload) > MAX_STDIN_BYTES:
        raise TypeValidationError("render request exceeds the 2 MiB input limit")

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise TypeValidationError(f"render request repeats JSON field: {key}")
            result[key] = value
        return result

    try:
        decoded = json.loads(payload, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TypeValidationError(
            f"render request is not valid UTF-8 JSON: {error}"
        ) from error
    return TailoringSelectionV1.from_dict(decoded)


def build_parser() -> argparse.ArgumentParser:
    parser = ContractArgumentParser(prog="roleloop-master-resume-v1")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("describe", "export", "render"):
        command = subparsers.add_parser(name)
        command.add_argument("--protocol", type=int, required=True)
        if name == "export":
            command.add_argument("--source-revision", required=True)
        if name == "render":
            command.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        if args.protocol != CONTRACT_VERSION:
            _write_error(
                "unsupported_protocol",
                f"bridge supports protocol {CONTRACT_VERSION}, received {args.protocol}",
            )
            return 69
        if args.command == "describe":
            _write_stdout(describe_v1())
            return 0
        if args.command == "export":
            revision = validate_source_revision(args.source_revision)
            _write_stdout(export_resume(_repo_root(), revision))
            return 0
        if args.command == "render":
            if not args.output_dir.is_absolute():
                raise ContractError(
                    "--output-dir must be absolute", code="unsafe_output_path"
                )
            selection = _selection_from_stdin()
            result = render_resume(_repo_root(), selection, args.output_dir)
            _write_stdout(result)
            return 0
    except TypeValidationError as error:
        _write_error("invalid_request", str(error))
        return 64
    except ContractError as error:
        _write_error(error.code, str(error), retryable=error.retryable)
        return 65
    except (OSError, UnicodeError) as error:
        _write_error("bridge_io_error", str(error), retryable=True)
        return 74
    return 70


if __name__ == "__main__":
    raise SystemExit(main())
