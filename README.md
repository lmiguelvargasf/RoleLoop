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

During development, the API and worker restart automatically when their code or imported shared schemas change. Restart `npm start` after updating production code.

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

## Get started

1. Open **My profile** and upload a text-based PDF or Word (.docx) master CV up to 2 MB. The original is stored privately, and source-supported career facts are extracted once into a reusable cache. Preview or download the current CV from this page. Replace the CV to change your career information; matching and new drafts wait for the replacement's cache to finish. Processing errors retain the original and offer a retry.
2. Set your salary, working country, search dates and matching preference in **Search preferences**. Working country is used for remote eligibility and location details in drafts. Dates follow your computer’s timezone automatically.
3. Add public company board identifiers in **Discovery sources**, use the Show HN startup feed, or add opportunities manually.
4. Review opportunities, prepare your application or founder email, and download the drafts.

## Résumé AI

For local subscription usage, open **Account & access → AI connection → Continue with ChatGPT**. Sign in using an eligible Plus or Pro account and approve ChatGPT plan usage. Return to RoleLoop, refresh the available models, and select a model. The selected account powers CV imports and opportunity evaluations you initiate, including queued tasks. **Manage usage** opens ChatGPT's usage controls; **Disconnect** revokes the renewable session and clears local tokens. Multiple ChatGPT accounts can be connected and selected separately.

Connections are private to each RoleLoop user and stored with owner-only filesystem permissions under `app/.local/chatgpt/`. A stable host ID and issued client registrations are retained for reconnects; credentials never enter the frontend, database, or Git. Tokens refresh automatically. Sign-in alone does not enable inference unless the user grants plan usage permission. Failed or disconnected subscription requests never silently switch to API billing. Background schedules use only the server's API configuration.

Alternatively, configure `OPENAI_API_KEY` on the server and choose **Use API billing** when switching from a subscription. `OPENAI_MODEL` defaults to `gpt-4o-mini` for API billing; subscription models come from the connected account. OpenAI is the only AI provider. Requests use structured outputs with response storage disabled; résumé text and cached career facts are sent to OpenAI. Subscription responses stream and require a completed terminal event. Template drafting remains available without AI.

This connection follows [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for personal local projects and eligible open-source tools. Offering it in a paid or remotely hosted product requires OpenAI approval.

Import supports readable PDF and `.docx`, with a 2 MB file limit, a 30-page PDF limit and a 60,000-character text limit. Scanned or encrypted PDFs need to be exported as readable text first. AI extraction keeps only traceable quotations and source-supported metadata and skill tags, and records processing notes for uncertain details. Experience, projects, education and certifications are derived from the CV; there is no separate career-information form. Each cache carries its CV source ID and extractor version. Replacements clear old facts before extraction; failed, outdated or mismatched caches cannot supply matching or drafting facts. Late results from an older upload cannot overwrite a newer CV. If processing is interrupted, **Retry processing** rebuilds from the stored original. Existing CVs from before this change can be processed once with **Process CV**.

Opportunity evaluation can assess transferable experience with references to cached CV quotations. Salary, country and mandatory-condition checks still apply. If AI evaluation fails, the app marks the result for review and explains that it used skill tags. Headlines, summaries and selected experience are composed per role and company from the cached facts; extraction is not repeated for each application. The workspace owner’s account supplies the contact email; it is not duplicated in the profile database. Stored profiles contain only the current CV reference and its derived cache. The migration removes obsolete editable profile fields, while preserving application documents, artifacts, activity and private original files. Existing drafts remain downloadable; freshness checks require regeneration before approval after a CV change. Skills remain attached to the quotations that support them. Uploaded formatting is replaced by the app’s clean PDF layout.

## What is implemented

- A single job-matching minimum for required qualifications, backed by verified experience. Preferred qualifications affect ranking only. Salary, location and mandatory conditions remain separate checks; lowering the match minimum does not bypass them. Saved required minimums are preserved; the legacy overall minimum is ignored.
- Supabase Auth login, signup, password reset, private workspaces, owner/manager memberships, account administration, and RLS-protected data and documents.
- Persistent local Supabase opportunity records, drafts, artifacts, activity and database-backed task queues scoped to each workspace.
- Public ATS-board imports, launch-feed startup discovery, manual opportunity entry and bounded public-website research.
- Source deduplication with refreshed source facts and preservation of explicit user corrections.
- Separate job required-qualification coverage and startup relevance indicators. The app does not manufacture experience to reach a threshold or claim an external ATS score.
- Salary minimum with no upper limit, an optional target for application answers, overlap/strict salary policy, and optional 10% flexibility for benefits or perks. Flexibility defaults off; jobs qualifying only through the lower threshold always require review. Jobs with undisclosed salaries can be kept for review or excluded. Remote-country checks and inclusive posting-date windows are configurable. Unknown publication dates remain unknown. Older posts can be excluded or retained with lower freshness priority.
- Curated industry interests with consistent icons and three levels: No boost, Interested, and Top priority. Choose explicitly between no industry preference and prioritizing selected industries. Interested adds 5 ranking points and Top priority adds 10 (the strongest match wins; bonuses never stack), within the existing readiness and freshness groups for both jobs and startup prospects. Stronger general fits can still rank higher; all industries remain eligible and evidence scores stay independent. Priorities can be paused without losing selections. Industry matches use listing keywords, not verified company classifications; older saved interests remain editable.
- Evidence-based résumé ordering, application answers, cover letters and founder email drafts. OpenAI selects relevant cached CV facts; templates render only the supplied source quotations. Template drafts remain available without an API key.
- Draft review and editing; regeneration is required after source, profile or preference changes.
- PDF/text/JSON export and private Supabase artifact storage.
- Optional scheduled discovery while the local worker is running, automatic analysis and drafting of qualifying opportunities, a daily generated-draft limit, atomic queue deduplication and a single-worker lease.

## Testing boundary and current limits

This version does **not** submit applications to employers or deliver external email. Delivery actions are unavailable. Real delivery adapters, provider-specific form automation, employer-site authentication/CAPTCHA handling and follow-up tracking are future work.

Show HN announcements are research leads, not proof of promising traction, US headquarters, open positions or founder identity. Company country, remote eligibility, compensation and contacts often need confirmation. Job-board imports read at most 100 listings per source per run; the launch feed reads at most 25. Requirement extraction is intentionally conservative and can miss unstructured requirements; review and edit the requirement list before trusting a match. The sidebar shows the latest 300 opportunities and drafts; activity shows the latest 60 events.

The API/UI bind to loopback and require verified user sessions for workspace operations. Ordinary database requests use the signed-in user’s identity and row-level policies. Service credentials are reserved for trusted worker/admin operations and never enter the browser bundle. The database's Docker-published ports may bind beyond localhost on Docker Desktop despite the requested network setting; `doctor` reports the observed state. Use a trusted development environment until this is addressed.

## Project layout

```text
app/src/ui/          React interface and styles
app/src/domain/      matching rules, truthful templates, public sources
app/src/server/      Fastify API, Supabase persistence, worker, exports and local model
app/src/shared/      Zod contracts and generated database types
app/scripts/         native development runner, setup and diagnostics
app/supabase/        local service configuration and SQL migrations
app/tests/           offline regressions
```

The previous Python implementation is preserved. It is not used by the TypeScript application and its SQLite data is not automatically migrated. Its original documentation is in [the legacy guide](docs/LEGACY_PYTHON.md).

[Published process visualization](https://roleloop-process.maltedridge.chatgpt.site) — the supplied HTML was published unchanged as an account-private Sites project. The app itself stays local.
