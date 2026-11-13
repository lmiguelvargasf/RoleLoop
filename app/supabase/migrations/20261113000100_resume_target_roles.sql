begin;

-- Remove the former factory pair only. Custom role lists are preserved.
update public.workspace
set payload = jsonb_set(payload, '{preferences,roles}', '[]'::jsonb),
    updated_at = now()
where payload #> '{preferences,roles}' = '["Software Engineer","Full Stack Engineer"]'::jsonb;

-- Save the completed CV and merge its role suggestions in one transaction.
-- Read preferences under the same row lock so edits made during extraction win.
create or replace function public.update_workspace_profile_if_current(
  target_workspace text,
  expected_profile jsonb,
  workspace_patch jsonb
)
returns table(id text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_workspace public.workspace%rowtype;
  merged_patch jsonb;
  merged_roles jsonb;
begin
  if jsonb_typeof(workspace_patch) is distinct from 'object' then
    raise exception 'A workspace patch object is required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(workspace_patch) as supplied(key)
    where supplied.key not in ('profile', 'preferences', 'sources', 'suggested_roles')
  ) then
    raise exception 'Only profile, preferences, sources, and resume role suggestions can be updated' using errcode = '22023';
  end if;
  if (workspace_patch ? 'profile'
      and jsonb_typeof(workspace_patch -> 'profile') is distinct from 'object')
    or (workspace_patch ? 'preferences'
      and jsonb_typeof(workspace_patch -> 'preferences') is distinct from 'object')
    or (workspace_patch ? 'sources'
      and jsonb_typeof(workspace_patch -> 'sources') is distinct from 'array') then
    raise exception 'Profile and preferences must be objects; sources must be an array' using errcode = '22023';
  end if;
  if workspace_patch ? 'suggested_roles' then
    if jsonb_typeof(workspace_patch -> 'suggested_roles') is distinct from 'array' then
      raise exception 'Role suggestions must be an array' using errcode = '22023';
    end if;
    if jsonb_array_length(workspace_patch -> 'suggested_roles') > 5
      or exists (
        select 1 from jsonb_array_elements(workspace_patch -> 'suggested_roles') as role(value)
        where jsonb_typeof(value) <> 'string' or length(btrim(value #>> '{}')) not between 1 and 120
      )
      or expected_profile is null
      or expected_profile #>> '{cache,status}' is distinct from 'processing'
      or workspace_patch #>> '{profile,cache,status}' is distinct from 'ready'
      or workspace_patch #>> '{profile,source,id}' is distinct from expected_profile #>> '{source,id}'
      or workspace_patch #>> '{profile,cache,id}' is distinct from expected_profile #>> '{cache,id}'
      or workspace_patch ? 'preferences' then
      raise exception 'Role suggestions require a completed current CV extraction' using errcode = '22023';
    end if;
  end if;

  select target.* into current_workspace
  from public.workspace as target
  where target.id = target_workspace
    and (expected_profile is null or target.payload -> 'profile' = expected_profile)
  for update;
  if not found then return; end if;

  merged_patch := workspace_patch - 'suggested_roles';
  if workspace_patch ? 'suggested_roles' then
    select coalesce(jsonb_agg(title order by position), '[]'::jsonb) into merged_roles
    from (
      select distinct on (lower(btrim(regexp_replace(value, '\s+', ' ', 'g'))))
        value as title, position
      from jsonb_array_elements_text(
        coalesce(current_workspace.payload #> '{preferences,roles}', '[]'::jsonb)
        || (workspace_patch -> 'suggested_roles')
      ) with ordinality as roles(value, position)
      where btrim(value) <> ''
      order by lower(btrim(regexp_replace(value, '\s+', ' ', 'g'))), position
    ) as unique_roles;
    merged_patch := merged_patch || jsonb_build_object(
      'preferences', (current_workspace.payload -> 'preferences') || jsonb_build_object('roles', merged_roles)
    );
  end if;
  return query
  update public.workspace as target
  set payload = target.payload || merged_patch,
      updated_at = now()
  where target.id = target_workspace
  returning target.id;
end;
$$;

revoke all on function public.update_workspace_profile_if_current(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_workspace_profile_if_current(text, jsonb, jsonb)
  to authenticated, service_role;

commit;
