-- A worker owns its lease for 30 seconds and renews it every 5 seconds.
-- The separate worker runtime record remains available for UI heartbeats.
create function public.acquire_worker_lease(owner text)
returns boolean language sql security definer
set search_path = public, pg_temp
as $$
  with claimed as (
    insert into public.runtime(key, payload, updated_at)
    select 'worker-lease',
      jsonb_build_object('owner', owner, 'at', now(), 'expiresAt', now() + interval '30 seconds'), now()
    where length(owner) > 0
    on conflict (key) do update
      set payload = excluded.payload, updated_at = excluded.updated_at
      where coalesce((runtime.payload->>'expiresAt')::timestamptz, '-infinity'::timestamptz) <= now()
        or runtime.payload->>'owner' = owner
    returning 1
  )
  select exists(select 1 from claimed);
$$;

create function public.renew_worker_lease(owner text)
returns boolean language sql security definer
set search_path = public, pg_temp
as $$
  with renewed as (
    update public.runtime
    set payload = jsonb_build_object('owner', owner, 'at', now(), 'expiresAt', now() + interval '30 seconds'),
      updated_at = now()
    where key = 'worker-lease' and payload->>'owner' = owner
      and (payload->>'expiresAt')::timestamptz > now()
    returning 1
  )
  select exists(select 1 from renewed);
$$;

create function public.release_worker_lease(owner text)
returns boolean language sql security definer
set search_path = public, pg_temp
as $$
  with released as (
    delete from public.runtime where key = 'worker-lease' and payload->>'owner' = owner
    returning 1
  )
  select exists(select 1 from released);
$$;

-- Serialize the brief deduplication/insert transaction across the API and worker.
-- Completed and failed runs do not prevent an intentional retry.
create function public.enqueue_run(run_payload jsonb)
returns setof public.runs language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  existing_run public.runs%rowtype;
  queued_payload jsonb;
begin
  if jsonb_typeof(run_payload) <> 'object'
    or coalesce(run_payload->>'id', '') = ''
    or coalesce(run_payload->>'action', '') not in ('discover', 'analyze', 'draft', 'research', 'simulate') then
    raise exception 'A run ID and supported action are required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('roleloop:enqueue_run', 0));
  select * into existing_run from public.runs
  where status in ('queued', 'running')
    and payload->>'action' = run_payload->>'action'
    and (payload->>'opportunityId') is not distinct from (run_payload->>'opportunityId')
    and (payload->>'sourceId') is not distinct from (run_payload->>'sourceId')
    and (payload->>'draftId') is not distinct from (run_payload->>'draftId')
  order by created_at, id limit 1;

  if found then
    return next existing_run;
    return;
  end if;

  queued_payload := run_payload || jsonb_build_object(
    'status', 'queued', 'progress', 0, 'createdAt', now(), 'updatedAt', now()
  );
  return query insert into public.runs(id, status, payload)
    values (run_payload->>'id', 'queued', queued_payload)
    returning *;
end;
$$;

revoke all on function public.acquire_worker_lease(text),
  public.renew_worker_lease(text), public.release_worker_lease(text),
  public.enqueue_run(jsonb) from public, anon, authenticated;
grant execute on function public.acquire_worker_lease(text),
  public.renew_worker_lease(text), public.release_worker_lease(text),
  public.enqueue_run(jsonb) to service_role;
