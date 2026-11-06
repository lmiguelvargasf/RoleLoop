-- Search preferences are the single source of the candidate's working country.
-- Preserve a legacy profile country only when no preference has been set.
update public.workspace
set payload = jsonb_set(
  payload #- '{profile,location}' #- '{profile,country}',
  '{preferences,country}',
  to_jsonb(coalesce(
    nullif(btrim(payload #>> '{preferences,country}'), ''),
    nullif(btrim(payload #>> '{profile,country}'), ''),
    ''
  ))
), updated_at = now()
where (payload -> 'profile') ?| array['location', 'country'];
