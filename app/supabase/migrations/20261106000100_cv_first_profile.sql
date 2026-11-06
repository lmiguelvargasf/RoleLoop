-- The uploaded CV owns all career facts. Legacy editable facts cannot be
-- trusted as a CV-derived cache; retain the original for one explicit rebuild.
-- Application documents, artifacts, activity and approvals are left intact.
create or replace function public.clean_workspace_profile()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  profile jsonb := new.payload -> 'profile';
  source jsonb := coalesce(profile -> 'source', 'null'::jsonb);
  cache jsonb := coalesce(profile -> 'cache', 'null'::jsonb);
begin
  if jsonb_typeof(profile) = 'object' then
    if cache ->> 'sourceId' is distinct from source ->> 'id'
      or (cache ->> 'extractorVersion') is distinct from '1' then
      cache := 'null'::jsonb;
    end if;
    new.payload := jsonb_set(new.payload, '{profile}',
      jsonb_build_object('source', source, 'cache', cache));
  end if;
  return new;
end;
$$;

update public.workspace set payload = payload, updated_at = now()
where jsonb_typeof(payload -> 'profile') = 'object';

-- Old reviewed JSON snapshots remain private and readable as history, but new
-- career information can only be derived from an immutable original CV.
drop policy workspace_resume_insert on storage.objects;
create policy workspace_resume_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.has_workspace_access((storage.foldername(name))[1])
    and (storage.foldername(name))[2] = 'resumes'
  );
