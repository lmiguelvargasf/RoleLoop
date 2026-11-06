-- Members may add immutable source documents and reviewed profile versions.
-- Reads use the existing workspace_document_read policy; replacements use new IDs.
create policy workspace_resume_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.has_workspace_access((storage.foldername(name))[1])
    and (storage.foldername(name))[2] in ('resumes', 'profile-versions')
  );
