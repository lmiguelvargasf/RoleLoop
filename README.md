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

Open the app and create an email/password account (at least 12 characters), or sign in to an existing account. Your private workspace opens automatically so you can upload your résumé and start finding opportunities. No workspace claim or terminal setup is required. Email confirmation is disabled for local testing; password-reset links go to Mailpit.

**Optional installation administration and legacy data recovery:** only the person operating this local installation needs this command, if they want to become its first account administrator or recover a workspace created before accounts were introduced. Keep the app running and use a second terminal:

```sh
nvm use
npm run account:setup
```

Open the one-time local link printed by the command, then create your account or sign in. The link expires after 30 minutes and completes setup automatically after sign-in. Existing legacy data is preserved and remains inaccessible to new signups until the installation operator completes this optional step. The setup key is consumed once; normal signups never become administrators automatically. On a clean installation, setup grants administrator status to your account while keeping its personal workspace.

Under **Account**, manage your password, AI connection and workspace name. Workspaces are personal: only their owner can access the résumé, opportunities and drafts. Earlier manager memberships no longer grant access; existing workspace data is preserved. Switching accounts clears the previous screen and unsaved edits.

The installation administrator can list accounts and create accounts with an initial password. Administrative status does not grant access to other users' workspaces. Normal users can also self-register. To test isolation on the same computer, use separate browser profiles or an incognito window—tabs in one browser profile share a login session.

Supabase Studio and Mailpit are shared local developer tools. RoleLoop account permissions do not restrict someone who can access those services directly or use Docker. This remains a trusted local testing environment, not an internet-facing deployment.

## Get started

1. Open **Resume** and upload a text-based PDF or Word (.docx) CV up to 2 MB. Review searchable records for experience, projects, education, certifications, listed skills and languages. Expand a record to inspect its original statements and source passage. Preview or download the original, and replace it to correct career information. Resume evidence becomes available for matching when extraction finishes; new drafts require a ready extraction.
2. Set your target roles, salary, working country, search dates and matching preference in **Search preferences**. **Find new companies automatically** controls whether job searches look for additional employers; an existing paused preference is preserved. Working country is used for remote eligibility and location details in drafts. Dates follow your computer’s timezone automatically.
3. Click **Search jobs** in **Job opportunities**, then review results on the same screen. RoleLoop manages company boards and feeds internally. When **Find new companies automatically** is enabled, it finds employers using your target roles and working country, checks their careers pages, and connects up to five supported boards with relevant openings. New accounts start with nine researched employer boards and Jobicy; existing source choices are preserved. Search progress appears with the results, while **Activity** holds run history and errors.
4. Review **Potential matches** against your working country, salary floor and actual experience. Unrelated and excluded roles remain accessible through **All active opportunities**, **Excluded by preferences** and application-status filters. Use **Add role** to paste a description or **Read job page** to capture a readable public page. Its optional **Browse job sites** disclosure links to sites you can search manually. Requirements are extracted automatically unless you supply an override. Optional details stay collapsed until needed. Pages requiring login or JavaScript may need pasted text.
5. Prepare and review a draft, download it, and use **Open listing / apply** to apply on the employer or source site. Save **Applied** in Application progress; set a next action, follow-up date and recruiter notes. Update to Interview, Offer, Rejected or Withdrawn as the process advances. Application progress survives listing refreshes, and recorded interview/offer milestones remain available after rejection.
6. Use the status filters, follow-up count and **Results by source** to review outcomes. Counts cover the currently loaded opportunities (up to 300), not lifetime totals. A job match percentage describes the extracted requirements and is not a probability of an interview. Company country, hiring eligibility and compensation remain separate checks.

Screenshots from isolated demonstration accounts: [job opportunities](docs/screenshots/roleloop-discovered-jobs.png), [startup prospects](docs/screenshots/roleloop-startup-research.png), [job capture](docs/screenshots/roleloop-job-capture.png), [application tracking](docs/screenshots/roleloop-application-tracking.png). No real application was submitted for these examples.

## How search is organized

**Search preferences** defines the search criteria and whether to find new companies automatically. **Job opportunities** contains **Search jobs**, search progress and job results. **Startup prospects** contains **Find startup leads**, which starts startup research directly and shows the resulting prospects. If no startup feed is configured, RoleLoop uses its built-in Show HN feed. **Activity** contains run history, employer-discovery warnings and source errors. There is no separate Discovery screen or source-management interface.

In **Add role**, the optional **Browse job sites** disclosure contains manual links to LinkedIn, Wellfound, YC Jobs and We Work Remotely. These links never enter the automated source queue. Bring an original listing back through its URL or pasted text.

Company boards and feeds are maintained internally. Ashby, Greenhouse and Lever host individual employers’ boards; connecting one board does not search every employer using that platform. The board for Ashby itself contains openings at Ashby, while its customers have separate boards. Job feeds and manual browsing sites cover multiple employers.

Automatic employer discovery uses the public [Himalayas search API](https://himalayas.app/api) and [company-details tool](https://github.com/Himalayas-App/himalayas-mcp) to identify employers and their websites. Only role and working-country queries are sent; no resume or contact information is sent. The worker follows observed careers links and checks supported boards; it never guesses board identifiers. Himalayas job descriptions and application links are not imported or republished by this workflow: every saved opening comes independently from the employer’s ATS. Company provenance is retained with the internal connection records.

For a dedicated REST API allowance, create a free key from the [Himalayas API page](https://himalayas.app/api), set `HIMALAYAS_API_KEY` in the ignored `app/.env.local`, and restart the API and worker. The key stays on the server and is sent only to Himalayas REST API endpoints, never to company websites, ATS boards or the separate company-details MCP service. Without a key, discovery still uses the shared public allowance. As documented on 6 November 2026, free keys allow 60 requests per minute and 10,000 per day per account; responses served from Himalayas' cache do not count. MCP limits are separate. Existing successful discovery data remains cached; adding or replacing a key retries previously failed directory requests.

Expansion checks up to three target roles, two search pages per role, and twelve employer websites/boards per run, connecting at most five companies within the existing 50-source limit. Searches prioritize higher advertised pay when a salary floor is set, otherwise recent listings. Directory search metadata is cached daily and website/board metadata for seven days; failures back off for an hour. Cached unsupported boards do not consume the next run’s research budget, allowing later employers to be checked. Openings are read live and checked against current role, location, salary and date preferences. Explicit salary figures in titles or compensation sections supplement missing structured pay; unspecified periods remain unknown and OTE is not treated as base pay. Unknown headquarters, hiring eligibility or pay remain review items. Inaccessible and unsupported careers sites are skipped and reported; enabled sources still run if employer discovery is unavailable. Single-company searches and startup research do not expand employers.

Hiring-country restrictions take precedence over broad remote labels. For example, a Brazil-only opening is excluded for someone working from Ecuador even if it also says LATAM or worldwide. Country lists, exclusions and residence requirements are checked separately from company headquarters and timezone mentions; ambiguous restrictions require review. Existing assessments are rechecked locally after eligibility-rule updates while retaining prior experience matching and application history. Draft approval and testing also recheck location restrictions.

Sources are shared across workspaces: `discovery_sources` stores each company board or feed once, and `workspace_sources` links it to each workspace. A link keeps that workspace’s enabled state, custom label, feed keyword, company relationship and discovery provenance. Jobicy and Show HN each have one shared catalog entry; their keyword filters stay workspace-specific. `companies` retains private workspace company facts. `opportunities` stores individual jobs or startup prospects with workspace-scoped foreign keys to the company and source connection. Jobs retain their source text and application history if a source is removed. Manual entry can reuse a known company. Identical names from unrelated providers are not automatically merged.

The migrations move existing source settings out of `workspace.payload.sources` into these tables without resetting data or changing existing source IDs. The workspace API returns a joined `sources` list and revision; each source retains its workspace connection `id` and exposes the shared `catalogId`. Removing a workspace link does not delete the catalog source or another workspace’s link. Source edits check that revision, while the worker appends new connections atomically. Stale source writes cannot delete newly discovered companies. Existing paused companies remain paused until explicitly resumed, and previously removed companies retain their automatic-reconnection exclusions. Disabling employer discovery leaves enabled-company searches and application drafts intact. Each table is protected by workspace access rules.

In Supabase Studio, inspect **public.discovery_sources** for the shared catalog and **public.workspace_sources** for workspace subscriptions (`source_id` links to the catalog). Catalog records contain only connector identity, not workspace labels or preferences. App accounts can read catalog records linked to their accessible workspaces; catalog and subscription writes use the validated server paths.

Scheduled discovery defaults to jobs. Startup research is started explicitly with **Find startup leads** in **Startup prospects**. Queue deduplication distinguishes the two purposes.

## Discovery source research

The source library was researched and its nine employer connectors fully imported on **6 November 2026**. These are working sources with official US company references and remote openings across professions; a board check does not establish a candidate’s eligibility or predict an offer. Counts are a dated snapshot, including roles with country restrictions and possible onsite requirements.

| Employer | Connection | Listings at check | Official careers |
| --- | --- | ---: | --- |
| GitLab | Greenhouse | 245 | https://about.gitlab.com/jobs/ |
| Mozilla | Greenhouse | 113 | https://www.mozilla.org/en-US/careers/ |
| Automattic | Greenhouse | 11 | https://automattic.com/work-with-us/jobs/ |
| Buffer | Ashby | 2 | https://buffer.com/journey |
| Zapier | Ashby | 10 | https://zapier.com/jobs |
| Ashby | Ashby | 74 | https://www.ashbyhq.com/careers |
| Linear | Ashby | 32 | https://linear.app/careers |
| Kraken | Ashby | 89 | https://www.kraken.com/careers |
| Superside | Lever | 14 | https://careers.superside.com/ |

Company-country reference links, coverage notes, board identifiers and check dates are maintained internally in `app/src/shared/discovery.ts`. The source directory and its configuration stay out of the user interface. Ashby board identifiers can contain dots (Kraken uses `kraken.com`). Oversized descriptions are imported as bounded excerpts with an explicit review flag; they cannot automatically qualify for drafting.

[Jobicy](https://jobicy.com/jobs-rss-feed) adds a seven-day remote feed with hourly shared caching; employer country stays unverified. [We Work Remotely](https://weworkremotely.com/), [Wellfound](https://wellfound.com/jobs), [YC Work at a Startup](https://www.ycombinator.com/jobs) and [LinkedIn Jobs](https://www.linkedin.com/jobs/) are available under **Add role → Browse job sites** as manual research links. Their listings are brought into Add role using the employer URL or pasted text; these links are not automatic integrations.

Older board URLs that failed or returned no jobs were excluded, including the empty Automattic `automatticjobs` board and Deel’s old Ashby feed. The functioning Automattic board is `automatticcareers`. Source selection is intentionally bounded. Source maintenance stays internal, and hiring-country and compensation checks remain independent of employer location.

## Résumé AI

For local subscription usage, open **Account → ChatGPT → Continue with ChatGPT**. Sign in using an eligible Plus or Pro account and approve ChatGPT plan usage. Return to RoleLoop, refresh the available models, and select a model. The selected account powers CV imports and opportunity evaluations you initiate, including queued tasks. Under **Connection settings**, **Manage usage** opens ChatGPT's usage controls and **Disconnect** revokes the renewable session and clears local tokens. Multiple ChatGPT accounts can be connected and selected separately.

Connections are private to each RoleLoop user and stored with owner-only filesystem permissions under `app/.local/chatgpt/`. A stable host ID and issued client registrations are retained for reconnects; credentials never enter the frontend, database, or Git. Tokens refresh automatically. Sign-in alone does not enable inference unless the user grants plan usage permission. Failed or disconnected subscription requests never silently switch to API billing. Background schedules use only the server's API configuration.

Alternatively, configure `OPENAI_API_KEY` on the server and choose **Use API billing** when switching from a subscription. `OPENAI_MODEL` defaults to `gpt-4o-mini` for API billing; subscription models come from the connected account. OpenAI is the only AI provider. Requests use structured outputs with response storage disabled; résumé text and cached career facts are sent to OpenAI. Subscription responses stream and require a completed terminal event. Template drafting remains available without AI.

This connection follows [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for personal local projects and eligible open-source tools. Offering it in a paid or remotely hosted product requires OpenAI approval.

Import supports readable PDF and `.docx`, with a 2 MB file limit, a 30-page PDF limit and a 60,000-character text limit. Scanned or encrypted PDFs need to be exported as readable text first. Embedded PDF and Word hyperlinks are included as bounded source context without opening the linked pages. Extraction v2 organizes career records around positions, projects and credentials, with individually traceable statements beneath each record. Titles, organizations and dates must appear in that record's source passage; skill tags must appear in their supporting statement. The AI selects numbered source lines instead of copying the resume into its response twice. The server reconstructs quotations directly from those lines, preserving source spelling and exact text offsets. Document instructions are treated as untrusted input. Missing information stays blank, and uncertain or omitted details appear in extraction notes. Years of experience and proficiency are not inferred. Traceability means a statement occurs in the CV; it does not independently verify that the claim is true or that its interpretation is correct.

Standalone skills and language claims remain separate from demonstrated experience. They can support a partial match, but cannot by themselves establish a fully matched requirement or satisfy a mandatory condition. Opportunity evaluation cites cached statements and can assess transferable experience; salary, country and mandatory-condition checks remain separate. If AI evaluation fails, the app marks the result for review and explains that it used skill tags. Headlines, summaries and selected experience are composed per role and company without repeating extraction. Drafts label listed skills and languages separately from career highlights.

Each derived cache carries its source ID and extractor version. Replacing the resume clears old facts before extraction; failed, outdated or mismatched caches cannot supply matching or drafting facts. **Clear extracted details** resets the cache while preserving the original resume, existing drafts and history. **Extract career details** rebuilds from that original; **Retry extraction** recovers from a failed or interrupted attempt. Concurrent uploads, retries and resets use compare-and-swap updates so an older result cannot overwrite the current state. Extraction has a five-minute AI deadline. The stream reader collects completed output items and accepts them only after the response reports successful completion, including when the final event omits the output text. Repeated retry clicks reuse an active attempt; an expired or interrupted attempt can be retried from its saved original. Service timeouts are distinguished from unreadable documents, with no automatic request retries or billing fallback. The v2 migration invalidates v1 caches without deleting originals; re-extraction is explicit.

The workspace owner's account supplies the contact email. Stored profiles contain only the current source reference and its derived cache; search preferences and opportunity assessments are separate. Existing drafts remain downloadable, but freshness checks require regeneration before approval after source or fact changes. Uploaded formatting is replaced by the app's PDF layout. See [the architecture notes](app/ARCHITECTURE.md) for the extraction contract and extension points.

## What is implemented

- A single job-matching minimum for required qualifications, backed by source-supported career evidence. Preferred qualifications affect ranking only. Salary, location and mandatory conditions remain separate checks; lowering the match minimum does not bypass them. Saved required minimums are preserved; the legacy overall minimum is ignored.
- Supabase Auth login, signup, password reset, personal workspaces with owner-only access, account administration, and RLS-protected data and documents.
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

Show HN announcements are research leads, not proof of promising traction, US headquarters, open positions or founder identity. Company country, remote eligibility, compensation and contacts often need confirmation. Ashby and Greenhouse imports process the returned board; Lever follows up to ten 100-job pages. Jobicy follows up to ten 100-job pages from its seven-day feed and shares an installation-wide cache refreshed at most hourly, including after failed requests; keyword and target-role filtering happen locally. Feed absence is not treated as proof a role closed. Its source link and attribution remain visible. The launch feed reads at most 25. Successful AI assessments of unchanged listings are reused for up to a day when the resume, preferences and requester are unchanged. Known exclusions and unrelated titles use inexpensive checks first; eligible drafts are allocated in ranking order across sources. Requirement extraction is intentionally conservative and can miss unstructured requirements; review and edit the requirement list before trusting a match. The sidebar shows the latest 300 opportunities and drafts; activity shows the latest 60 events.

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
