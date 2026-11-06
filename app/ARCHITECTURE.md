# Local architecture

```mermaid
flowchart LR
  AUTH["Supabase Auth\nAccount + session"] --> UI["React + Vite\nBrowser on localhost"]
  UI --> API["Fastify + Zod\nNative Node.js"]
  API --> DB[("Local Supabase\nPostgreSQL + Storage")]
  DB <--> WORKER["TypeScript worker\nAtomic queue + lease"]
  WORKER --> ATS["Ashby · Greenhouse · Lever\nPublic job boards"]
  WORKER --> HN["Show HN + public websites\nStartup research leads"]
  ATS --> RULES["Eligibility + dates + salary\nSource-supported coverage"]
  HN --> RESEARCH["Company facts + contact source\nExploratory relevance"]
  RULES --> DRAFT["Evidence templates\nOpenAI evidence selection"]
  RESEARCH --> DRAFT
  DRAFT --> DB
  UI --> REVIEW["Review exact draft\nHash-bound approval"]
  REVIEW --> TEST["Local simulation"]
  TEST --> PDF["Playwright PDF\nPrivate Storage bucket"]
  TEST --> MAIL["Nodemailer → Mailpit\nTest inbox only"]
```

The UI, API and worker are native Node.js processes. Only Supabase uses Docker. The browser talks to `/api` through Vite's development proxy; the production local server serves the compiled UI itself. Credentials are loaded only in server processes from `app/.env.local`.

The worker claims durable database rows with `FOR UPDATE SKIP LOCKED`. A renewable database lease prevents overlapping worker owners and protects recovery. Interrupted runs are marked failed, so test delivery is not automatically retried. Queue insertion deduplicates equivalent active tasks atomically. Scheduled discovery depends on the worker and the machine remaining awake.

Job coverage uses source-supported evidence for each requirement, with essential requirements weighted at 80% where both essential and preferred requirements exist. A matching skill does not prove years of experience, credentials or legal eligibility. Startup relevance is a separate exploration measure. Unknown facts remain review items; explicit contradictions are exclusions. Publication timestamps are distinct from discovery timestamps.

Sources and website content are untrusted data. Bounded public-website requests validate and pin DNS, reject private/reserved addresses, validate every redirect, and cap response size/time. AI requests use the fixed OpenAI Responses endpoint and refuse redirects. Assessment and drafting outputs can only select existing evidence IDs. HTML is escaped before PDF rendering and the document browser blocks network requests.

Approval binds the profile, preferences, source opportunity, and exact draft text. Draft mutations revoke approval. Execution checks these values again before local simulation. No code path submits a real application or sends external mail. This is a testing foundation; future real delivery should use provider-specific adapters and separately defined authorization.

## Resume facts

The resume flow separates three responsibilities:

```text
Private original PDF/DOCX
  → versioned career records and source statements
  → opportunity-specific assessment and application drafts
```

The original is the source of truth. Derived facts describe the career independently of any target role. Assessments and drafts select from those facts; they do not rewrite the underlying record or trigger extraction for each opportunity. Search preferences remain separate from resume claims.

### Extraction contract

`app/src/shared/types.ts` defines the versioned contract. `CareerFactsSchema.sections` groups experience, projects, education, certifications, listed skills, languages and other career details. A section holds its title, organization, period, original source passage and evidence IDs. `facts.evidence` stores atomic quotations and supported skill tags, preserving the existing matching and drafting interface. This lets the presentation evolve without making each statement an independent career entry.

`resume-import.ts` indexes the original text into numbered, bounded source units and requests compact ranges in structured output. Embedded PDF/Word HTTP(S) links are deduplicated and appended as bounded source context; linked pages are never fetched and the visible text retains its existing offsets. The model classifies records and selects ranges; the server reconstructs statements directly from the source. Range bounds and containment are checked before validation, so the model cannot supply rewritten quotations. This avoids generating both a full source passage and duplicate bullet text, and disambiguates identical text at different positions. Metadata must also occur within that passage, and tags must be literal skill names in the statement. `source-quotations.ts` tolerates whitespace and Unicode presentation differences while retaining original spelling and UTF-16 offsets into extracted document text. Duplicate statements are removed and source order is retained. Matching titles and employers are merged only when their source passages overlap, keeping separate engagements distinct when dates are missing. Missing fields remain empty; extraction does not infer tenure, proficiency or job-search preferences. Instructions inside documents are untrusted content, never extraction instructions.

A traceable quotation proves presence in the source, not independent truth or correct semantic interpretation. The stored `verified` flag means source-supported, not employer-verified or human-approved. Users review the source passages and extraction notes; corrections currently happen by updating and replacing the resume. There is no competing editable copy of career facts.

### Matching and presentation

Listed skills and language claims retain their categories through matching and drafting. They can indicate relevance but cannot alone produce a full requirement match or satisfy a mandatory condition. Contextual evidence and transferable experience remain distinguishable from a bare keyword list. Role-specific assessments cite evidence IDs, and drafts keep listed claims separate from career highlights.

The **Resume** workspace separates document actions from the career review. `ResumeFacts.tsx` has one category registry for section order and labels, shared by navigation and grouped records. Search, expandable evidence and source passages operate on the same contract. New categories or metadata should extend the shared schema, extractor validation and matching semantics together; display changes belong in the review component and its scoped stylesheet.

### Cache lifecycle and persistence

`CV_EXTRACTOR_VERSION` is currently 2. `careerFacts()` is the common access gate: only a ready cache for the active source and current extractor version can supply facts. Upload activates a new source and removes the old cache before processing. Retry reuses the private original. Clearing extracted details removes only the cache, leaving originals, drafts and history intact. Processing, upload and reset use compare-and-swap writes; late responses and stale clear requests cannot overwrite a newer state. `update_workspace_profile_if_current` compares profiles atomically inside PostgreSQL with JSON parameters in the request body, avoiding URL-size limits for large resumes. It merges only validated supplied workspace fields, preserves independently changed settings, and uses the caller's existing row-level permissions.

The v2 migration updates the database profile cleaner and invalidates v1 caches while preserving source references and stored files. Future contract changes must update both the runtime version gate and database cleaner/migration. Avoid adding parsed defaults to persisted profiles without normalizing existing rows: compare-and-swap compares stored JSON. The extraction request has a five-minute deadline configured in `shared/resume-processing.ts`; other AI calls retain their existing default. The stream reader collects `response.output_item.done` items by output index, then accepts them only after `response.completed`; some subscription responses leave the terminal event's output array empty. A populated terminal output takes precedence so text is never concatenated twice. The reader does not wait for socket EOF; incomplete, failed and interrupted streams remain failures even if text was already received. Cache `startedAt`/`expiresAt` metadata prevents duplicate active retries and exposes recovery after interruption or expiration. Optional `errorCode` distinguishes service timeouts from source errors without changing the v2 facts contract or adding defaults to old stored JSON. Inference is never automatically retried or switched to API billing. Re-extraction is explicit. Existing documents remain downloadable, while profile fingerprints require fresh generation before approval after source or fact changes.

## Accounts and isolation

Supabase Auth owns account credentials. The API verifies the bearer token through Auth and constructs a new Supabase client with that user's token for each ordinary request. It verifies the selected workspace membership, then passes an explicit scoped store into services. Row-level policies enforce the same boundary when a user calls Supabase directly. The browser never receives a service key.

`workspace.owner_user_id` identifies ownership; `workspace_members` records owner/manager access. Owners alone grant/revoke managers through an authenticated database function. `app_admins` permits account administration, without implicitly granting access to any workspace. Each new account receives a blank personal workspace. Existing `default` data stays unclaimed until an authenticated user presents a one-time local setup key. Only its digest and expiry are stored in global runtime state; claiming consumes it atomically.

Every opportunity, draft, run, event, and user runtime entry has a workspace ID. Source uniqueness and queued-task deduplication include this ID. Draft references use a composite workspace/opportunity foreign key. Workers use privileged access only with the workspace from the claimed SQL row; global worker leases and heartbeat remain separate. Scheduling and daily draft limits are per workspace. Stored SQL IDs and relationships override JSON copies, and safe-ID constraints prevent object-path traversal.

Documents use workspace-prefixed private object paths. Browser downloads go through a scoped authenticated API; direct Storage reads require membership. Existing legacy objects remain private and authorized downloads re-render their saved drafts. The UI captures account/workspace context for each request, rejects responses from stale contexts, and remounts workspace state after switching. Revocation blocks subsequent API and database access even with an existing JWT.

Tests cover API and direct RLS isolation, manager revocation/escalation, administrator boundaries, queue/source deduplication, private Storage, payload tampering, and initial-owner setup. Integration fixtures are isolated and removed; SQL setup checks use rollback. Studio/Mailpit/Docker remain trusted host-level developer surfaces outside RoleLoop account isolation.


## Local ChatGPT plan connections

Each RoleLoop user has a separate protected connection file under `.local/chatgpt/`, with independent issued-client registrations, selected account/model, OAuth credentials and billing choice. Loopback callbacks validate one-time state, PKCE, signed ID-token audience/issuer/nonce and returning subject before activating an account. The frontend receives display metadata only. Subscription inference requires plan-usage consent, uses the account model catalog and streamed Responses with `store: false`, and never falls back to API billing. File locks serialize refreshes across API and worker processes; token replacements are atomic.

The database stamps each run's immutable `requested_by` from the authenticated identity. Workers disregard requester IDs in JSON payloads, recheck workspace membership, and load only that requester's connection. Scheduled tasks have no subscription requester and use API configuration. Tests use signed fixture tokens and mocked OpenAI responses; live connection requires the user to complete sign-in and consent.

## Practical job search workflow

Company sources carry optional country and official evidence URL; imported listings inherit both. This is independent of remote hiring eligibility. The researched library contains nine US employer boards across Greenhouse, Ashby and Lever, plus Jobicy (broad remote discovery, employer country unverified). Each employer includes official country evidence and a dated board-check snapshot. Existing workspaces add sources individually or together; case-insensitive provider/board identity preserves custom labels and paused states. New workspaces receive the library by default. Provider docs: https://jobicy.com/jobs-rss-feed and https://github.com/lever/postings-api. Jobicy feed requests share a persisted hourly installation cache, with bounded cursor traversal; local keywords do not change stable provider IDs. Full-board ATS results and bounded Lever pagination replace the prior first-100 truncation. Missing feed entries never imply closure.

Application progress is separate from matching stage inside each opportunity payload. Submission/interview/offer timestamps, next action, follow-up date and notes survive source refreshes. Progress-only API edits avoid re-evaluation and draft invalidation. Source outcome counts retain interview/offer milestones after rejection and explicitly describe the 300-record viewing limit. Application submission remains manual through the listing URL.

Requirements retain source statements beyond the recognized software tags. Missing structured requirements render as unevaluated in the list. Tenure/credential conditions cannot be proven by skill mentions: capability support can be partial while the condition remains a review item. Company headquarters is checked when a country preference is set; ambiguous location text stays unknown. Successful semantic assessments are reused for up to one day with opportunity, profile, preference and requester fingerprints. Hard exclusions and unrelated roles use deterministic assessment; globally ordered ready candidates receive the daily draft budget. Public job-page capture uses the existing DNS-pinned, size/time-bounded research transport and never executes page scripts.

Source health is written independently to the workspace-scoped `source-health` runtime record after each source completes or fails. Bootstrap reads it once and the Sources page shows the last run’s found/evaluated counts and error. This is a run result, not an assertion that a job remains open. Manual board links are explicitly separate from automated connectors. Oversized connector descriptions and captured pages carry `descriptionTruncated`; matching treats this as uncertainty and fingerprints it only when true, preserving existing hashes for complete descriptions.
