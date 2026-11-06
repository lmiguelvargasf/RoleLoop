-- AI configuration is server-managed. Remove obsolete per-workspace settings.
update public.workspace
set payload = jsonb_set(payload, '{preferences}',
  (payload -> 'preferences') - 'modelMode' - 'ollamaModel'),
  updated_at = now()
where (payload -> 'preferences') ?| array['modelMode', 'ollamaModel'];
