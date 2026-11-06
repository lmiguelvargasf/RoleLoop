-- Workspace managers can edit operational settings but only the owner may
-- rename a workspace. Enforce this for direct Data API writes as well as HTTP.
create function public.guard_workspace_name_change()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.name is distinct from old.name
    and auth.role() = 'authenticated'
    and old.owner_user_id is distinct from auth.uid() then
    raise exception 'Only the workspace owner can rename it' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_workspace_name_change() from public, anon, authenticated;
grant execute on function public.guard_workspace_name_change() to service_role;
create trigger workspace_owner_name_guard
  before update of name on public.workspace
  for each row execute function public.guard_workspace_name_change();
