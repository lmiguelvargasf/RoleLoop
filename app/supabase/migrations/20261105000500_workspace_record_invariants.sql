-- IDs may enter file/object paths in the trusted worker, so even direct
-- authenticated Data API writes must obey the same conservative character set.
alter table public.workspace
  add constraint workspace_safe_id check (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  add constraint workspace_payload_object check (jsonb_typeof(payload) = 'object');
alter table public.opportunities
  add constraint opportunities_safe_id check (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  add constraint opportunities_payload_object check (jsonb_typeof(payload) = 'object');
alter table public.drafts
  add constraint drafts_safe_id check (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  add constraint drafts_payload_object check (jsonb_typeof(payload) = 'object');
alter table public.runs
  add constraint runs_safe_id check (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  add constraint runs_payload_object check (jsonb_typeof(payload) = 'object');
alter table public.events
  add constraint events_safe_id check (id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  add constraint events_payload_object check (jsonb_typeof(payload) = 'object');
alter table public.runtime
  add constraint runtime_payload_object check (jsonb_typeof(payload) = 'object');
alter table public.workspace_runtime
  add constraint workspace_runtime_payload_object check (jsonb_typeof(payload) = 'object');
