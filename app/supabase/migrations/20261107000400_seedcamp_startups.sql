-- Register the public Seedcamp company portfolio. Built-in startup sources do
-- not create workspace subscriptions; explicit keywords and pauses remain intact.
begin;

-- PostgreSQL's generated names differ between fresh installs and upgrades.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.discovery_sources'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%jobicy%'
  loop
    execute format('alter table public.discovery_sources drop constraint %I', constraint_name);
  end loop;
end; $$;
alter table public.discovery_sources
  add constraint discovery_sources_provider_check
    check (provider in ('ashby', 'greenhouse', 'lever', 'jobicy', 'weworkremotely', 'hackernews', 'seedcamp')),
  add constraint discovery_sources_connector_check check (
    (kind = 'company_board' and provider in ('ashby', 'greenhouse', 'lever') and board ~ '^[a-z0-9][a-z0-9._-]{0,99}$')
    or (kind = 'job_feed' and provider in ('jobicy', 'weworkremotely') and board = '')
    or (kind = 'startup_feed' and provider in ('hackernews', 'seedcamp') and board = '')
  );
insert into public.discovery_sources(kind, provider, board)
  values ('startup_feed', 'seedcamp', '') on conflict(provider, board) do nothing;

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
      or coalesce(source_provider, '') not in ('ashby', 'greenhouse', 'lever', 'jobicy', 'weworkremotely', 'hackernews', 'seedcamp')
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
      case value->>'provider' when 'hackernews' then 'startup_feed' when 'seedcamp' then 'startup_feed' when 'jobicy' then 'job_feed' when 'weworkremotely' then 'job_feed' else 'company_board' end,
      value->>'provider',
      case when value->>'provider' in ('jobicy', 'weworkremotely', 'hackernews', 'seedcamp') then '' else lower(value->>'board') end
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
    source_kind := case source_provider when 'hackernews' then 'startup_feed' when 'seedcamp' then 'startup_feed' when 'jobicy' then 'job_feed' when 'weworkremotely' then 'job_feed' else 'company_board' end;
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

revoke all on function public.normalize_workspace_discovery() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
