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

Under **Account**, manage your password and AI connection. Workspaces are personal: only their owner can access the résumé, opportunities and drafts. Earlier manager memberships no longer grant access; existing workspace data is preserved. Switching accounts clears the previous screen and unsaved edits.

The installation administrator can list accounts and create accounts with an initial password. Administrative status does not grant access to other users' workspaces. Normal users can also self-register. To test isolation on the same computer, use separate browser profiles or an incognito window—tabs in one browser profile share a login session.

Supabase Studio and Mailpit are shared local developer tools. RoleLoop account permissions do not restrict someone who can access those services directly or use Docker. This remains a trusted local testing environment, not an internet-facing deployment.

## Get started

**Today** is the daily starting point. It brings together active conversations,
interview preparation, due follow-ups, referral introductions, selected
applications and five recommended opportunities. Its seven-day counters use your
local calendar and recorded submission, reply, interview and offer milestones;
closed and archived records retain their outcomes. Record a human reply in
Application progress to distinguish it from an automatic acknowledgement.

Today prioritizes qualified jobs posted within seven days, then eight to fourteen
days, then older and undated listings, retaining fit order within each group.
Source update dates are labeled separately and never treated as original posting
dates. Identical company/title/description listings share one Today suggestion;
tracking one suppresses its identical siblings there without merging or deleting
the saved records. The full Job opportunities view remains ranked by fit.

1. Open **Resume** and upload a text-based PDF or Word (.docx) CV up to 2 MB. Review searchable records for experience, projects, education, certifications, listed skills and languages. Expand a record to inspect its original statements and source passage. Preview or download the original, and replace it to correct career information. Resume evidence becomes available for matching when extraction finishes; new drafts require a ready extraction.
2. Set your target roles, salary, working country, search dates and matching preference in **Search preferences**. **Find new companies automatically** controls whether job searches look for additional employers; an existing paused preference is preserved. Working country is used for remote eligibility and location details in drafts. Dates follow your computer’s timezone automatically.
3. Click **Search jobs** in **Job opportunities**, then review results on the same screen. RoleLoop manages company boards and feeds internally. When **Find new companies automatically** is enabled, it finds employers using your target roles and working country, checks their careers pages, and connects up to five supported boards with relevant openings. New accounts start with nine researched employer boards, Jobicy, We Work Remotely and Himalayas; existing source choices are preserved. Search progress appears with the results, while **Activity** holds run history and errors.
4. Review **Recommended** for the strongest practical fits first. Job details puts salary, location and hiring eligibility first. Requirements opens on **To check** when some qualifications need attention; **All required** shows the full list. Open a requirement for its explanation and supporting resume evidence. Preferred qualifications stay collapsed, and **View job posting** opens the original description. Use **Applications** to track selected jobs and **All saved** to browse the full collection, including roles outside your preferences. Job discovery imports listings and extracts requirements automatically. Job details are read-only in both Job opportunities and Applications; archive or restore jobs and update application progress and notes without changing the listing. Previously saved listings also recover missing published salary on load, preserving earlier corrections.
5. Select one or more jobs and choose **Add to applications**. They enter **To apply** on the separate **Applications** board. Drag cards through **Applied**, **Interview**, **Offer**, or **Closed**, or open a card to change its status. Closed keeps Rejected and Withdrawn distinct. Use **Prepare application** on a **To apply** card when you want documents; the card shows progress, a retry after failure, or **Review application** when ready. The refresh icon prepares a new version. Open a card for the employer listing, notes, next actions and follow-up dates. After submitting through the employer, move the card to **Applied**. Adding or moving a card only updates tracking; it does not prepare documents or submit an application. Archived jobs cannot prepare new documents. Recorded interview/offer milestones survive later outcomes and source refreshes.
6. Use the board’s follow-up filter and **Activity → Results by source** to review outcomes. Source counts cover all jobs currently saved in the workspace, not lifetime discovery totals. A job match percentage describes the extracted requirements and is not a probability of an interview. Company country, hiring eligibility and compensation remain separate checks.
7. Use **Search startups** in **Startup prospects** to discover and research companies. **To explore** shows companies you have not added to outreach; **All saved** includes those already tracked, and **Archived** keeps companies you set aside. Both browsing pages support searching saved results by company, title and skills. Filter by source or search company details, then open a company to see what it does, its listed industry or inferred industry signals, source highlights, and potential contribution from your CV. Company facts are read-only and come from discovery and website research; use **Research & evaluate** to refresh them. Outreach notes and progress remain editable. The list shows product summaries and source signals; detailed checks stay under **Before outreach**. Select prospects and choose **Add to outreach** to track them separately in **Startup outreach**. They enter **To contact**, followed by **Contacted**, **In conversation**, and **Closed**. Prepare an outreach draft explicitly from a To contact card, review it, and contact the company yourself before updating its status. Open a card to record the next action, follow-up date and notes. Closed records whether an opportunity opened, the company was not interested, there was no response, or you stopped pursuing it. Discovery and board moves never generate or send outreach automatically.

Screenshots from isolated demonstration accounts: [job opportunities](docs/screenshots/roleloop-discovered-jobs.png), [startup prospects](docs/screenshots/roleloop-startup-research.png), [application tracking](docs/screenshots/roleloop-application-tracking.png). No real application was submitted for these examples.

Application documents include copying individual sections, the original
application link and progress tracking in one place. After you submit externally,
**Mark as submitted** records the submission and suggests a follow-up seven days
later, preserving an existing date and next action. Contact name/link, referral
progress, channel, first human reply and last-contact date stay with the job.
Concurrent source refreshes and closure checks cannot overwrite these updates.

Job rows show posting dates, explicit engagement type and weekly hours when stated.
Use **Work type** to distinguish full-time employment, contracts/part-time work,
and unspecified arrangements. Hourly rates are never annualized without agreed
hours, and an unspecified currency remains unconfirmed. Similar-listing notices
help avoid applying twice while preserving distinct requisition IDs.

## How search is organized

**Search preferences** defines the search criteria and whether to find new companies automatically. **Job opportunities** contains **Search jobs**, search progress and job results. **Startup prospects** contains **Search startups**, which starts startup research directly and shows the resulting prospects. RoleLoop provides built-in Show HN and Seedcamp sources while respecting configured keywords and pauses. **Startup outreach** tracks only the companies you choose to contact. **Activity** contains run history, employer-discovery warnings and source errors. There is no separate Discovery screen or source-management interface.

**Search jobs** is the entry point for finding roles. Enable **Check for new opportunities automatically** in **Search preferences** to run searches on a schedule. Jobs are discovered and evaluated against your preferences and resume; no manual job entry is needed.

Company boards and feeds are maintained internally. Ashby, Greenhouse and Lever host individual employers’ boards; connecting one board does not search every employer using that platform. The board for Ashby itself contains openings at Ashby, while its customers have separate boards. Job feeds cover multiple employers.

Automatic employer discovery uses the public [Himalayas search API](https://himalayas.app/api) and [company-details tool](https://github.com/Himalayas-App/himalayas-mcp) to identify employers and their websites. Only role and working-country queries are sent; no resume or contact information is sent. The worker follows observed careers links and checks supported boards; it never guesses board identifiers. Company provenance is retained with the internal connection records.

The separate **Himalayas** job feed also imports matching listings directly, including employers whose careers platforms are unsupported. It checks up to three rotating target roles and two pages per role, shares public query results for a day, preserves original application links, and displays source attribution. Its update timestamp is shown separately from a posting date; missing currency or pay period stays unknown. Country and time-zone restrictions remain explicit eligibility checks. Expired feed listings leave discovery while application history remains available. Each enabled feed search also checks a rotating group of up to twenty saved Himalayas jobs for early closure, sharing status results for ten minutes; only an explicit closure response marks a job closed, and missing search results never do. Failed status checks appear in Activity and make the run partial. New accounts include this feed; the migration adds it only to existing workspaces with automatic discovery enabled, an active job source and available source capacity, preserving paused choices.

For a dedicated REST API allowance, create a free key from the [Himalayas API page](https://himalayas.app/api), set `HIMALAYAS_API_KEY` in the ignored `app/.env.local`, and restart the API and worker. The key stays on the server and is sent only to Himalayas REST API endpoints, never to company websites, ATS boards or the separate company-details MCP service. Without a key, discovery still uses the shared public allowance. As documented on 6 November 2026, free keys allow 60 requests per minute and 10,000 per day per account; responses served from Himalayas' cache do not count. MCP limits are separate. Existing successful discovery data remains cached; adding or replacing a key retries previously failed directory requests.

Expansion checks up to three target roles (rotated across searches), interleaves employers from those roles, and uses two search pages per role and twelve employer websites/boards per run, connecting at most five companies within the existing 50-source limit. Searches prioritize higher advertised pay when a salary floor is set, otherwise recent listings. Directory search metadata is cached daily and website/board metadata for seven days; failures back off for an hour. Cached unsupported boards do not consume the next run’s research budget, allowing later employers to be checked. Openings are read live and checked against current role, location, salary and date preferences. Explicit salary figures in titles or compensation sections supplement missing structured pay; unspecified periods remain unknown and OTE is not treated as base pay. Unknown headquarters, hiring eligibility or pay remain review items. Inaccessible and unsupported careers sites are skipped and reported; enabled sources still run if employer discovery is unavailable. Single-company searches and startup research do not expand employers.

Hiring-country restrictions take precedence over broad remote labels. For example, India-only or Bangalore-based openings are outside an Ecuador search; explicit Ecuador, LATAM and worldwide remote hiring can qualify. The default **Recommended** view ranks relevant experience while keeping confirmed restrictions excluded. Unclear hiring coverage can appear with a prominent question and a ranking penalty; it is never treated as permission to work from your country. Confirmed mismatches remain accessible under **All saved**, with their exclusion reasons in job details. These checks use the selected working country, not a country blacklist. Employer offices, headquarters, global customers and timezone overlap do not prove remote hiring eligibility.

Job opportunities has three views: **Recommended**, **All saved**, and **Archived**. A single dropdown and job count sit directly above the list. The full saved collection is ranked before pagination; Recommended initially shows up to ten promising jobs, with Show more for the rest. Essential experience and role relevance outweigh freshness and industry preferences. Incomplete assessments display a label instead of a misleading percentage. Jobs already on the Applications board leave Recommended but remain in All saved. Selecting a row opens its details; checkboxes select several jobs to add to Applications. Changing views clears the selection. Source outcome statistics live under **Activity → Results by source**. The separate **Applications** board contains only jobs explicitly selected or previously tracked. It loads all tracked jobs; current matching preferences do not hide a job already being pursued. Archived jobs remain separate from the board and follow-ups.

Location and other hard preferences are checked before AI matching. Unresolved hiring locations remain review questions. Job searches evaluate fit but never prepare application documents automatically. Versioned job-fit instructions compare demonstrated capabilities and transferable experience, keep preferred skills separate from mandatory conditions, cite resume evidence and give concrete gaps and next actions. Existing assessments are rechecked locally after eligibility-rule updates while retaining prior experience matching and application history; the next eligible search refreshes outdated AI fit. Draft approval and testing also recheck location restrictions. The [detailed workflow diagram](app/ARCHITECTURE.md#country-aware-job-evaluation) describes the complete sequence.

Sources are shared across workspaces: `discovery_sources` stores each company board or feed once, and `workspace_sources` links it to each workspace. A link keeps that workspace’s enabled state, custom label, feed keyword, company relationship and discovery provenance. Jobicy, We Work Remotely and Show HN each have one shared catalog entry; their keyword filters stay workspace-specific. `companies` retains private workspace company facts. `opportunities` stores individual jobs or startup prospects with workspace-scoped foreign keys to the company and source connection. Jobs retain their source text and application history if a source is removed. Manual startup entry and startup edits can reuse a known company. Identical names from unrelated providers are not automatically merged.

The migrations move existing source settings out of `workspace.payload.sources` into these tables without resetting data or changing existing source IDs. The workspace API returns a joined `sources` list and revision; each source retains its workspace connection `id` and exposes the shared `catalogId`. Removing a workspace link does not delete the catalog source or another workspace’s link. Source edits check that revision, while the worker appends new connections atomically. Stale source writes cannot delete newly discovered companies. Existing paused companies remain paused until explicitly resumed, and previously removed companies retain their automatic-reconnection exclusions. Disabling employer discovery leaves enabled-company searches and application drafts intact. Each table is protected by workspace access rules.

In Supabase Studio, inspect **public.discovery_sources** for the shared catalog and **public.workspace_sources** for workspace subscriptions (`source_id` links to the catalog). Catalog records contain only connector identity, not workspace labels or preferences. App accounts can read catalog records linked to their accessible workspaces; catalog and subscription writes use the validated server paths.

Scheduled discovery defaults to jobs. Startup research is started explicitly with **Search startups** in **Startup prospects**. Queue deduplication distinguishes the two purposes.

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

[Jobicy](https://jobicy.com/jobs-rss-feed) adds a seven-day remote feed. [We Work Remotely](https://weworkremotely.com/remote-job-rss-feed) adds a public RSS feed with original-source attribution, hiring regions and explicit expiry dates. Both use hourly shared caching; employer headquarters stays unverified. The WWR migration preserves paused connections and adds the feed only to existing workspaces with automatic employer discovery enabled, an active job source and room below the source limit. Wellfound, YC Work at a Startup and LinkedIn Jobs are not automatic integrations.

The [7 November search audit](docs/SEARCH_AUDIT.md) records the algorithm, prompt and source findings, implemented fixes, verification and remaining coverage limits.

Startup prospects searches [Show HN](https://news.ycombinator.com/show) and [Seedcamp’s public company portfolio](https://seedcamp.com/our-companies/) without source setup. Show HN supplies up to 25 dated product announcements; Seedcamp supplies up to 25 companies prioritized by industry interests and its listed investment year. Investment year is not treated as a launch date, and neither source establishes current hiring, headquarters or remote eligibility. Configured keywords and disabled sources remain respected; pausing all configured startup feeds pauses startup research.

Each search researches up to ten eligible company websites across both sources, prioritizing prospects that still need research. Successful website research is reused for seven days and failures back off for one hour; explicit **Research & evaluate** refreshes immediately. A company’s canonical website identifies one prospect, with source announcements retained separately. Personal corrections, archives and outreach history survive refreshes. Historical duplicate records are retained to preserve their independent history.

Startup cards show a possible contribution grounded in cited CV experience instead of a percentage. Without AI or sufficient experience, the explanation remains an unconfirmed connection to explore. Discovery saves findings without preparing drafts or adding companies to outreach. **Add to outreach** starts tracking explicitly; **Prepare outreach** on a To contact card generates a draft within the daily limit. Existing drafts remain available for review. Outreach status and recorded contact/conversation milestones survive research, rediscovery and later closure; archived startups keep their history outside the active board. The YC directory remains a manual browsing link: [YC’s terms](https://www.ycombinator.com/legal/) and [Techstars’ terms](https://www.techstars.com/terms-of-use) restrict automated extraction, so neither directory is an automatic connector.

Older board URLs that failed or returned no jobs were excluded, including the empty Automattic `automatticjobs` board and Deel’s old Ashby feed. The functioning Automattic board is `automatticcareers`. Source selection is intentionally bounded. Source maintenance stays internal, and hiring-country and compensation checks remain independent of employer location.

## Résumé AI

For local subscription usage, open **Account → ChatGPT → Continue with ChatGPT**. Sign in using an eligible Plus or Pro account and approve ChatGPT plan usage. Return to RoleLoop and choose a model from the automatically loaded list. The selected account powers CV imports and opportunity evaluations you initiate, including queued tasks. **Manage usage** opens ChatGPT's usage controls. **Disconnect** revokes the renewable session and clears local tokens. To use a different ChatGPT account, disconnect and sign in again.

Connections are private to each RoleLoop user and stored with owner-only filesystem permissions under `app/.local/chatgpt/`. A stable host ID and issued client registrations are retained for reconnects; credentials never enter the frontend, database, or Git. Tokens refresh automatically. Sign-in alone does not enable inference unless the user grants plan usage permission. Failed or disconnected subscription requests never silently switch to API billing. Background schedules use only the server's API configuration.

Alternatively, configure `OPENAI_API_KEY` on the server and choose **Use API billing** when switching from a subscription. `OPENAI_MODEL` defaults to `gpt-4o-mini` for API billing; subscription models come from the connected account. OpenAI is the only AI provider. Requests use structured outputs with response storage disabled; résumé text and cached career facts are sent to OpenAI. Subscription responses stream and require a completed terminal event. Template drafting remains available without AI.

This connection follows [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for personal local projects and eligible open-source tools. Offering it in a paid or remotely hosted product requires OpenAI approval.

Import supports readable PDF and `.docx`, with a 2 MB file limit, a 30-page PDF limit and a 60,000-character text limit. Scanned or encrypted PDFs need to be exported as readable text first. Embedded PDF and Word hyperlinks are included as bounded source context without opening the linked pages. Extraction v2 organizes career records around positions, projects and credentials, with individually traceable statements beneath each record. Titles, organizations and dates must appear in that record's source passage; skill tags must appear in their supporting statement. The AI selects numbered source lines instead of copying the resume into its response twice. The server reconstructs quotations directly from those lines, preserving source spelling and exact text offsets. Document instructions are treated as untrusted input. Missing information stays blank, and uncertain or omitted details appear in extraction notes. Years of experience and proficiency are not inferred. Traceability means a statement occurs in the CV; it does not independently verify that the claim is true or that its interpretation is correct.

Standalone skills and language claims remain separate from demonstrated experience. They can support a partial match, but cannot by themselves establish a fully matched requirement or satisfy a mandatory condition. Opportunity evaluation cites cached statements and can assess transferable experience; salary, country and mandatory-condition checks remain separate. If AI evaluation fails, the app marks the result for review, explains that it used skill tags, and reports the search as partial with a separate failed-evaluation count. Skill-tag comparisons never display a complete match percentage. Headlines, summaries and selected experience are composed per role and company without repeating extraction. Drafts label listed skills and languages separately from career highlights.

Each derived cache carries its source ID and extractor version. Replacing the resume clears old facts before extraction; failed, outdated or mismatched caches cannot supply matching or drafting facts. **Clear extracted details** resets the cache while preserving the original resume, existing drafts and history. **Extract career details** rebuilds from that original; **Retry extraction** recovers from a failed or interrupted attempt. Concurrent uploads, retries and resets use compare-and-swap updates so an older result cannot overwrite the current state. Extraction has a five-minute AI deadline. The stream reader collects completed output items and accepts them only after the response reports successful completion, including when the final event omits the output text. Repeated retry clicks reuse an active attempt; an expired or interrupted attempt can be retried from its saved original. Service timeouts are distinguished from unreadable documents, with no automatic request retries or billing fallback. The v2 migration invalidates v1 caches without deleting originals; re-extraction is explicit.

The workspace owner's account supplies the contact email. Stored profiles contain only the current source reference and its derived cache; search preferences and opportunity assessments are separate. Existing drafts remain downloadable, but freshness checks require regeneration before approval after source or fact changes. Uploaded formatting is replaced by the app's PDF layout. See [the architecture notes](app/ARCHITECTURE.md) for the extraction contract and extension points.

## What is implemented

- A single job-matching minimum for required qualifications, backed by source-supported career evidence. Preferred qualifications affect ranking only. Salary, location and mandatory conditions remain separate checks; lowering the match minimum does not bypass them. Saved required minimums are preserved; the legacy overall minimum is ignored.
- Supabase Auth login, signup, password reset, personal workspaces with owner-only access, account administration, and RLS-protected data and documents.
- Persistent local Supabase opportunity records, drafts, artifacts, activity and database-backed task queues scoped to each workspace.
- Public ATS-board imports, launch-feed startup discovery, manual startup entry and bounded public-website research.
- Source deduplication with refreshed source facts and preservation of explicit user corrections.
- Separate job required-qualification coverage and startup relevance indicators. The app does not manufacture experience to reach a threshold or claim an external ATS score.
- Salary minimum with no upper limit, an optional target for application answers, overlap/strict salary policy, and optional 10% flexibility for benefits or perks. Flexibility defaults off; jobs qualifying only through the lower threshold always require review. Jobs with undisclosed salaries can be kept for review or excluded. Remote-country checks and inclusive posting-date windows are configurable. Unknown publication dates remain unknown. Older posts can be excluded or retained with lower freshness priority.
- Curated industry interests with consistent icons and three levels: No boost, Interested, and Top priority. Choose explicitly between no industry preference and prioritizing selected industries. Interested adds 5 ranking points and Top priority adds 10 (the strongest match wins; bonuses never stack), within the existing readiness and freshness groups for both jobs and startup prospects. Stronger general fits can still rank higher; all industries remain eligible and evidence scores stay independent. Priorities can be paused without losing selections. Industry matches use listing keywords, not verified company classifications; older saved interests remain editable.
- Evidence-based résumé ordering, application answers, cover letters and founder email drafts. OpenAI selects relevant cached CV facts; templates render only the supplied source quotations. Template drafts remain available without an API key.
- Draft review and editing; regeneration is required after source, profile or preference changes.
- PDF/text/JSON export and private Supabase artifact storage.
- Optional scheduled discovery while the local worker is running, automatic analysis, separate application and startup outreach boards with explicit draft preparation, follow-up dates and outcome tracking, a daily generated-draft limit, atomic queue deduplication and a single-worker lease.

## Testing boundary and current limits

This version does **not** submit applications to employers or deliver external email. Delivery actions are unavailable. Real delivery adapters, provider-specific form automation, employer-site authentication/CAPTCHA handling and automated follow-up delivery are future work.

Show HN announcements are research leads, not proof of promising traction, US headquarters, open positions or founder identity. Company country, remote eligibility, compensation and contacts often need confirmation. Ashby and Greenhouse imports process the returned board; Lever follows up to ten 100-job pages. Jobicy follows up to ten 100-job pages from its seven-day feed and shares an installation-wide cache refreshed at most hourly, including after failed requests; keyword and target-role filtering happen locally. Feed absence is not treated as proof a role closed. Explicit publisher expiry dates exclude saved jobs, and time-sensitive checks refresh locally without another AI call. Its source link and attribution remain visible. The launch feed reads at most 25. Successful AI assessments of unchanged listings are reused for up to a day when the resume, preferences and requester are unchanged. Known exclusions and unrelated titles use inexpensive checks first; startup outreach drafts are prepared explicitly from To contact cards, and job documents from To apply cards. Requirement extraction ignores headings, benefits and legal boilerplate, preserves substantive prose beside bullets, and separates mixed required/preferred clauses. Shortened requirements and capped lists remain explicitly partial. Preferred qualification coverage breaks required-fit ties before freshness; unassessed requirements still count toward the matching minimum. It can still miss unstructured requirements; compare the requirement list with the original job posting before trusting a match. Versioned local reassessment refreshes old derived data without paid AI calls and preserves requirement corrections and application history. The workspace loads all saved opportunities and the latest 300 drafts; Activity groups the latest 100 tasks and 60 workspace events, with readable outcomes, recovery links, optional diagnostics and filters. New searches distinguish newly saved opportunities from existing records and identify partial results. Application and outreach status changes and archive/restore actions also appear in history; older records may contain less detail.

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
