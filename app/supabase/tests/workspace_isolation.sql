\set ON_ERROR_STOP on
\o /dev/null
begin;

-- Everything, including temporary Auth users and the initial-owner claim, rolls
-- back. Test identities never become usable accounts or touch another session.
create function pg_temp.assert_true(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then raise exception 'Assertion failed: %', label; end if;
end;
$$;
select gen_random_uuid() as user_a, gen_random_uuid() as user_b, gen_random_uuid() as user_c \gset
select set_config('roleloop.test.user_a', :'user_a', true),
       set_config('roleloop.test.user_b', :'user_b', true),
       set_config('roleloop.test.user_c', :'user_c', true);
insert into auth.users(id, email)
values (:'user_a'::uuid, :'user_a' || '@roleloop.test'),
       (:'user_b'::uuid, :'user_b' || '@roleloop.test'),
       (:'user_c'::uuid, :'user_c' || '@roleloop.test');
select exists(select 1 from public.app_admins) as already_has_admin \gset

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
select id as workspace_a from public.ensure_workspace('{}'::jsonb) \gset
select set_config('roleloop.test.workspace_a', :'workspace_a', true);
select pg_temp.assert_true((select id = :'workspace_a' from public.ensure_workspace('{"changed":true}'::jsonb)), 'provisioning is idempotent');
select pg_temp.assert_true((select count(*) = 0 from public.workspace where id = 'default'), 'signup cannot claim legacy workspace');
select pg_temp.assert_true((select owner_user_id = :'user_a'::uuid from public.workspace where id = :'workspace_a'), 'new account owns its personal workspace');
insert into public.opportunities(id, workspace_id, kind, source_key, payload)
values (:'workspace_a' || '-op', :'workspace_a', 'job', 'shared-source-key', '{}');
insert into public.drafts(id, workspace_id, opportunity_id, payload)
values (:'workspace_a' || '-draft', :'workspace_a', :'workspace_a' || '-op', '{}');
insert into public.workspace_runtime(workspace_id, key, payload)
values (:'workspace_a', 'corrections:test', '{"private":"a"}');
select id as run_a from public.enqueue_run(:'workspace_a', jsonb_build_object('id', gen_random_uuid()::text, 'action', 'discover', 'sourceId', 'shared-source', 'workspaceId', 'forged-workspace')) \gset
select set_config('roleloop.test.run_a', :'run_a', true);
select pg_temp.assert_true((select id = :'run_a' from public.enqueue_run(:'workspace_a', jsonb_build_object('id', gen_random_uuid()::text, 'action', 'discover', 'sourceId', 'shared-source'))), 'same-workspace queue deduplication');
select pg_temp.assert_true((select payload->>'workspaceId' = :'workspace_a' from public.runs where id = :'run_a'), 'queue stores authoritative workspace');

select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_b', 'role', 'authenticated')::text, true);
select id as workspace_b from public.ensure_workspace('{}'::jsonb) \gset
select set_config('roleloop.test.workspace_b', :'workspace_b', true);
insert into public.opportunities(id, workspace_id, kind, source_key, payload)
values (:'workspace_b' || '-op', :'workspace_b', 'job', 'shared-source-key', '{}');
select pg_temp.assert_true((select count(*) = 1 from public.opportunities where source_key = 'shared-source-key'), 'same source allowed separately and only own row visible');
select pg_temp.assert_true((select count(*) = 0 from public.opportunities where workspace_id = :'workspace_a'), 'cross-workspace opportunities hidden');
select pg_temp.assert_true((select count(*) = 0 from public.drafts where workspace_id = :'workspace_a'), 'cross-workspace drafts hidden');
select pg_temp.assert_true((select count(*) = 0 from public.runs where workspace_id = :'workspace_a'), 'cross-workspace runs hidden');
select pg_temp.assert_true((select count(*) = 0 from public.workspace_runtime where workspace_id = :'workspace_a'), 'cross-workspace corrections hidden');
select pg_temp.assert_true((select id <> :'run_a' from public.enqueue_run(:'workspace_b', jsonb_build_object('id', gen_random_uuid()::text, 'action', 'discover', 'sourceId', 'shared-source'))), 'different workspaces do not deduplicate each other');

do $$
declare affected integer;
begin
  begin
    insert into public.opportunities(id,workspace_id,kind,source_key,payload)
      values(gen_random_uuid()::text,current_setting('roleloop.test.workspace_a'),'job','forbidden','{}');
    raise exception 'Cross-workspace insert unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  update public.opportunities set payload='{"corrupted":true}' where workspace_id=current_setting('roleloop.test.workspace_a');
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Cross-workspace update unexpectedly succeeded'; end if;
  delete from public.drafts where workspace_id=current_setting('roleloop.test.workspace_a');
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Cross-workspace deletion unexpectedly succeeded'; end if;
  begin
    insert into public.drafts(id,workspace_id,opportunity_id,payload)
      values(gen_random_uuid()::text,current_setting('roleloop.test.workspace_b'),current_setting('roleloop.test.workspace_a')||'-op','{}');
    raise exception 'Cross-workspace foreign key unexpectedly succeeded';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.drafts(id,workspace_id,opportunity_id,payload)
      values('../escaped',current_setting('roleloop.test.workspace_b'),current_setting('roleloop.test.workspace_b')||'-op','{}');
    raise exception 'Unsafe document ID unexpectedly succeeded';
  exception when check_violation then null; end;
  begin
    insert into public.events(id,workspace_id,payload)
      values(gen_random_uuid()::text,current_setting('roleloop.test.workspace_b'),'[]');
    raise exception 'Non-object payload unexpectedly succeeded';
  exception when check_violation then null; end;
  begin
    insert into public.opportunities(id,workspace_id,kind,source_key,payload)
      values(gen_random_uuid()::text,current_setting('roleloop.test.workspace_b'),'job','shared-source-key','{}');
    raise exception 'Duplicate source within one workspace unexpectedly succeeded';
  exception when unique_violation then null; end;
  begin
    perform public.enqueue_run(current_setting('roleloop.test.workspace_a'),jsonb_build_object('id',gen_random_uuid()::text,'action','discover'));
    raise exception 'Cross-workspace queue access unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    perform public.enqueue_run(current_setting('roleloop.test.workspace_b'),jsonb_build_object('id',gen_random_uuid()::text,'action','analyze','opportunityId',current_setting('roleloop.test.workspace_a')||'-op'));
    raise exception 'Cross-workspace queue reference unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    update public.workspace set owner_user_id=current_setting('roleloop.test.user_b')::uuid where id=current_setting('roleloop.test.workspace_b');
    raise exception 'Direct ownership update unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    perform user_id from public.workspace_members;
    raise exception 'User read historical membership records';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.workspace_members(workspace_id,user_id,role)
      values(current_setting('roleloop.test.workspace_a'),current_setting('roleloop.test.user_b')::uuid,'owner');
    raise exception 'Self-granted membership unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.app_admins(user_id) values(current_setting('roleloop.test.user_b')::uuid);
    raise exception 'Self-granted administration unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_initial_owner(current_setting('roleloop.test.user_b')::uuid,repeat('a',64));
    raise exception 'User invoked privileged setup RPC';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_run();
    raise exception 'User invoked worker claim RPC';
  exception when insufficient_privilege then null; end;
  begin
    perform payload from public.runtime;
    raise exception 'User read global runtime secrets';
  exception when insufficient_privilege then null; end;
end;
$$;

-- Owners retain their workspace and data; old manager rows no longer authorize
-- reads, writes, storage, or queued work, even with the same authenticated JWT.
select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
update public.workspace set name='Owner-renamed workspace' where id=:'workspace_a';
select pg_temp.assert_true((select name='Owner-renamed workspace' from public.workspace where id=:'workspace_a'), 'owner can rename their workspace');
select pg_temp.assert_true(to_regprocedure('public.manage_workspace_member(text,uuid,text)') is null, 'workspace sharing RPC is removed');
reset role;
insert into public.workspace_members(workspace_id,user_id,role)
values (:'workspace_a', :'user_b'::uuid, 'manager');
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_b', 'role', 'authenticated')::text, true);
select pg_temp.assert_true(not public.has_workspace_access(:'workspace_a'), 'old manager membership grants no access');
select pg_temp.assert_true((select count(*) = 0 from public.workspace where id = :'workspace_a'), 'old manager cannot read workspace');
select pg_temp.assert_true((select count(*) = 0 from public.opportunities where workspace_id = :'workspace_a'), 'old manager cannot read opportunities');
select pg_temp.assert_true((select count(*) = 0 from public.drafts where workspace_id = :'workspace_a'), 'old manager cannot read drafts');
select pg_temp.assert_true((select count(*) = 0 from public.runs where workspace_id = :'workspace_a'), 'old manager cannot read runs');
select pg_temp.assert_true((select count(*) = 0 from public.workspace_runtime where workspace_id = :'workspace_a'), 'old manager cannot read corrections');
do $$
declare affected integer;
begin
  update public.opportunities set payload='{"corrupted":true}' where workspace_id=current_setting('roleloop.test.workspace_a');
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Old manager edited opportunities'; end if;
  update public.workspace set payload='{"corrupted":true}' where id=current_setting('roleloop.test.workspace_a');
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Old manager edited workspace settings'; end if;
  update public.workspace set name='Unauthorized rename' where id=current_setting('roleloop.test.workspace_a');
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Old manager renamed workspace'; end if;
  begin
    perform public.enqueue_run(current_setting('roleloop.test.workspace_a'),jsonb_build_object('id',gen_random_uuid()::text,'action','discover'));
    raise exception 'Old manager enqueued workspace work';
  exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
select pg_temp.assert_true((select payload='{}'::jsonb from public.opportunities where workspace_id=:'workspace_a'), 'owner opportunities are unchanged');
select pg_temp.assert_true((select payload='{}'::jsonb and name='Owner-renamed workspace' from public.workspace where id=:'workspace_a'), 'owner workspace is unchanged');

reset role;
insert into storage.objects(bucket_id,name)
values ('documents', :'workspace_a'||'/drafts/file.pdf'),
       ('documents', :'workspace_b'||'/drafts/file.pdf'),
       ('documents', 'drafts/legacy-'||:'workspace_a'||'.pdf');
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
select pg_temp.assert_true((select count(*) = 1 from storage.objects where bucket_id='documents' and name=:'workspace_a'||'/drafts/file.pdf'), 'own document visible');
select pg_temp.assert_true((select count(*) = 0 from storage.objects where bucket_id='documents' and name=:'workspace_b'||'/drafts/file.pdf'), 'another workspace document hidden');
select pg_temp.assert_true((select count(*) = 0 from storage.objects where bucket_id='documents' and name='drafts/legacy-'||:'workspace_a'||'.pdf'), 'legacy unscoped document stays private');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'user_b', 'role', 'authenticated')::text, true);
select pg_temp.assert_true((select count(*) = 0 from storage.objects where bucket_id='documents' and name=:'workspace_a'||'/drafts/file.pdf'), 'old manager cannot read owner document');
select pg_temp.assert_true((select count(*) = 1 from storage.objects where bucket_id='documents' and name=:'workspace_b'||'/drafts/file.pdf'), 'old manager retains their own document');

-- On an unclaimed local installation, exercise successful setup and replay
-- protection inside the transaction. Never remove an existing administrator.
reset role;
\if :already_has_admin
  \echo 'Initial owner already configured; bootstrap success case is skipped.'
\else
  insert into public.runtime(key,payload)
  values ('owner-setup',jsonb_build_object('tokenHash',repeat('a',64),'expiresAt',now()-interval '5 minutes'))
  on conflict(key) do update set payload=excluded.payload;
  set local role service_role;
  select set_config('request.jwt.claims','{"role":"service_role"}',true);
  do $$ begin
    begin
      perform public.claim_initial_owner(current_setting('roleloop.test.user_a')::uuid,repeat('a',64));
      raise exception 'Expired setup token was accepted';
    exception when insufficient_privilege then null; end;
  end; $$;
  update public.runtime set payload=jsonb_build_object('tokenHash',repeat('a',64),'expiresAt',now()+interval '5 minutes') where key='owner-setup';
  do $$ begin
    begin
      perform public.claim_initial_owner(current_setting('roleloop.test.user_a')::uuid,repeat('b',64));
      raise exception 'Incorrect setup token was accepted';
    exception when insufficient_privilege then null; end;
  end; $$;
  select id as claimed_workspace from public.claim_initial_owner(:'user_a'::uuid,repeat('a',64)) \gset
  select pg_temp.assert_true((select owner_user_id=:'user_a'::uuid from public.workspace where id=:'claimed_workspace'), 'bootstrap assigns verified owner');
  select pg_temp.assert_true((select count(*)=1 from public.app_admins where user_id=:'user_a'::uuid), 'bootstrap appoints initial administrator');
  select pg_temp.assert_true((select count(*)=0 from public.runtime where key='owner-setup'), 'bootstrap consumes setup token');
  do $$ begin
    begin
      perform public.claim_initial_owner(current_setting('roleloop.test.user_b')::uuid,repeat('a',64));
      raise exception 'Setup token was replayed';
    exception when insufficient_privilege then null; end;
  end; $$;
  reset role;
  set local role authenticated;
  select set_config('request.jwt.claims',jsonb_build_object('sub',:'user_a','role','authenticated')::text,true);
  select pg_temp.assert_true((select count(*)=1 from public.workspace where id=:'claimed_workspace'), 'claimed owner can access preserved workspace');
  select pg_temp.assert_true((select count(*)=0 from public.workspace where id=:'workspace_b'), 'app administrator has no automatic access to other workspaces');
\endif

reset role;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$ begin
  begin
    perform id from public.workspace;
    raise exception 'Anonymous account read workspace data';
  exception when insufficient_privilege then null; end;
  begin
    perform public.ensure_workspace('{}'::jsonb);
    raise exception 'Anonymous account provisioned a workspace';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
rollback;
\o
select 'All workspace isolation assertions passed; test data rolled back.' as result;
