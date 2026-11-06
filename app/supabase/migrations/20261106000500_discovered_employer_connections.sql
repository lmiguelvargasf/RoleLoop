-- Source edits and automatic connections share a workspace lock and revision.
alter table public.workspace add column sources_revision bigint not null default 0;
alter table public.discovery_sources
  add column discovered_from text check (length(discovered_from) <= 2000),
  add column discovered_at timestamptz;

-- Removing a company is an explicit opt-out from automatic rediscovery.
create table public.discovery_source_suppressions (
  workspace_id text not null references public.workspace(id) on delete cascade,
  provider text not null check (provider in ('ashby','greenhouse','lever')),
  board text not null check (board = lower(board)),
  removed_at timestamptz not null default now(),
  primary key (workspace_id, provider, board)
);
alter table public.discovery_source_suppressions enable row level security;
revoke all on public.discovery_source_suppressions from public, anon, authenticated;
grant select on public.discovery_source_suppressions to authenticated;
grant all on public.discovery_source_suppressions to service_role;
create policy discovery_suppression_workspace_access on public.discovery_source_suppressions
  for select to authenticated using (public.has_workspace_access(workspace_id));

create or replace function public.normalize_workspace_discovery() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; company_key text; source_kind text; source_ids text[] := '{}'; pos integer := 0; original_companies jsonb;
begin
  if not (new.payload ? 'sources') then return new; end if;
  if jsonb_typeof(new.payload->'sources') <> 'array' or jsonb_array_length(new.payload->'sources') > 50 then
    raise exception 'Sources must be an array of at most 50 entries' using errcode='22023';
  end if;
  select coalesce(jsonb_object_agg(id, jsonb_build_object('name',name,'country',country,'country_source',country_source)), '{}'::jsonb)
    into original_companies from public.companies where workspace_id=new.id;
  insert into public.discovery_source_suppressions(workspace_id,provider,board)
    select existing.workspace_id,existing.provider,lower(existing.board)
    from public.discovery_sources as existing
    where existing.workspace_id=new.id and existing.kind='company_board' and not exists (
      select 1 from jsonb_array_elements(new.payload->'sources') wanted
      where wanted->>'provider'=existing.provider and lower(wanted->>'board')=lower(existing.board)
    )
    on conflict(workspace_id,provider,board) do update set removed_at=now();
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
      -- A manual add reverses a previous removal of this exact board.
      delete from public.discovery_source_suppressions
        where workspace_id=new.id and provider=s->>'provider' and board=lower(s->>'board');
    end if;
    insert into public.discovery_sources(workspace_id,id,kind,company_id,label,provider,board,enabled,position,discovered_from,discovered_at)
      values(new.id,s->>'id',source_kind,company_key,s->>'label',s->>'provider',s->>'board',coalesce((s->>'enabled')::boolean,true),pos,nullif(s->>'discoveredFrom',''),nullif(s->>'discoveredAt','')::timestamptz)
    on conflict(workspace_id,id) do update set kind=excluded.kind,company_id=excluded.company_id,label=excluded.label,provider=excluded.provider,board=excluded.board,enabled=excluded.enabled,position=excluded.position,
      discovered_from=coalesce(excluded.discovered_from,discovery_sources.discovered_from),
      discovered_at=coalesce(excluded.discovered_at,discovery_sources.discovered_at);
    source_ids := array_append(source_ids,s->>'id'); pos := pos+1;
  end loop;
  delete from public.discovery_sources where workspace_id=new.id and not (id=any(source_ids));
  update public.workspace set payload=payload-'sources',sources_revision=sources_revision+1 where id=new.id;
  return new;
end; $$;

create function public.replace_discovery_sources(target_workspace text, expected_revision bigint, source_payload jsonb)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.has_workspace_access(target_workspace) then
    raise exception 'Workspace access denied' using errcode='42501';
  end if;
  select sources_revision into current_revision from public.workspace where id=target_workspace for update;
  if not found then raise exception 'Workspace not found' using errcode='42501'; end if;
  if expected_revision is null or expected_revision <> current_revision then
    raise exception 'Companies and feeds changed. Refresh and try again.' using errcode='40001';
  end if;
  update public.workspace set payload=payload || jsonb_build_object('sources',source_payload),updated_at=now() where id=target_workspace;
  select sources_revision into current_revision from public.workspace where id=target_workspace;
  return current_revision;
end; $$;
revoke all on function public.replace_discovery_sources(text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.replace_discovery_sources(text,bigint,jsonb) to authenticated,service_role;

-- Worker-only append: never replace or reactivate an existing connection, and
-- never replace company facts when a board is linked to a known employer.
create function public.connect_discovered_source(target_workspace text, source_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare workspace_payload jsonb; existing_id text; company_key text; source_provider text; source_board text; next_position integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Only the discovery worker can connect discovered employers' using errcode='42501';
  end if;
  select payload into workspace_payload from public.workspace where id=target_workspace for update;
  if not found then raise exception 'Workspace not found' using errcode='42501'; end if;
  if coalesce((workspace_payload#>>'{preferences,discoverEmployers}')::boolean,true) = false then
    return jsonb_build_object('status','ignored');
  end if;
  source_provider := source_payload->>'provider'; source_board := source_payload->>'board';
  if jsonb_typeof(source_payload) is distinct from 'object'
    or coalesce(source_provider,'') not in ('ashby','greenhouse','lever')
    or coalesce(source_board,'') !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
    or coalesce(source_payload->>'id','') !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'
    or length(trim(coalesce(source_payload->>'label',''))) = 0 then
    raise exception 'A valid company board is required' using errcode='22023';
  end if;
  select id into existing_id from public.discovery_sources
    where workspace_id=target_workspace and provider=source_provider and lower(board)=lower(source_board);
  if found then return jsonb_build_object('status','existing','sourceId',existing_id); end if;
  if exists(select 1 from public.discovery_source_suppressions where workspace_id=target_workspace and provider=source_provider and board=lower(source_board)) then
    return jsonb_build_object('status','ignored');
  end if;
  if (select count(*) from public.discovery_sources where workspace_id=target_workspace) >= 50 then
    return jsonb_build_object('status','limit');
  end if;
  company_key := nullif(source_payload->>'companyId','');
  if company_key is not null and not exists(select 1 from public.companies where workspace_id=target_workspace and id=company_key) then
    raise exception 'Company not found in this workspace' using errcode='42501';
  end if;
  company_key := coalesce(company_key,'company:' || md5(source_provider || ':' || lower(source_board)));
  insert into public.companies(workspace_id,id,name,country,country_source)
    values(target_workspace,company_key,coalesce(nullif(source_payload->>'companyName',''),source_payload->>'label'),coalesce(nullif(source_payload->>'companyCountry',''),'Unknown'),nullif(source_payload->>'countrySource',''))
    on conflict(workspace_id,id) do nothing;
  select coalesce(max(position),-1)+1 into next_position from public.discovery_sources where workspace_id=target_workspace;
  insert into public.discovery_sources(workspace_id,id,kind,company_id,label,provider,board,enabled,position,discovered_from,discovered_at)
    values(target_workspace,source_payload->>'id','company_board',company_key,source_payload->>'label',source_provider,source_board,true,next_position,nullif(source_payload->>'discoveredFrom',''),coalesce(nullif(source_payload->>'discoveredAt','')::timestamptz,now()));
  update public.workspace set sources_revision=sources_revision+1,updated_at=now() where id=target_workspace;
  return jsonb_build_object('status','added','sourceId',source_payload->>'id');
end; $$;
revoke all on function public.connect_discovered_source(text,jsonb) from public,anon,authenticated;
grant execute on function public.connect_discovered_source(text,jsonb) to service_role;

notify pgrst, 'reload schema';
