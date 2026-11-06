# Local Supabase

The React UI, API, and worker run directly in Node.js. Docker runs only the Supabase development services. No Supabase account or cloud project is required.

From the repository root, select the version pinned in `.nvmrc` with `nvm install && nvm use`. Then run these commands from `app/`:

```sh
npm install
npm run setup
npm run doctor
npm run dev
```

Setup uses Supabase CLI **2.117.0**, downloading that exact CLI through `npx` when the installed version differs. It creates the `roleloop-local` Docker network, starts project `roleloop-ts`, applies pending migrations using `db push --local`, and writes backend credentials to `.env.local` with owner-only permissions. It never links or pushes to a cloud database. Re-running setup preserves existing database data and applies only pending migrations. It never calls `db reset`.

| Service | Local address |
| --- | --- |
| Supabase API | http://127.0.0.1:54331 |
| PostgreSQL | 127.0.0.1:54332 |
| Supabase Studio | http://127.0.0.1:54333 |
| Mailpit test inbox | http://127.0.0.1:54334 |
| Mailpit SMTP capture | 127.0.0.1:54335 |
| Shadow database, when needed | 127.0.0.1:54330 |

Mailpit captures test email locally. Messages accepted by this SMTP service are visible in the test inbox; they are not delivered to real recipients. OpenAI is the only AI provider. Set `OPENAI_API_KEY` in the server environment for résumé import and AI matching.

## Network binding on Docker Desktop

Setup requests loopback binding through the Docker network option `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`. Some Docker Desktop versions ignore this setting and publish Supabase ports on every interface. This behavior was observed on this machine, and is reported in the [Supabase CLI issue](https://github.com/supabase/cli/issues/1397).

Setup and doctor inspect the actual published API port and display a notice when it is not restricted to loopback. A localhost URL alone does not prevent other computers on the network from connecting. Use a trusted network for testing; do not forward these development ports to the internet. The app does not modify global Docker settings or the host firewall.

## Data and credentials

Supabase Auth manages email/password accounts and sessions locally. Passwords must contain at least 12 characters. Auth redirects are limited to the app's `localhost` and `127.0.0.1` addresses on ports 5173 and 4310. Local email confirmation is disabled for testing; password recovery email is captured by Mailpit. Changing these Auth settings requires a non-destructive Supabase stop/start.

Each account receives a private workspace. `workspace_members` grants either owner or manager access. Owners can add or remove managers; managers can operate the shared workspace but cannot grant access to anyone else or remove its owner. The `app_admins` table grants account-administration privileges only; administrators still require membership to access another user's workspace. Ordinary API operations use the authenticated user's identity and row-level security. The service key remains backend-only for trusted worker and administrative operations.

`opportunities`, `drafts`, `runs`, and `events` carry a required `workspace_id`. Source keys are unique within each workspace, so two users can independently discover and assess the same job. A composite foreign key prevents a draft from referencing an opportunity in another workspace. Database checks reject unsafe record IDs and non-object JSON payloads, including writes made directly through the Data API. `workspace_runtime` stores per-workspace corrections and scheduling state; the original `runtime` table holds platform-only worker coordination and the setup-key digest.

The migration preserves existing records in the original `default` workspace and leaves it unclaimed. A new signup does not gain access to that data or become an administrator. The local setup command creates a short-lived one-time key; the authenticated setup flow verifies its digest, assigns the existing workspace to that account, and appoints the first application administrator. The digest is consumed atomically. On a clean installation with no legacy workspace, the user's personal workspace is retained instead.

The `documents` storage bucket remains private. New files live under `<workspace_id>/drafts/<draft_id>/resume.pdf`; signed-in users can read objects only in workspaces they can access. Legacy unscoped objects stay private, and authorized application downloads can re-render those documents from saved drafts. PostgreSQL data persists in Docker volumes across restarts.

Master CV originals use immutable paths under `<workspace_id>/resumes/<source_id>/original.pdf` (or `.docx`). The profile payload stores only `source` and `cache`; contact email is resolved from the workspace owner's Auth account. The cache records its source ID, extractor version, processing state, source-validated career facts, processing notes and errors. An upload activates a new source with no usable facts, then writes the cache only if the profile still matches the processing version. Failed processing keeps the original and can be retried. Private legacy profile snapshots remain readable, but new independent profile snapshots and manual career edits are retired. The CV-first migration removes obsolete fields without rewriting drafts, artifacts or activity. A legacy CV needs one explicit processing pass; its manually reviewed facts are not treated as an extraction cache.

The `enqueue_run(target_workspace, run_payload)` RPC prevents duplicate queued or running requests within the same workspace and checks that referenced records belong to it. `claim_run` claims one queued task atomically using `FOR UPDATE SKIP LOCKED`. The worker carries the claimed row's workspace through every subsequent operation and skips unclaimed workspaces. It acquires an owner-specific database lease before recovering interrupted work. `acquire_worker_lease`, `renew_worker_lease`, and `release_worker_lease` operate on `runtime['worker-lease']`; the lease lasts 30 seconds and is renewed every 5 seconds. An expired owner cannot renew its lease, and another owner cannot release it. Worker RPCs are service-role-only.

Supabase Studio and Mailpit are privileged, shared development tools on the local machine. Application accounts do not protect these separate services from someone who can access their localhost ports or Docker. Keep them restricted to trusted development use; this local setup is not a hosted multi-user deployment.

Never commit `.env.local`. To stop the database services without deleting local data, run `npx --yes supabase@2.117.0 stop` from `app/`. Run `npm run setup` to start them again. Avoid `stop --no-backup`, `db reset`, and Docker volume deletion unless you intend to erase development data.

To refresh the generated TypeScript database schema after a migration:

```sh
npx --yes supabase@2.117.0 gen types typescript --local --network-id roleloop-local > src/shared/database.types.ts
```

The database isolation regression test uses disposable identities inside one rolled-back SQL transaction. It verifies cross-workspace read/write denial, manager grant/revocation, foreign keys, queue deduplication, storage policies, safe IDs, and initial-owner setup/replay protection without keeping test accounts or claiming the real workspace:

```sh
ROLELOOP_INTEGRATION=1 npx vitest run tests/database.integration.test.ts
```
