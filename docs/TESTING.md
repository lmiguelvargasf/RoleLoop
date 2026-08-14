# Testing RoleLoop v1

RoleLoop is designed to be tested completely without an API key. Start with the
Demo provider, which uses the same schemas and workflow transitions as OpenAI
but never accesses the network.

## Prerequisites

The full PDF journey requires:

```console
git --version
latexmk --version
pdflatex --version
pdfinfo -v
pdftotext -v
```

Install project dependencies and run diagnostics:

```console
uv sync
uv run roleloop doctor
```

Use an isolated data directory when testing migrations or a complete journey:

```console
export ROLELOOP_DATA_DIR="$(mktemp -d)/roleloop-data"
uv run roleloop
```

Onboarding requires an explicit Demo or OpenAI choice. Choose Demo first. Set
the path to your coordinated checkout, then configure it as a trusted local
Git source on ref `HEAD`; the repository must have no uncommitted changes:

```console
export MASTER_RESUME_REPO=/absolute/path/to/master-resume
uv run roleloop resume-source configure "$MASTER_RESUME_REPO" \
  --kind local_git --ref HEAD --trust-contract
```

## Owner acceptance journey

Verify this sequence in both the Textual interface and CLI:

1. Create and activate a Demo profile.
2. Configure and trust the master-resume repository.
3. Run Scout and confirm eligible, blocked, and duplicate jobs are all stored;
   blocked jobs are skipped without Reviewer calls.
4. Select Analyze on an eligible job. Confirm source sync happens first and the
   review displays its exact Git revision and source URLs.
5. Answer each required question, rerun Reviewer, and confirm the earlier review
   remains in history.
6. Choose Tailor. Resume generation should begin immediately.
7. Inspect the exact selected bullet/skill IDs, validation result, source
   revision, rendered PDF, and extracted-text checks.
8. Request changes and confirm a child run is created without overwriting the
   first PDF.
9. Approve the child PDF and confirm approval records its checksum.
10. Record manual submission with a chosen follow-up date.
11. Record several application stages, replacing or explicitly clearing the
    next follow-up, and finish with a terminal stage.
12. Restart RoleLoop and verify history, artifacts, lineage, and due dates.
13. Advance the résumé repository and verify the submitted run still opens the
    previously pinned artifact.

Also exercise a failed generation and explicit retry, a dirty local repository,
an unapproved submission attempt, a duplicate submission attempt, and a second
CLI/TUI process against the same database. The second process must fail clearly
without changing an in-progress run.

## Automated checks

Normal checks are deterministic and make no OpenAI calls:

```console
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv build
```

Run the coordinated contract and native offline journey explicitly when
preparing a release:

```console
uv run pytest tests/acceptance/test_contract_fixture_drift.py
uv run pytest tests/acceptance/test_demo_e2e.py
uv run pytest tests/acceptance/test_cli_restart.py
```

Run the master-resume repository's own reproducible gates from that checkout
as part of the same coordinated release:

```console
uv --directory "$MASTER_RESUME_REPO" sync
uv --directory "$MASTER_RESUME_REPO" run pytest
uv --directory "$MASTER_RESUME_REPO" run ruff check .
uv --directory "$MASTER_RESUME_REPO" run ruff format --check .
uv --directory "$MASTER_RESUME_REPO" run ty check
```

The drift check compares the sanitized vendored bridge byte-for-byte with a
coordinated master-resume checkout when one is available. Override discovery
with `ROLELOOP_MASTER_RESUME_REPOSITORY="$MASTER_RESUME_REPO"`.

Build and test the installed wheel in a fresh Python 3.11 environment:

```console
export ROLELOOP_DIST_DIR="$(mktemp -d)"
export ROLELOOP_INSTALL_ROOT="$(mktemp -d)"
uv build --out-dir "$ROLELOOP_DIST_DIR"
uv venv --python 3.11 "$ROLELOOP_INSTALL_ROOT/venv"
uv pip install --python "$ROLELOOP_INSTALL_ROOT/venv/bin/python" \
  "$ROLELOOP_DIST_DIR"/roleloop-*.whl
"$ROLELOOP_INSTALL_ROOT/venv/bin/roleloop" --help
ROLELOOP_DATA_DIR="$ROLELOOP_INSTALL_ROOT/data" \
  "$ROLELOOP_INSTALL_ROOT/venv/bin/roleloop" doctor --json
```

Before pushing coordinated branches, verify the real master checkout is clean,
then repeat the Demo owner journey against that exact commit:

```console
git -C "$MASTER_RESUME_REPO" status --short
git -C "$MASTER_RESUME_REPO" rev-parse HEAD
uv run roleloop resume-source sync
uv run roleloop doctor
```

The offline end-to-end suite uses a sanitized temporary Git résumé fixture,
real SQLite and artifact storage, the real contract CLI, LaTeX, Poppler, and a
process restart. Personal résumé content must never be copied into committed
fixtures, screenshots, or CI logs.

## Opt-in OpenAI smoke

Live tests run only when both variables are explicitly set:

```console
export ROLELOOP_RUN_LIVE_OPENAI=1
export OPENAI_API_KEY="..."
uv run pytest -m live_openai
```

The smoke test is limited to one Scout, one Reviewer, and one Resume call using
sanitized inputs. It asserts schemas and evidence invariants, not exact web
results or prose. The API key must not appear in SQLite, artifacts, logs,
diagnostics, renderer subprocesses, or captured exceptions.

## Legacy prototype history

The master repository's `.job-agent/state.sqlite3` and
`.job-agent/state-v2.sqlite3` files are never modified. Preview the optional
audited import before applying it. Imported records are deduplicated by
canonical URL and labeled `legacy_unpinned`; they cannot authorize résumé
generation or submission.
