-- Subscription usage belongs to the authenticated requester, never a payload ID.
alter table public.runs add column requested_by uuid;
create or replace function public.stamp_run_requester()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and auth.role() = 'authenticated' then
    new.requested_by := auth.uid();
  elsif tg_op = 'UPDATE' and auth.role() = 'authenticated'
    and old.requested_by is distinct from auth.uid() then
    raise exception 'Only the requester can modify this task' using errcode = '42501';
  elsif tg_op = 'UPDATE' and new.requested_by is distinct from old.requested_by then
    raise exception 'The run requester is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger run_requester_guard before insert or update on public.runs
for each row execute function public.stamp_run_requester();
