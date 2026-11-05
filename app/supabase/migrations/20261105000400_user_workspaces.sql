-- Preserve the original workspace while separating all future user data.
-- Ownership of the legacy workspace is assigned only by the local setup flow.
alter table public.workspace
  add column name text not null default 'Personal workspace',
  add column owner_user_id uuid references auth.users(id);
update public.workspace set name = 'Existing workspace' where id = 'default';

create table public.workspace_members (
  workspace_id text not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members(user_id, workspace_id);
create index workspace_owner_idx on public.workspace(owner_user_id);

-- Application administrators manage accounts, but do not gain workspace access.
create table public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.opportunities
  add column workspace_id text not null default 'default' references public.workspace(id) on delete cascade;
alter table public.drafts
  add column workspace_id text not null default 'default' references public.workspace(id) on delete cascade;
alter table public.runs
  add column workspace_id text not null default 'default' references public.workspace(id) on delete cascade;
alter table public.events
  add column workspace_id text not null default 'default' references public.workspace(id) on delete cascade;
alter table public.opportunities alter column workspace_id drop default;
alter table public.drafts alter column workspace_id drop default;
alter table public.runs alter column workspace_id drop default;
alter table public.events alter column workspace_id drop default;

alter table public.opportunities drop constraint opportunities_source_key_key;
alter table public.opportunities add constraint opportunities_workspace_source_key
  unique (workspace_id, source_key);
alter table public.opportunities add constraint opportunities_workspace_id_key
  unique (workspace_id, id);
alter table public.drafts drop constraint drafts_opportunity_id_fkey;
alter table public.drafts add constraint drafts_workspace_opportunity_fkey
  foreign key (workspace_id, opportunity_id) references public.opportunities(workspace_id, id);

create index opportunities_workspace_recent_idx on public.opportunities(workspace_id, updated_at desc);
create index drafts_workspace_recent_idx on public.drafts(workspace_id, updated_at desc);
create index runs_workspace_recent_idx on public.runs(workspace_id, created_at desc);
create index events_workspace_recent_idx on public.events(workspace_id, created_at desc);

create table public.workspace_runtime (
  workspace_id text not null references public.workspace(id) on delete cascade,
  key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
insert into public.workspace_runtime(workspace_id, key, payload, updated_at)
  select 'default', key, payload, updated_at from public.runtime
  where key = 'last-discovery' or key like 'corrections:%';
delete from public.runtime where key = 'last-discovery' or key like 'corrections:%';
update public.runs set payload = payload || jsonb_build_object('workspaceId', workspace_id);

alter table public.workspace_members enable row level security;
alter table public.app_admins enable row level security;
alter table public.workspace_runtime enable row level security;
revoke all on public.workspace_members, public.app_admins, public.workspace_runtime from public, anon, authenticated;
grant all on public.workspace_members, public.app_admins, public.workspace_runtime to service_role;

-- These helpers read membership as their owner to avoid recursive RLS policies.
-- Identity always comes from the verified request JWT, never a user argument.
create function public.has_workspace_access(target_workspace text)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = auth.uid()
  );
$$;
create function public.owns_workspace(target_workspace text)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.workspace
    where id = target_workspace and owner_user_id = auth.uid()
  );
$$;
revoke all on function public.has_workspace_access(text), public.owns_workspace(text) from public, anon;
grant execute on function public.has_workspace_access(text), public.owns_workspace(text) to authenticated, service_role;

-- A login has no access to the old unclaimed workspace. Each account receives
-- a new private workspace under an account-specific lock on first use.
create function public.ensure_workspace(initial_payload jsonb)
returns setof public.workspace language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  account_id uuid := auth.uid();
  existing_workspace public.workspace%rowtype;
begin
  if account_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(initial_payload) is distinct from 'object' then
    raise exception 'A workspace object is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('roleloop:provision:' || account_id::text, 0));
  select * into existing_workspace from public.workspace
    where owner_user_id = account_id order by id limit 1;
  if found then
    return next existing_workspace;
    return;
  end if;
  insert into public.workspace(id, name, owner_user_id, payload)
    values (gen_random_uuid()::text, 'Personal workspace', account_id, initial_payload)
    returning * into existing_workspace;
  insert into public.workspace_members(workspace_id, user_id, role)
    values (existing_workspace.id, account_id, 'owner');
  return next existing_workspace;
end;
$$;
revoke all on function public.ensure_workspace(jsonb) from public, anon;
grant execute on function public.ensure_workspace(jsonb) to authenticated;

-- Only a workspace owner can grant/revoke manager access. Administration of
-- accounts alone never grants permission to browse another person's data.
create function public.manage_workspace_member(target_workspace text, member_user_id uuid, operation text)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('roleloop:members:' || target_workspace, 0));
  if not public.owns_workspace(target_workspace) then
    raise exception 'Only the workspace owner can manage access' using errcode = '42501';
  end if;
  if operation not in ('grant', 'revoke') or operation is null then
    raise exception 'Use grant or revoke' using errcode = '22023';
  end if;
  if exists (select 1 from public.workspace where id = target_workspace and owner_user_id = member_user_id) then
    raise exception 'Owner membership cannot be changed' using errcode = '42501';
  end if;
  if operation = 'grant' then
    insert into public.workspace_members(workspace_id, user_id, role)
      values (target_workspace, member_user_id, 'manager')
      on conflict (workspace_id, user_id) do nothing;
  else
    delete from public.workspace_members
      where workspace_id = target_workspace and user_id = member_user_id and role = 'manager';
  end if;
end;
$$;
revoke all on function public.manage_workspace_member(text, uuid, text) from public, anon, service_role;
grant execute on function public.manage_workspace_member(text, uuid, text) to authenticated;

-- Bootstrap requires a short-lived digest written by a local CLI command.
-- The API supplies the verified user's ID. No normal signup becomes an admin.
create function public.claim_initial_owner(owner_uuid uuid, token_digest text)
returns setof public.workspace language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  setup_record jsonb;
  selected_workspace public.workspace%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('roleloop:initial-owner', 0));
  if exists (select 1 from public.app_admins) then
    raise exception 'The initial owner is already configured' using errcode = '42501';
  end if;
  select payload into setup_record from public.runtime where key = 'owner-setup' for update;
  if setup_record is null or token_digest is null or length(token_digest) <> 64
    or setup_record->>'tokenHash' is distinct from token_digest
    or coalesce((setup_record->>'expiresAt')::timestamptz, '-infinity'::timestamptz) <= now() then
    raise exception 'The local setup key is invalid or expired' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = owner_uuid) then
    raise exception 'The account does not exist' using errcode = '22023';
  end if;
  select * into selected_workspace from public.workspace where id = 'default' for update;
  if found then
    if selected_workspace.owner_user_id is not null and selected_workspace.owner_user_id <> owner_uuid then
      raise exception 'The existing workspace already has an owner' using errcode = '42501';
    end if;
    update public.workspace set owner_user_id = owner_uuid, updated_at = now()
      where id = selected_workspace.id returning * into selected_workspace;
    insert into public.workspace_members(workspace_id, user_id, role)
      values (selected_workspace.id, owner_uuid, 'owner')
      on conflict (workspace_id, user_id) do update set role = 'owner';
  else
    select * into selected_workspace from public.workspace where owner_user_id = owner_uuid order by id limit 1;
    if not found then
      raise exception 'Create your personal workspace before claiming ownership' using errcode = '22023';
    end if;
  end if;
  insert into public.app_admins(user_id) values (owner_uuid);
  delete from public.runtime where key = 'owner-setup';
  return next selected_workspace;
end;
$$;
revoke all on function public.claim_initial_owner(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_initial_owner(uuid, text) to service_role;

-- Normal operations use a user JWT and membership-based policies. The backend
-- never permits callers to choose an owner or elevate their membership.
grant select on public.workspace, public.workspace_members, public.app_admins to authenticated;
grant update (name, payload, updated_at) on public.workspace to authenticated;
grant select, insert, update, delete on public.opportunities, public.drafts, public.runs, public.events, public.workspace_runtime to authenticated;

create policy workspace_member_read on public.workspace for select to authenticated
  using (public.has_workspace_access(id));
create policy workspace_member_update on public.workspace for update to authenticated
  using (public.has_workspace_access(id)) with check (public.has_workspace_access(id));
create policy members_read on public.workspace_members for select to authenticated
  using (public.has_workspace_access(workspace_id));
create policy admin_self_read on public.app_admins for select to authenticated
  using (user_id = (select auth.uid()));
create policy opportunity_workspace_access on public.opportunities for all to authenticated
  using (public.has_workspace_access(workspace_id)) with check (public.has_workspace_access(workspace_id));
create policy draft_workspace_access on public.drafts for all to authenticated
  using (public.has_workspace_access(workspace_id)) with check (public.has_workspace_access(workspace_id));
create policy run_workspace_access on public.runs for all to authenticated
  using (public.has_workspace_access(workspace_id)) with check (public.has_workspace_access(workspace_id));
create policy event_workspace_access on public.events for all to authenticated
  using (public.has_workspace_access(workspace_id)) with check (public.has_workspace_access(workspace_id));
create policy workspace_runtime_access on public.workspace_runtime for all to authenticated
  using (public.has_workspace_access(workspace_id)) with check (public.has_workspace_access(workspace_id));

-- The old single-workspace entry point must not remain callable.
drop function public.enqueue_run(jsonb);
create function public.enqueue_run(target_workspace text, run_payload jsonb)
returns setof public.runs language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  existing_run public.runs%rowtype;
  queued_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_workspace_access(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace where id = target_workspace and owner_user_id is not null) then
    raise exception 'A claimed workspace is required' using errcode = '42501';
  end if;
  if jsonb_typeof(run_payload) is distinct from 'object'
    or coalesce(run_payload->>'id', '') = ''
    or coalesce(run_payload->>'action', '') not in ('discover', 'analyze', 'draft', 'research', 'simulate') then
    raise exception 'A run ID and supported action are required' using errcode = '22023';
  end if;
  if (run_payload->>'action') <> 'discover' and coalesce(run_payload->>'opportunityId', '') = '' then
    raise exception 'An opportunity is required for this action' using errcode = '22023';
  end if;
  if run_payload->>'opportunityId' is not null and not exists (
    select 1 from public.opportunities where workspace_id = target_workspace and id = run_payload->>'opportunityId'
  ) then
    raise exception 'Opportunity not found in this workspace' using errcode = '42501';
  end if;
  if (run_payload->>'action') = 'simulate' and coalesce(run_payload->>'draftId', '') = '' then
    raise exception 'A draft is required for simulation' using errcode = '22023';
  end if;
  if run_payload->>'draftId' is not null and not exists (
    select 1 from public.drafts where workspace_id = target_workspace and id = run_payload->>'draftId'
      and opportunity_id = run_payload->>'opportunityId'
  ) then
    raise exception 'Draft not found for this workspace opportunity' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('roleloop:enqueue:' || target_workspace, 0));
  select * into existing_run from public.runs
  where workspace_id = target_workspace and status in ('queued', 'running')
    and payload->>'action' = run_payload->>'action'
    and (payload->>'opportunityId') is not distinct from (run_payload->>'opportunityId')
    and (payload->>'sourceId') is not distinct from (run_payload->>'sourceId')
    and (payload->>'draftId') is not distinct from (run_payload->>'draftId')
  order by created_at, id limit 1;
  if found then
    return next existing_run;
    return;
  end if;
  queued_payload := run_payload || jsonb_build_object(
    'workspaceId', target_workspace, 'status', 'queued', 'progress', 0,
    'createdAt', now(), 'updatedAt', now()
  );
  return query insert into public.runs(id, workspace_id, status, payload)
    values (run_payload->>'id', target_workspace, 'queued', queued_payload) returning *;
end;
$$;
revoke all on function public.enqueue_run(text, jsonb) from public, anon;
grant execute on function public.enqueue_run(text, jsonb) to authenticated, service_role;

create or replace function public.claim_run()
returns setof public.runs language sql security definer
set search_path = public, pg_temp
as $$
  update public.runs
  set status = 'running',
      payload = payload || jsonb_build_object('status', 'running', 'workspaceId', workspace_id, 'updatedAt', now()),
      updated_at = now()
  where id = (
    select runs.id from public.runs
    join public.workspace on workspace.id = runs.workspace_id
    where runs.status = 'queued' and workspace.owner_user_id is not null
    order by runs.created_at, runs.id for update of runs skip locked limit 1
  )
  returning *;
$$;

-- New files are stored under <workspace_id>/drafts/<draft_id>/resume.pdf.
-- Legacy files remain private; authorized API downloads can re-render them.
create policy workspace_document_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.has_workspace_access((storage.foldername(name))[1]));

notify pgrst, 'reload schema';
