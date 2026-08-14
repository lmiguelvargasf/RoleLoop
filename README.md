# RoleLoop

RoleLoop is a local, evidence-first job-search workflow for the terminal. Its primary interface is a
Textual application; a small headless CLI exposes the same application services for automation.

## Screenshots

### Keyboard-first inbox

Search, filter, and triage every job case from one responsive workspace. Each row keeps review,
eligibility, decision, résumé, application, and outcome state visible without making the UI the
source of truth.

[![RoleLoop inbox with workflow filters, job ledger, and selected-case preview](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-inbox.png)](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-inbox.png)

### Evidence-led review

RoleLoop gives supporting evidence and skeptic findings equal visual weight, with source anchors
and explicit workflow facets instead of an opaque match score.

[![RoleLoop job review showing the case for and skeptic's case side by side](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-review-evidence.png)](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-review-evidence.png)

### Résumé validation and application tracking

Tailored résumé runs retain their validation result and compiled artifact. Submitted applications
then move into a separate ledger with the artifact snapshot and current outcome.

#### Résumé validation

[![RoleLoop résumé validation results](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-review-resume.png)](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-review-resume.png)

#### Application ledger

[![RoleLoop application and outcome ledger](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-applications.png)](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-applications.png)

### Search profiles and provider readiness

Settings shows the active search criteria, immutable résumé-evidence version, managed artifact,
and which external provider capabilities are configured.

[![RoleLoop settings with search profiles, résumé evidence, and provider readiness](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-settings.png)](https://lmiguelvargasf.github.io/RoleLoop/screenshots/roleloop-settings.png)

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

Regenerate the deterministic documentation screenshots with:

```console
uv run python scripts/capture_screenshots.py
```
