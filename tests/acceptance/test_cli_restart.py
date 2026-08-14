from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLI = (
    sys.executable,
    "-c",
    "import sys; from roleloop.adapters.cli import main; raise SystemExit(main(sys.argv[1:]))",
)


def _run_cli(data_dir: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["ROLELOOP_DATA_DIR"] = str(data_dir)
    environment.pop("OPENAI_API_KEY", None)
    return subprocess.run(
        [*CLI, *arguments],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )


def _json_success(result: subprocess.CompletedProcess[str]) -> object:
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["schema_version"] == 1
    assert "error" not in payload
    return payload["data"]


def test_cli_subprocess_restarts_use_the_same_authoritative_sqlite_state(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "roleloop-data"
    created = _json_success(
        _run_cli(
            data_dir,
            "profile",
            "create",
            "--name",
            "Sanitized subprocess search",
            "--role",
            "Applied AI Engineer",
            "--provider",
            "demo",
            "--command-id",
            "cli-profile-create-restart",
            "--json",
        )
    )
    assert isinstance(created, dict)
    profile_id = created["id"]

    # Every invocation below is a fresh Python process and rebuilds the service.
    shown = _json_success(_run_cli(data_dir, "profile", "show", profile_id, "--json"))
    assert isinstance(shown, dict)
    assert shown["name"] == "Sanitized subprocess search"
    assert {item["provider"] for item in shown["agent_configurations"]} == {"demo"}

    added = _json_success(
        _run_cli(
            data_dir,
            "add",
            "https://jobs.example.test/sanitized-applied-ai-role",
            "--command-id",
            "cli-scout-add-restart",
            "--json",
        )
    )
    assert isinstance(added, dict)
    job_id = added["job"]["id"]

    inbox = _json_success(_run_cli(data_dir, "inbox", "--json"))
    assert isinstance(inbox, list)
    assert [item["job_id"] for item in inbox] == [job_id]
    assert (data_dir / "roleloop.sqlite3").is_file()


def test_cli_mutation_receipts_replay_semantic_payloads_across_restarts(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "roleloop-data"
    created = _json_success(
        _run_cli(
            data_dir,
            "profile",
            "create",
            "--name",
            "Sanitized idempotency search",
            "--role",
            "Platform Engineer",
            "--provider",
            "demo",
            "--json",
        )
    )
    assert isinstance(created, dict)
    profile_id = created["id"]

    profile_payload = tmp_path / "profile-update.json"
    profile_payload.write_text(
        json.dumps(
            {
                "name": "Sanitized updated search",
                "target_roles": ["Applied AI Engineer"],
                "agent_provider": "demo",
            }
        ),
        encoding="utf-8",
    )
    update_arguments = (
        "profile",
        "update",
        profile_id,
        "--from-json",
        str(profile_payload),
        "--command-id",
        "cli-profile-update-replay",
        "--json",
    )
    first_update = _json_success(_run_cli(data_dir, *update_arguments))
    replayed_update = _json_success(_run_cli(data_dir, *update_arguments))
    assert isinstance(first_update, dict)
    assert isinstance(replayed_update, dict)
    assert replayed_update["id"] == first_update["id"]
    assert replayed_update["revision"] == first_update["revision"]
    assert replayed_update["current_version_id"] == first_update["current_version_id"]
    assert replayed_update["name"] == "Sanitized updated search"

    changed_profile_payload = tmp_path / "changed-profile-update.json"
    changed_profile_payload.write_text(
        json.dumps(
            {
                "name": "A different update",
                "target_roles": ["Applied AI Engineer"],
                "agent_provider": "demo",
            }
        ),
        encoding="utf-8",
    )
    changed_update = _run_cli(
        data_dir,
        "profile",
        "update",
        profile_id,
        "--from-json",
        str(changed_profile_payload),
        "--command-id",
        "cli-profile-update-replay",
        "--json",
    )
    assert changed_update.returncode == 2
    assert json.loads(changed_update.stdout)["error"]["code"] == "validation_error"

    repository = tmp_path / "master-resume"
    repository.mkdir()
    source_arguments = (
        "resume-source",
        "configure",
        str(repository),
        "--kind",
        "local_git",
        "--trust-contract",
        "--command-id",
        "cli-resume-source-replay",
        "--json",
    )
    first_source = _json_success(_run_cli(data_dir, *source_arguments))
    replayed_source = _json_success(_run_cli(data_dir, *source_arguments))
    assert isinstance(first_source, dict)
    assert isinstance(replayed_source, dict)
    assert replayed_source["id"] == first_source["id"]
    assert replayed_source["revision"] == first_source["revision"]
    assert replayed_source["repository"] == first_source["repository"]

    changed_repository = tmp_path / "different-master-resume"
    changed_repository.mkdir()
    changed_source = _run_cli(
        data_dir,
        "resume-source",
        "configure",
        str(changed_repository),
        "--kind",
        "local_git",
        "--trust-contract",
        "--command-id",
        "cli-resume-source-replay",
        "--json",
    )
    assert changed_source.returncode == 2
    assert json.loads(changed_source.stdout)["error"]["code"] == "validation_error"
