-- Personal workspaces are accessible only to their owner. Historical member
-- rows are retained, but no longer grant access to records, RPCs, or documents.
create or replace function public.has_workspace_access(target_workspace text)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.owns_workspace(target_workspace);
$$;

-- Provisioning and legacy recovery still maintain owner rows internally.
-- Accounts no longer list members or grant shared access through the Data API.
revoke all on public.workspace_members from public, anon, authenticated;
drop function public.manage_workspace_member(text, uuid, text);

notify pgrst, 'reload schema';
