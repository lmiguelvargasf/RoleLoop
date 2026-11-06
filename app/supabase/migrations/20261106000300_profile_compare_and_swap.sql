-- Keep large resume caches in the request body. Encoding the expected profile
-- as a PostgREST URL filter exceeds URI limits for ordinary multi-page resumes.
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
begin
  if jsonb_typeof(workspace_patch) is distinct from 'object' then
    raise exception 'A workspace patch object is required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(workspace_patch) as supplied(key)
    where supplied.key not in ('profile', 'preferences', 'sources')
  ) then
    raise exception 'Only profile, preferences, and sources can be updated' using errcode = '22023';
  end if;
  if (workspace_patch ? 'profile'
      and jsonb_typeof(workspace_patch -> 'profile') is distinct from 'object')
    or (workspace_patch ? 'preferences'
      and jsonb_typeof(workspace_patch -> 'preferences') is distinct from 'object')
    or (workspace_patch ? 'sources'
      and jsonb_typeof(workspace_patch -> 'sources') is distinct from 'array') then
    raise exception 'Profile and preferences must be objects; sources must be an array' using errcode = '22023';
  end if;
  return query
  update public.workspace as target
  set payload = target.payload || workspace_patch,
      updated_at = now()
  where target.id = target_workspace
    and (expected_profile is null or target.payload -> 'profile' = expected_profile)
  returning target.id;
end;
$$;

-- Caller privileges and the existing workspace RLS policies still apply.
-- The function cannot change ownership, membership, or workspace names.
-- Null expected_profile is used for independent preference/source updates.
revoke all on function public.update_workspace_profile_if_current(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_workspace_profile_if_current(text, jsonb, jsonb)
  to authenticated, service_role;
