import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("Himalayas source migration", () => {
  it("adds one feed to eligible workspaces while preserving paused choices and source limits", () => {
    // Keep the entire migration, including its DDL and append, inside this
    // test's rollback. Its production transaction boundaries must be removed.
    const migration = readFileSync(
      fileURLToPath(new URL(
        "../supabase/migrations/20261108000100_himalayas_job_feed.sql",
        import.meta.url,
      )),
      "utf8",
    ).replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "");
    const output = execFileSync("docker", [
      "exec", "-i", "supabase_db_roleloop-ts", "psql", "-X", "-q",
      "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    ], {
      encoding: "utf8",
      timeout: 20000,
      input: `begin;
        ${migration}
        insert into public.workspace(id, payload) values
          ('integration-himalayas-eligible', '{"preferences":{"discoverEmployers":true,"country":"Ecuador","minimumSalary":123456},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My feed","board":"typescript","enabled":true}]}'),
          ('integration-himalayas-paused-discovery', '{"preferences":{"discoverEmployers":false},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My feed","board":"","enabled":true}]}'),
          ('integration-himalayas-paused-sources', '{"preferences":{"discoverEmployers":true},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My paused feed","board":"","enabled":false}]}'),
          ('integration-himalayas-disabled', '{"preferences":{"discoverEmployers":true},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My feed","board":"","enabled":true},{"id":"paused-himalayas","provider":"himalayas","label":"My paused Himalayas","board":"design","enabled":false}]}'),
          ('integration-himalayas-empty', '{"preferences":{"discoverEmployers":true},"sources":[]}');
        insert into public.workspace(id, payload)
          select 'integration-himalayas-cap', jsonb_build_object(
            'preferences', jsonb_build_object('discoverEmployers', true),
            'sources', jsonb_agg(jsonb_build_object(
              'id', 'capped-' || number, 'provider', 'ashby',
              'board', 'integration-himalayas-cap-' || number,
              'label', 'Capped employer ' || number, 'enabled', true
            ))) from generate_series(1, 50) as number;
        create temp table himalayas_workspaces_before as
          select id, payload, sources_revision from public.workspace where id like 'integration-himalayas-%';
        create temp table himalayas_connections_before as
          select workspace_id, id, to_jsonb(connection) as record
          from public.workspace_sources connection where workspace_id like 'integration-himalayas-%';
        ${migration}
        do $$ begin
          if (select count(*) from public.workspace_sources connection
              join public.discovery_sources catalog on catalog.id = connection.source_id
              where connection.workspace_id = 'integration-himalayas-eligible' and catalog.provider = 'himalayas'
                and connection.enabled and connection.company_id is null and connection.keyword = '') <> 1
          then raise exception 'Eligible workspace did not receive exactly one enabled independent feed'; end if;
          if exists(select 1 from public.workspace_sources connection
              join public.discovery_sources catalog on catalog.id = connection.source_id
              where connection.workspace_id in ('integration-himalayas-paused-discovery', 'integration-himalayas-paused-sources', 'integration-himalayas-empty', 'integration-himalayas-cap')
                and catalog.provider = 'himalayas')
          then raise exception 'Paused, empty, or capped workspace was expanded'; end if;
          if (select count(*) from public.workspace_sources where workspace_id = 'integration-himalayas-cap') <> 50
          then raise exception 'Source cap was not preserved'; end if;
          if exists(select 1 from himalayas_connections_before original
              left join public.workspace_sources current on current.workspace_id = original.workspace_id and current.id = original.id
              where original.record is distinct from to_jsonb(current))
          then raise exception 'Existing source choices, labels, keywords, or ownership changed'; end if;
          if exists(select 1 from himalayas_workspaces_before original join public.workspace current using(id)
              where current.payload is distinct from original.payload
                or current.sources_revision <> original.sources_revision + case when original.id = 'integration-himalayas-eligible' then 1 else 0 end)
          then raise exception 'Workspace preferences or source revisions changed unexpectedly'; end if;
        end $$;
        create temp table himalayas_after_first as
          select workspace_id, id, to_jsonb(connection) as record
          from public.workspace_sources connection where workspace_id like 'integration-himalayas-%';
        create temp table himalayas_revisions_after_first as
          select id, sources_revision from public.workspace where id like 'integration-himalayas-%';
        ${migration}
        do $$ begin
          if exists(
            (select * from himalayas_after_first except
              select workspace_id, id, to_jsonb(connection) from public.workspace_sources connection where workspace_id like 'integration-himalayas-%')
            union all
            (select workspace_id, id, to_jsonb(connection) from public.workspace_sources connection where workspace_id like 'integration-himalayas-%'
              except select * from himalayas_after_first)
          ) or exists(select 1 from himalayas_revisions_after_first original join public.workspace current using(id)
              where original.sources_revision <> current.sources_revision)
          then raise exception 'Repeated migration changed source connections or revisions'; end if;
        end $$;
        rollback;
        select 'Himalayas migration assertions passed; test data rolled back.';`,
    });
    expect(output).toContain("Himalayas migration assertions passed; test data rolled back.");
  }, 25000);
});
