-- Company identity, discovery connections, and opportunities are separate entities.
create table public.companies (
  workspace_id text not null references public.workspace(id) on delete cascade,
  id text not null,
  name text not null check (length(trim(name)) > 0),
  country text not null default 'Unknown',
  country_source text,
  website text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create table public.discovery_sources (
  workspace_id text not null references public.workspace(id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('company_board', 'job_feed', 'startup_feed')),
  company_id text,
  label text not null,
  provider text not null check (provider in ('ashby','greenhouse','lever','jobicy','hackernews')),
  board text not null,
  enabled boolean not null default true,
  position integer not null default 0,
  primary key (workspace_id, id),
  foreign key (workspace_id, company_id) references public.companies(workspace_id, id),
  check ((kind = 'company_board' and company_id is not null and provider in ('ashby','greenhouse','lever'))
    or (kind = 'job_feed' and company_id is null and provider = 'jobicy')
    or (kind = 'startup_feed' and company_id is null and provider = 'hackernews'))
);
create unique index discovery_sources_identity on public.discovery_sources(workspace_id, provider, lower(board));
alter table public.companies enable row level security;
alter table public.discovery_sources enable row level security;
revoke all on public.companies, public.discovery_sources from public, anon, authenticated;
grant select on public.companies, public.discovery_sources to authenticated;
grant all on public.companies, public.discovery_sources to service_role;
create policy company_workspace_access on public.companies for select to authenticated using (public.has_workspace_access(workspace_id));
create policy discovery_source_workspace_access on public.discovery_sources for select to authenticated using (public.has_workspace_access(workspace_id));

-- The existing authorized workspace-patch RPC is the atomic write boundary.
-- Its sources input is normalized into tables and removed from the stored JSON.
create function public.normalize_workspace_discovery() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; company_key text; source_kind text; source_ids text[] := '{}'; pos integer := 0; original_companies jsonb;
begin
  if not (new.payload ? 'sources') then return new; end if;
  if jsonb_typeof(new.payload->'sources') <> 'array' or jsonb_array_length(new.payload->'sources') > 50 then
    raise exception 'Sources must be an array of at most 50 entries' using errcode='22023';
  end if;
  select coalesce(jsonb_object_agg(id, jsonb_build_object('name',name,'country',country,'country_source',country_source)), '{}'::jsonb) into original_companies from public.companies where workspace_id=new.id;
  -- Release removed/replaced identities before inserting their replacements.
  delete from public.discovery_sources as existing where existing.workspace_id=new.id and (
    not exists(select 1 from jsonb_array_elements(new.payload->'sources') wanted where wanted->>'id'=existing.id)
    or exists(select 1 from jsonb_array_elements(new.payload->'sources') wanted where wanted->>'id'=existing.id and (wanted->>'provider' is distinct from existing.provider or lower(wanted->>'board') is distinct from lower(existing.board)))
  );
  for s in select value from jsonb_array_elements(new.payload->'sources') loop
    if coalesce(s->>'id','') !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$' or (s->>'id') = any(source_ids) then
      raise exception 'Source identifiers must be valid and unique' using errcode='22023';
    end if;
    source_kind := case s->>'provider' when 'hackernews' then 'startup_feed' when 'jobicy' then 'job_feed' else 'company_board' end;
    company_key := null;
    if source_kind = 'company_board' then
      company_key := coalesce(nullif(s->>'companyId',''), 'company:' || md5((s->>'provider') || ':' || lower(s->>'board')));
      insert into public.companies(workspace_id,id,name,country,country_source)
      values(new.id,company_key,coalesce(nullif(s->>'companyName',''),s->>'label'),coalesce(nullif(s->>'companyCountry',''),'Unknown'),nullif(s->>'countrySource',''))
      on conflict(workspace_id,id) do update set
        name=case when excluded.name is distinct from original_companies->company_key->>'name' then excluded.name else companies.name end,
        country=case when excluded.country is distinct from original_companies->company_key->>'country' then excluded.country else companies.country end,
        country_source=case when excluded.country_source is distinct from original_companies->company_key->>'country_source' then excluded.country_source else companies.country_source end,
        updated_at=now();
    end if;
    insert into public.discovery_sources(workspace_id,id,kind,company_id,label,provider,board,enabled,position)
      values(new.id,s->>'id',source_kind,company_key,s->>'label',s->>'provider',s->>'board',coalesce((s->>'enabled')::boolean,true),pos)
    on conflict(workspace_id,id) do update set kind=excluded.kind,company_id=excluded.company_id,label=excluded.label,provider=excluded.provider,board=excluded.board,enabled=excluded.enabled,position=excluded.position;
    source_ids := array_append(source_ids,s->>'id'); pos := pos+1;
  end loop;
  delete from public.discovery_sources where workspace_id=new.id and not (id=any(source_ids));
  update public.workspace set payload=payload-'sources' where id=new.id;
  return new;
end; $$;
revoke all on function public.normalize_workspace_discovery() from public, anon, authenticated;
create trigger workspace_discovery_entities after insert or update of payload on public.workspace
for each row execute function public.normalize_workspace_discovery();

alter table public.opportunities add column company_id text, add column discovery_source_id text;
alter table public.opportunities add constraint opportunity_company foreign key(workspace_id,company_id) references public.companies(workspace_id,id);
alter table public.opportunities add constraint opportunity_discovery_source foreign key(workspace_id,discovery_source_id) references public.discovery_sources(workspace_id,id) on delete set null (discovery_source_id);
create index opportunity_company_idx on public.opportunities(workspace_id,company_id);
create function public.link_opportunity_company() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare connected_company text; company_key text;
begin
  new.discovery_source_id := null;
  select id,company_id into new.discovery_source_id,connected_company from public.discovery_sources
    where workspace_id=new.workspace_id and id=new.payload->>'sourceId';
  company_key := connected_company;
  if company_key is null and nullif(new.payload->>'companyId','') is not null then
    if not exists(select 1 from public.companies where workspace_id=new.workspace_id and id=new.payload->>'companyId') then
      raise exception 'Company not found in this workspace' using errcode='42501';
    end if;
    company_key := new.payload->>'companyId';
  end if;
  if company_key is null and new.company_id is not null and exists(select 1 from public.companies where workspace_id=new.workspace_id and id=new.company_id) then
    company_key := new.company_id;
  end if;
  if company_key is null and length(trim(coalesce(new.payload->>'company',''))) > 0 then
    -- Provider-scoped identity: never merge unrelated employers just by name.
    company_key := 'company:' || md5(coalesce(new.payload->>'source','manual') || ':' || lower(trim(new.payload->>'company')));
    insert into public.companies(workspace_id,id,name,country,country_source,website)
      values(new.workspace_id,company_key,new.payload->>'company',coalesce(new.payload->>'companyCountry','Unknown'),new.payload->>'companyCountrySource',nullif(new.payload->>'companyUrl',''))
      on conflict(workspace_id,id) do nothing;
  end if;
  new.company_id := company_key;
  return new;
end; $$;
revoke all on function public.link_opportunity_company() from public, anon, authenticated;
create trigger opportunity_company_link before insert or update of payload on public.opportunities
for each row execute function public.link_opportunity_company();

-- Backfill without replacing originals, source IDs, assessments, or applications.
update public.workspace set payload=payload where payload ? 'sources';
update public.opportunities set payload=payload;

-- Job searches and startup research must not deduplicate into one task.
create or replace function public.enqueue_run(target_workspace text, run_payload jsonb)
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
    and coalesce(payload->>'discoveryScope','jobs') = coalesce(run_payload->>'discoveryScope','jobs')
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
