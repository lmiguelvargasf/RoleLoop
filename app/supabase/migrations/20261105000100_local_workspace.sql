-- Local single-user workspace. Only the backend receives a service key.
create table public.workspace (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.opportunities (
  id uuid primary key,
  kind text not null check (kind in ('job', 'startup')),
  source_key text not null unique,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.drafts (
  id uuid primary key,
  opportunity_id uuid not null references public.opportunities(id),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index drafts_opportunity_idx on public.drafts(opportunity_id);
create table public.runs (
  id uuid primary key,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_claim_idx on public.runs(status, created_at);
create table public.events (
  id uuid primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index events_recent_idx on public.events(created_at desc);
create table public.runtime (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

-- Atomic claiming prevents two worker processes executing the same queued run.
create function public.claim_run()
returns setof public.runs language sql security definer
set search_path = public, pg_temp
as $$
  update public.runs
  set status = 'running',
      payload = payload || jsonb_build_object('status', 'running', 'updatedAt', now()),
      updated_at = now()
  where id = (
    select id from public.runs where status = 'queued'
    order by created_at, id for update skip locked limit 1
  )
  returning *;
$$;

alter table public.workspace enable row level security;
alter table public.opportunities enable row level security;
alter table public.drafts enable row level security;
alter table public.runs enable row level security;
alter table public.events enable row level security;
alter table public.runtime enable row level security;
revoke all on public.workspace, public.opportunities, public.drafts,
  public.runs, public.events, public.runtime from anon, authenticated;
grant all on public.workspace, public.opportunities, public.drafts,
  public.runs, public.events, public.runtime to service_role;
revoke all on function public.claim_run() from public, anon, authenticated;
grant execute on function public.claim_run() to service_role;
insert into storage.buckets(id, name, public, file_size_limit)
values ('documents', 'documents', false, 20971520)
on conflict (id) do nothing;
