# RoleLoop

A local TypeScript app with private user workspaces for two job-search flows: applications to advertised remote roles, and research-led outreach to startup founders. The app runs directly on Node.js; Docker runs only Supabase's local services.

## Start locally

From this repository, with Docker Desktop running:

```sh
nvm install
nvm use
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:5173**. `setup` starts Supabase, applies pending migrations without resetting data, writes private backend configuration, and installs Chromium for résumé PDF export. The first run downloads Supabase images and the browser. Node.js **26.13.0** is pinned in `.nvmrc` and `.node-version`; npm is bundled with Node. Bun is not required. Use `source "$HOME/.nvm/nvm.sh"` first if your terminal has not loaded nvm.

Useful commands:

```sh
npm run doctor      # database, Studio, local email, optional model readiness
npm run typecheck
npm test            # offline domain, connector and approval tests
ROLELOOP_INTEGRATION=1 npm test  # includes isolated local database regression tests
npm run build       # TypeScript verification and production UI build
npm start           # serves built UI and API at http://127.0.0.1:4310
```

`Ctrl+C` stops the native app processes. Supabase data remains in its Docker volumes; use `cd app && supabase stop` to stop database services. See [database setup notes](app/LOCAL_DATABASE.md), including the observed Docker Desktop port-binding limitation.

## Accounts and workspace access

Open the app and create an email/password account (at least 12 characters). Each account receives an empty private workspace. Email confirmation is disabled for local testing; password-reset links go to Mailpit.

To become the first account administrator and claim the existing workspace, keep the app running and use a second terminal:

```sh
nvm use
npm run account:setup
```

Open the one-time local link printed by the command, then create your account or sign in. It expires after 30 minutes. The existing data is preserved and remains inaccessible to new signups until this step. The setup key is consumed once; subsequent signups never become administrators automatically. On a clean installation, this makes your personal workspace the initial administrator's workspace.

Under **Account & access**, owners can add an existing account as a manager by email or remove that access. Managers can operate an assigned workspace but cannot grant access themselves. Use the workspace selector to switch between your personal workspace and shared ones. Switching accounts or workspaces clears the previous screen and unsaved edits.

The installation administrator can list accounts and create accounts with an initial password. Administrative status does not grant access to other users' workspaces; that requires an explicit owner-granted membership. Normal users can also self-register. To test isolation on the same computer, use separate browser profiles or an incognito window—tabs in one browser profile share a login session.

Supabase Studio and Mailpit are shared local developer tools. RoleLoop account permissions do not restrict someone who can access those services directly or use Docker. This remains a trusted local testing environment, not an internet-facing deployment.

## Try both flows

1. Click **Load samples** to add clearly fictional opportunities. Sample data is additive and never overwrites your saved profile or preferences.
2. Open **My profile**. Add your identity and experience, or replace the legacy sample profile with your own facts. Only verified evidence contributes to matching and tailored experience bullets.
3. Set salary, working country, time zone, date window, essential coverage and total match thresholds in **Search preferences**. A zero-day window means today. Month windows use calendar months. Dates are evaluated in your selected time zone.
4. For the application flow, open the fictional **Northstar Tools** job. Inspect its evidence matrix, prepare a draft, review résumé/answers/cover letter, approve, and run a local test. Download the résumé PDF or text.
5. For founder outreach, open **Orbit Notes** in **Startup prospects**, review its signals and contact, and prepare a founder email. Approve and run a local test, then inspect [Mailpit](http://127.0.0.1:54334).
6. Add real public company board identifiers in **Discovery sources** (Ashby, Greenhouse, Lever), or use the Show HN startup launch feed. Research leads, confirm missing company/location/contact facts, and review the results.

## What is implemented

- Supabase Auth login, signup, password reset, private workspaces, owner/manager memberships, account administration, and RLS-protected data and documents.
- Persistent local Supabase opportunity records, drafts, artifacts, activity and database-backed task queues scoped to each workspace.
- Public ATS-board imports, launch-feed startup discovery, manual opportunity entry and bounded public-website research.
- Source deduplication with refreshed source facts and preservation of explicit user corrections.
- Separate job requirement coverage and startup relevance indicators. An 85–90% job threshold is configurable; the app does not manufacture experience to reach it or claim an external ATS score.
- Salary floor/target, overlap/strict salary policy, undisclosed-pay handling, remote-country checks and inclusive posting-date windows. Unknown publication dates remain unknown. Older posts can be excluded or retained with lower freshness priority.
- Evidence-based résumé ordering, application answers, cover letters and founder email drafts. Optional local Ollama ranks existing evidence; it does not invent free-form career claims. Templates work without a model or API key.
- Explicit draft review; changes to profile, preferences, opportunity or text invalidate approval. Regeneration is required after source/profile/preference changes.
- PDF/text/JSON export, test EML files, private Supabase artifact storage, mock application receipts and emails captured by localhost Mailpit.
- Optional scheduled discovery while the local worker is running, automatic analysis and drafting of qualifying opportunities, a daily generated-draft limit, atomic queue deduplication and a single-worker lease.

## Testing boundary and current limits

This version does **not** submit applications to employers or deliver external email. Its only SMTP destination is the local test inbox, with a `.test` recipient. Application tests create local receipts. Real delivery adapters, provider-specific form automation, employer-site authentication/CAPTCHA handling and follow-up tracking are future work.

Show HN announcements are research leads, not proof of promising traction, US headquarters, open positions or founder identity. Company country, remote eligibility, compensation and contacts often need confirmation. Job-board imports read at most 100 listings per source per run; the launch feed reads at most 25. Requirement extraction is intentionally conservative and can miss unstructured requirements; review and edit the requirement list before trusting a match. The sidebar shows the latest 300 opportunities and drafts; activity shows the latest 60 events.

The API/UI bind to loopback and require verified user sessions for workspace operations. Ordinary database requests use the signed-in user’s identity and row-level policies. Service credentials are reserved for trusted worker/admin operations and never enter the browser bundle. The database's Docker-published ports may bind beyond localhost on Docker Desktop despite the requested network setting; `doctor` reports the observed state. Use a trusted development environment until this is addressed.

## Project layout

```text
app/src/ui/          React interface and styles
app/src/domain/      matching rules, truthful templates, fixtures, public sources
app/src/server/      Fastify API, Supabase persistence, worker, exports and local model
app/src/shared/      Zod contracts and generated database types
app/scripts/         native development runner, setup and diagnostics
app/supabase/        local service configuration and SQL migrations
app/tests/           offline regressions
```

The previous Python implementation is preserved. It is not used by the TypeScript application and its SQLite data is not automatically migrated. Its original documentation is in [the legacy guide](docs/LEGACY_PYTHON.md).

[Published process visualization](https://roleloop-process.maltedridge.chatgpt.site) — the supplied HTML was published unchanged as an account-private Sites project. The app itself stays local.
