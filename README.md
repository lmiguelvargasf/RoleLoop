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

### Master résumé repository

A search profile can use a local or remote Git repository as its persistent master résumé source.
Configuration does not clone, fetch, or change active evidence. Synchronization is an explicit,
separate operation that resolves one committed Git revision and activates an immutable evidence
snapshot:

```console
# Use a repository already available on this machine. Local paths must be absolute.
uv run roleloop resume-source configure /absolute/path/to/resume-repository \
  --kind local_git \
  --document-path resume/master.md

# Or configure a remote whose managed clone RoleLoop will cache and reuse.
uv run roleloop resume-source configure git@example.com:person/resume.git \
  --kind remote_git \
  --document-path resume/master.md \
  --ref main

uv run roleloop resume-source show
uv run roleloop resume-source sync
```

The ref defaults to `HEAD` for a local source and `main` for a remote source. Local synchronization
refuses a dirty working tree; commit or stash local changes before syncing so the snapshot always
corresponds to an exact Git revision. Each new resolved revision becomes a provenance-bearing
evidence version; repeated synchronization of the same revision and content is idempotent. Job
evaluation and résumé generation use the active snapshot without cloning or fetching during each
job workflow. The configured document must be tracked UTF-8 source with a `.json`, `.md`, `.txt`,
`.yaml`, `.yml`, `.toml`, `.tex`, or `.typ` extension.

The same configure-and-sync workflow is available in Settings. Direct PDF/text evidence import
remains available as a manual alternative.

In the TUI, use `1`/`2`/`3` for Inbox, Applications, and Settings; `/` searches,
`f` opens compact filters, `n` adds a URL, and `d` starts discovery. A detailed job
review provides Summary, Evidence, Questions, Résumé, and History tabs. RoleLoop asks
for confirmation before generation, submission, skipping, or replacing evidence.

Discovery, automated review, résumé generation, validation, and PDF compilation are provider ports.
This core release ships Git-backed résumé-source synchronization, but no live job-network, LLM, or
PDF-compiler providers; unavailable actions report a clear error without changing workflow state.

## Architecture

- `roleloop.domain`: models, value objects, and state rules; standard library only.
- `roleloop.application`: use cases, read models, ports, and transaction orchestration.
- `roleloop.infrastructure`: SQLite, migrations, filesystem artifacts, local evidence extraction,
  and pinned Git résumé snapshots.
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
