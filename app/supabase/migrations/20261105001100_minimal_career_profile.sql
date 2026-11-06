-- Keep source career facts; compose positioning per opportunity and read email
-- from the workspace owner's Auth account. Do not rewrite historical documents.
update public.workspace
set payload = jsonb_set(
  payload,
  '{profile}',
  (payload -> 'profile') - array['headline', 'summary', 'learning', 'email', 'skills']
), updated_at = now()
where jsonb_typeof(payload -> 'profile') = 'object'
  and (payload -> 'profile') ?| array['headline', 'summary', 'learning', 'email', 'skills'];

-- Old clients and future writes must not reintroduce retired profile fields.
create function public.clean_workspace_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if jsonb_typeof(new.payload -> 'profile') = 'object' then
    new.payload := jsonb_set(
      new.payload,
      '{profile}',
      (new.payload -> 'profile') - array['headline', 'summary', 'learning', 'email', 'skills']
    );
  end if;
  return new;
end;
$$;

create trigger clean_workspace_profile
before insert or update of payload on public.workspace
for each row execute function public.clean_workspace_profile();
