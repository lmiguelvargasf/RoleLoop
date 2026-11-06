-- V2 groups source-grounded facts under their original resume sections.
-- An older extraction must be explicitly rebuilt; never relabel old facts as V2.
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
      or (cache ->> 'extractorVersion') is distinct from '2' then
      cache := 'null'::jsonb;
    end if;
    new.payload := jsonb_set(new.payload, '{profile}',
      jsonb_build_object('source', source, 'cache', cache));
  end if;
  return new;
end;
$$;

-- Keep immutable originals, search preferences, application documents and
-- activity. Clear only obsolete or mismatched derived caches.
update public.workspace set payload = payload, updated_at = now()
where jsonb_typeof(payload -> 'profile' -> 'cache') = 'object'
  and (
    payload #>> '{profile,cache,extractorVersion}' is distinct from '2'
    or payload #>> '{profile,cache,sourceId}'
      is distinct from payload #>> '{profile,source,id}'
  );
