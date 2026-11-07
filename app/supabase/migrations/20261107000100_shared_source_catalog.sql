-- Share source identities while retaining workspace choices and existing links.
-- Apply atomically: the original table is renamed, never rebuilt or truncated.
begin;

alter table public.discovery_sources rename to workspace_sources;
alter table public.workspace_sources rename constraint discovery_sources_pkey to workspace_sources_pkey;
alter table public.workspace_sources rename constraint discovery_sources_workspace_id_fkey to workspace_sources_workspace_id_fkey;
alter table public.workspace_sources rename constraint discovery_sources_workspace_id_company_id_fkey to workspace_sources_workspace_id_company_id_fkey;
alter policy discovery_source_workspace_access on public.workspace_sources rename to workspace_source_workspace_access;

create table public.discovery_sources (
  id text primary key default gen_random_uuid()::text,
  kind text not null check (kind in ('company_board', 'job_feed', 'startup_feed')),
  provider text not null check (provider in ('ashby', 'greenhouse', 'lever', 'jobicy', 'hackernews')),
  board text not null,
  check (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  check (board = lower(board)),
  check (
    (kind = 'company_board' and provider in ('ashby', 'greenhouse', 'lever') and board ~ '^[a-z0-9][a-z0-9._-]{0,99}$')
    or (kind = 'job_feed' and provider = 'jobicy' and board = '')
    or (kind = 'startup_feed' and provider = 'hackernews' and board = '')
  ),
  unique (provider, board)
);

-- Names, company evidence and research provenance belong to a workspace. Only
-- public connector identity is deduplicated. A feed's former board is a keyword,
-- not a separate public source, and must not enter the shared catalog.
insert into public.discovery_sources(kind, provider, board)
  select distinct kind, provider,
    case when kind = 'company_board' then lower(board) else '' end
  from public.workspace_sources
  order by provider, case when kind = 'company_board' then lower(board) else '' end;
insert into public.discovery_sources(kind, provider, board)
  values ('job_feed', 'jobicy', ''), ('startup_feed', 'hackernews', '')
  on conflict(provider, board) do nothing;

alter table public.workspace_sources
  add column source_id text,
  add column keyword text not null default '';
update public.workspace_sources as connection
  set source_id = catalog.id,
      keyword = case when connection.kind = 'company_board' then '' else connection.board end
  from public.discovery_sources as catalog
  where catalog.provider = connection.provider
    and catalog.board = case when connection.kind = 'company_board' then lower(connection.board) else '' end;
alter table public.workspace_sources
  alter column source_id set not null,
  add constraint workspace_sources_source_id_fkey foreign key(source_id) references public.discovery_sources(id);

drop index public.discovery_sources_identity;
-- PostgreSQL removes the old checks on these columns. Workspace/company foreign
-- keys and the opportunity FK to (workspace_id,id) remain attached to this table.
alter table public.workspace_sources drop column kind, drop column provider, drop column board;
create unique index workspace_sources_identity on public.workspace_sources(workspace_id, source_id, lower(keyword));
create index workspace_sources_catalog on public.workspace_sources(source_id);

create function public.validate_workspace_source() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare source_kind text;
begin
  select kind into source_kind from public.discovery_sources where id = new.source_id;
  if not found then
    raise exception 'Source not found in the shared catalog' using errcode = '23503';
  end if;
  if new.id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'
    or (source_kind = 'company_board' and (new.company_id is null or new.keyword <> ''))
    or (source_kind <> 'company_board' and new.company_id is not null) then
    raise exception 'Source settings do not match the shared source kind' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke all on function public.validate_workspace_source() from public, anon, authenticated;
create trigger workspace_source_kind before insert or update on public.workspace_sources
  for each row execute function public.validate_workspace_source();

alter table public.discovery_sources enable row level security;
revoke all on public.discovery_sources, public.workspace_sources from public, anon, authenticated;
grant select on public.discovery_sources, public.workspace_sources to authenticated;
grant all on public.discovery_sources, public.workspace_sources to service_role;
create policy shared_source_workspace_access on public.discovery_sources
  for select to authenticated using (
    exists (
      select 1 from public.workspace_sources as connection
      where connection.source_id = discovery_sources.id
        and public.has_workspace_access(connection.workspace_id)
    )
  );

create or replace function public.normalize_workspace_discovery() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s jsonb;
  company_key text;
  source_kind text;
  source_provider text;
  source_board text;
  catalog_key text;
  source_ids text[] := '{}';
  pos integer := 0;
  original_companies jsonb;
begin
  if not (new.payload ? 'sources') then return new; end if;
  if jsonb_typeof(new.payload->'sources') is distinct from 'array'
    or jsonb_array_length(new.payload->'sources') > 50 then
    raise exception 'Sources must be an array of at most 50 entries' using errcode = '22023';
  end if;

  -- Validate before catalog registration. In particular, an authenticated caller
  -- cannot bypass the application and add arbitrary URLs as shared identities.
  for s in select value from jsonb_array_elements(new.payload->'sources') loop
    source_provider := s->>'provider';
    source_board := s->>'board';
    if jsonb_typeof(s) is distinct from 'object'
      or jsonb_typeof(s->'id') is distinct from 'string'
      or coalesce(s->>'id', '') !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'
      or (s->>'id') = any(source_ids)
      or coalesce(source_provider, '') not in ('ashby', 'greenhouse', 'lever', 'jobicy', 'hackernews')
      or jsonb_typeof(s->'board') is distinct from 'string'
      or jsonb_typeof(s->'label') is distinct from 'string'
      or (source_provider in ('ashby', 'greenhouse', 'lever') and source_board !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$') then
      raise exception 'Source identifiers and connector settings must be valid and unique' using errcode = '22023';
    end if;
    source_ids := array_append(source_ids, s->>'id');
  end loop;

  -- Every workspace registers catalog identities in the same order, avoiding
  -- crossed unique-key waits when different workspaces add overlapping lists.
  insert into public.discovery_sources(kind, provider, board)
    select distinct
      case value->>'provider' when 'hackernews' then 'startup_feed' when 'jobicy' then 'job_feed' else 'company_board' end,
      value->>'provider',
      case when value->>'provider' in ('jobicy', 'hackernews') then '' else lower(value->>'board') end
    from jsonb_array_elements(new.payload->'sources')
    order by 2, 3
    on conflict(provider, board) do nothing;

  select coalesce(jsonb_object_agg(id, jsonb_build_object('name', name, 'country', country, 'country_source', country_source)), '{}'::jsonb)
    into original_companies from public.companies where workspace_id = new.id;
  insert into public.discovery_source_suppressions(workspace_id, provider, board)
    select connection.workspace_id, catalog.provider, catalog.board
    from public.workspace_sources as connection
    join public.discovery_sources as catalog on catalog.id = connection.source_id
    where connection.workspace_id = new.id and catalog.kind = 'company_board' and not exists (
      select 1 from jsonb_array_elements(new.payload->'sources') wanted
      where wanted->>'provider' = catalog.provider and lower(wanted->>'board') = catalog.board
    )
    on conflict(workspace_id, provider, board) do update set removed_at = now();

  -- Release removed/replaced connection identities before their replacements.
  -- Deleting a connection preserves opportunity payloads and private company facts.
  delete from public.workspace_sources as connection
    using public.discovery_sources as catalog
    where catalog.id = connection.source_id and connection.workspace_id = new.id and (
      not exists(select 1 from jsonb_array_elements(new.payload->'sources') wanted where wanted->>'id' = connection.id)
      or exists(
        select 1 from jsonb_array_elements(new.payload->'sources') wanted
        where wanted->>'id' = connection.id and (
          wanted->>'provider' is distinct from catalog.provider
          or lower(wanted->>'board') is distinct from
            case when catalog.kind = 'company_board' then catalog.board else lower(connection.keyword) end
        )
      )
    );

  for s in select value from jsonb_array_elements(new.payload->'sources') loop
    source_provider := s->>'provider';
    source_kind := case source_provider when 'hackernews' then 'startup_feed' when 'jobicy' then 'job_feed' else 'company_board' end;
    source_board := case when source_kind = 'company_board' then lower(s->>'board') else '' end;
    select id into catalog_key from public.discovery_sources where provider = source_provider and board = source_board;
    company_key := null;
    if source_kind = 'company_board' then
      company_key := coalesce(nullif(s->>'companyId', ''), 'company:' || md5(source_provider || ':' || source_board));
      insert into public.companies(workspace_id, id, name, country, country_source)
        values(new.id, company_key, coalesce(nullif(s->>'companyName', ''), s->>'label'), coalesce(nullif(s->>'companyCountry', ''), 'Unknown'), nullif(s->>'countrySource', ''))
        on conflict(workspace_id, id) do update set
          name = case when excluded.name is distinct from original_companies->company_key->>'name' then excluded.name else companies.name end,
          country = case when excluded.country is distinct from original_companies->company_key->>'country' then excluded.country else companies.country end,
          country_source = case when excluded.country_source is distinct from original_companies->company_key->>'country_source' then excluded.country_source else companies.country_source end,
          updated_at = now();
      delete from public.discovery_source_suppressions
        where workspace_id = new.id and provider = source_provider and board = source_board;
    end if;
    insert into public.workspace_sources(workspace_id, id, source_id, company_id, label, keyword, enabled, position, discovered_from, discovered_at)
      values(new.id, s->>'id', catalog_key, company_key, s->>'label',
        case when source_kind = 'company_board' then '' else s->>'board' end,
        coalesce((s->>'enabled')::boolean, true), pos, nullif(s->>'discoveredFrom', ''), nullif(s->>'discoveredAt', '')::timestamptz)
      on conflict(workspace_id, id) do update set
        source_id = excluded.source_id,
        company_id = excluded.company_id,
        label = excluded.label,
        keyword = excluded.keyword,
        enabled = excluded.enabled,
        position = excluded.position,
        discovered_from = coalesce(excluded.discovered_from, workspace_sources.discovered_from),
        discovered_at = coalesce(excluded.discovered_at, workspace_sources.discovered_at);
    pos := pos + 1;
  end loop;
  delete from public.workspace_sources where workspace_id = new.id and not (id = any(source_ids));
  update public.workspace set payload = payload - 'sources', sources_revision = sources_revision + 1 where id = new.id;
  return new;
end; $$;

create or replace function public.connect_discovered_source(target_workspace text, source_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  workspace_payload jsonb;
  existing_id text;
  company_key text;
  source_provider text;
  source_board text;
  catalog_key text;
  next_position integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the discovery worker can connect discovered employers' using errcode = '42501';
  end if;
  select payload into workspace_payload from public.workspace where id = target_workspace for update;
  if not found then raise exception 'Workspace not found' using errcode = '42501'; end if;
  if coalesce((workspace_payload#>>'{preferences,discoverEmployers}')::boolean, true) = false then
    return jsonb_build_object('status', 'ignored');
  end if;
  source_provider := source_payload->>'provider';
  source_board := lower(source_payload->>'board');
  if jsonb_typeof(source_payload) is distinct from 'object'
    or coalesce(source_provider, '') not in ('ashby', 'greenhouse', 'lever')
    or jsonb_typeof(source_payload->'board') is distinct from 'string'
    or coalesce(source_board, '') !~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    or coalesce(source_payload->>'id', '') !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'
    or length(trim(coalesce(source_payload->>'label', ''))) = 0 then
    raise exception 'A valid company board is required' using errcode = '22023';
  end if;
  select connection.id into existing_id
    from public.workspace_sources as connection
    join public.discovery_sources as catalog on catalog.id = connection.source_id
    where connection.workspace_id = target_workspace and catalog.provider = source_provider and catalog.board = source_board;
  if found then return jsonb_build_object('status', 'existing', 'sourceId', existing_id); end if;
  if exists(select 1 from public.discovery_source_suppressions where workspace_id = target_workspace and provider = source_provider and board = source_board) then
    return jsonb_build_object('status', 'ignored');
  end if;
  if (select count(*) from public.workspace_sources where workspace_id = target_workspace) >= 50 then
    return jsonb_build_object('status', 'limit');
  end if;
  company_key := nullif(source_payload->>'companyId', '');
  if company_key is not null and not exists(select 1 from public.companies where workspace_id = target_workspace and id = company_key) then
    raise exception 'Company not found in this workspace' using errcode = '42501';
  end if;

  insert into public.discovery_sources(kind, provider, board)
    values('company_board', source_provider, source_board)
    on conflict(provider, board) do nothing;
  select id into catalog_key from public.discovery_sources where provider = source_provider and board = source_board;
  company_key := coalesce(company_key, 'company:' || md5(source_provider || ':' || source_board));
  insert into public.companies(workspace_id, id, name, country, country_source)
    values(target_workspace, company_key, coalesce(nullif(source_payload->>'companyName', ''), source_payload->>'label'), coalesce(nullif(source_payload->>'companyCountry', ''), 'Unknown'), nullif(source_payload->>'countrySource', ''))
    on conflict(workspace_id, id) do nothing;
  select coalesce(max(position), -1) + 1 into next_position from public.workspace_sources where workspace_id = target_workspace;
  insert into public.workspace_sources(workspace_id, id, source_id, company_id, label, keyword, enabled, position, discovered_from, discovered_at)
    values(target_workspace, source_payload->>'id', catalog_key, company_key, source_payload->>'label', '', true, next_position,
      nullif(source_payload->>'discoveredFrom', ''), coalesce(nullif(source_payload->>'discoveredAt', '')::timestamptz, now()));
  update public.workspace set sources_revision = sources_revision + 1, updated_at = now() where id = target_workspace;
  return jsonb_build_object('status', 'added', 'sourceId', source_payload->>'id');
end; $$;

create or replace function public.link_opportunity_company() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare connected_company text; company_key text;
begin
  new.discovery_source_id := null;
  select id, company_id into new.discovery_source_id, connected_company from public.workspace_sources
    where workspace_id = new.workspace_id and id = new.payload->>'sourceId';
  company_key := connected_company;
  if company_key is null and nullif(new.payload->>'companyId', '') is not null then
    if not exists(select 1 from public.companies where workspace_id = new.workspace_id and id = new.payload->>'companyId') then
      raise exception 'Company not found in this workspace' using errcode = '42501';
    end if;
    company_key := new.payload->>'companyId';
  end if;
  if company_key is null and new.company_id is not null and exists(select 1 from public.companies where workspace_id = new.workspace_id and id = new.company_id) then
    company_key := new.company_id;
  end if;
  if company_key is null and length(trim(coalesce(new.payload->>'company', ''))) > 0 then
    company_key := 'company:' || md5(coalesce(new.payload->>'source', 'manual') || ':' || lower(trim(new.payload->>'company')));
    insert into public.companies(workspace_id, id, name, country, country_source, website)
      values(new.workspace_id, company_key, new.payload->>'company', coalesce(new.payload->>'companyCountry', 'Unknown'), new.payload->>'companyCountrySource', nullif(new.payload->>'companyUrl', ''))
      on conflict(workspace_id, id) do nothing;
  end if;
  new.company_id := company_key;
  return new;
end; $$;

-- Existing RPC permissions remain in place after CREATE OR REPLACE; repeat them
-- explicitly so catalog writes never become a new authenticated-user endpoint.
revoke all on function public.normalize_workspace_discovery() from public, anon, authenticated;
revoke all on function public.connect_discovered_source(text, jsonb) from public, anon, authenticated;
grant execute on function public.connect_discovered_source(text, jsonb) to service_role;
revoke all on function public.link_opportunity_company() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
