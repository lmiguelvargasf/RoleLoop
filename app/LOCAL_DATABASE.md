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

Mailpit captures test email locally. Messages accepted by this SMTP service are visible in the test inbox; they are not delivered to real recipients. Ollama is optional and is checked at `http://127.0.0.1:11434`.

## Network binding on Docker Desktop

Setup requests loopback binding through the Docker network option `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`. Some Docker Desktop versions ignore this setting and publish Supabase ports on every interface. This behavior was observed on this machine, and is reported in the [Supabase CLI issue](https://github.com/supabase/cli/issues/1397).

Setup and doctor inspect the actual published API port and display a notice when it is not restricted to loopback. A localhost URL alone does not prevent other computers on the network from connecting. Use a trusted network for testing; do not forward these development ports to the internet. The app does not modify global Docker settings or the host firewall.

## Data and credentials

All six application tables use row-level security and grant access only to the backend service role. Browser clients call the local app API instead of receiving Supabase credentials. The `documents` storage bucket is private. PostgreSQL data persists in Docker volumes across restarts. The `claim_run` RPC claims one queued task atomically using `FOR UPDATE SKIP LOCKED`.

The `enqueue_run` RPC prevents duplicate queued or running requests with the same action, opportunity, source, and draft. The worker acquires an owner-specific database lease before recovering interrupted work. `acquire_worker_lease`, `renew_worker_lease`, and `release_worker_lease` operate on `runtime['worker-lease']`; the lease lasts 30 seconds and is renewed every 5 seconds. An expired owner cannot renew its lease, and another owner cannot release it. These RPCs are available only to the backend service role.

Never commit `.env.local`. To stop the database services without deleting local data, run `npx --yes supabase@2.117.0 stop` from `app/`. Run `npm run setup` to start them again. Avoid `stop --no-backup`, `db reset`, and Docker volume deletion unless you intend to erase development data.

To refresh the generated TypeScript database schema after a migration:

```sh
npx --yes supabase@2.117.0 gen types typescript --local --network-id roleloop-local > src/shared/database.types.ts
```
