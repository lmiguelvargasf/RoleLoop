# RoleLoop

RoleLoop is a local, evidence-first job-search workflow for the terminal. Its primary interface is a
Textual application; a small headless CLI exposes the same application services for automation.

## Install and run

```console
uv sync
uv run roleloop
```

The first launch opens profile onboarding. RoleLoop stores its SQLite database and managed artifacts
in the platform-specific user data directory. Set `ROLELOOP_DATA_DIR` to override that location.

Headless commands operate on the active profile:

```console
uv run roleloop find --limit 20
uv run roleloop add https://example.com/jobs/123
uv run roleloop inbox --json
uv run roleloop review JOB_ID --json
uv run roleloop decide JOB_ID tailor
uv run roleloop decide JOB_ID watch
uv run roleloop decide JOB_ID skip
uv run roleloop applied JOB_ID
uv run roleloop outcome JOB_ID interviewing
```

In the TUI, use `1`/`2`/`3` for Inbox, Applications, and Settings; `/` searches,
`f` opens compact filters, `n` adds a URL, and `d` starts discovery. A detailed job
review provides Summary, Evidence, Questions, Résumé, and History tabs. RoleLoop asks
for confirmation before generation, submission, skipping, or replacing evidence.

Discovery, automated review, résumé generation, validation, and PDF compilation are provider ports.
This core release intentionally ships no live network, LLM, or compiler providers; those actions
report a clear unavailable-provider error without changing workflow state.

## Architecture

- `roleloop.domain`: models, value objects, and state rules; standard library only.
- `roleloop.application`: use cases, read models, ports, and transaction orchestration.
- `roleloop.infrastructure`: SQLite, migrations, filesystem artifacts, and local evidence extraction.
- `roleloop.adapters.tui`: the Textual evidence desk.
- `roleloop.adapters.cli`: the thin headless command adapter and TUI launcher.

SQLite and the application services are authoritative. Widgets and CLI renderers only project
application read models.

## Development

```console
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv build
```
