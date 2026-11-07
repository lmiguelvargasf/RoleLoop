-- Editing a startup can now conflict with another saved company website.
-- Persist the opportunity and its source-refresh corrections together so a
-- rejected edit cannot poison the next discovery refresh.
create function public.save_startup_with_corrections(
  target_workspace text,
  target_opportunity text,
  opportunity_payload jsonb,
  correction_patch jsonb
) returns setof public.opportunities
language plpgsql security invoker set search_path = public, pg_temp as $$
declare original public.opportunities%rowtype; saved public.opportunities%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_workspace_access(target_workspace) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  if jsonb_typeof(opportunity_payload) is distinct from 'object'
    or jsonb_typeof(correction_patch) is distinct from 'object' then
    raise exception 'Opportunity and corrections must be objects' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(correction_patch) as supplied(key)
    where supplied.key not in (
      'company', 'companyId', 'title', 'description', 'descriptionTruncated',
      'requirementsTruncated', 'url', 'companyUrl', 'location', 'companyCountry',
      'companyCountrySource', 'remoteScope', 'salaryMin', 'salaryMax', 'salaryCurrency',
      'salaryPeriod', 'publishedAt', 'requirements', 'signals', 'contactName',
      'contactEmail', 'contactSource', 'notes'
    )
  ) then
    raise exception 'Only editable startup facts can be saved as corrections' using errcode = '22023';
  end if;
  select * into original from public.opportunities
    where workspace_id = target_workspace and id = target_opportunity for update;
  if not found then
    raise exception 'Startup not found in this workspace' using errcode = '42501';
  end if;
  if original.kind <> 'startup'
    or opportunity_payload->>'id' is distinct from original.id
    or opportunity_payload->>'kind' is distinct from original.kind
    or opportunity_payload->>'sourceKey' is distinct from original.source_key then
    raise exception 'Startup edits cannot change opportunity identity' using errcode = '22023';
  end if;

  update public.opportunities set payload = opportunity_payload
    where workspace_id = target_workspace and id = target_opportunity returning * into saved;
  if correction_patch <> '{}'::jsonb then
    insert into public.workspace_runtime(workspace_id, key, payload, updated_at)
      values(target_workspace, 'corrections:' || target_opportunity, correction_patch, clock_timestamp())
    on conflict(workspace_id, key) do update set
      payload = workspace_runtime.payload || excluded.payload,
      updated_at = clock_timestamp();
  end if;
  return next saved;
end;
$$;
revoke all on function public.save_startup_with_corrections(text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_startup_with_corrections(text, text, jsonb, jsonb) to authenticated, service_role;
notify pgrst, 'reload schema';
