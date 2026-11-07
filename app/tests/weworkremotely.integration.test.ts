import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("We Work Remotely source migration", () => {
  it("adds one feed to eligible workspaces while preserving paused choices and source limits", () => {
    // Keep the entire migration, including its DDL and append, inside this
    // test's rollback. Its production transaction boundaries must be removed.
    const migration = readFileSync(
      fileURLToPath(new URL(
        "../supabase/migrations/20261107000300_weworkremotely_feed.sql",
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
        -- Replay an older provider constraint at its historical schema boundary.
        -- These temporary removals and the migration itself are rolled back.
        delete from public.workspace_sources where source_id in (
          select id from public.discovery_sources where provider = 'seedcamp'
        );
        delete from public.discovery_sources where provider = 'seedcamp';
        insert into public.workspace(id, payload) values
          ('integration-wwr-eligible', '{"preferences":{"discoverEmployers":true,"country":"Ecuador","minimumSalary":123456},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My feed","board":"typescript","enabled":true}]}'),
          ('integration-wwr-paused-discovery', '{"preferences":{"discoverEmployers":false},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My feed","board":"","enabled":true}]}'),
          ('integration-wwr-paused-sources', '{"preferences":{"discoverEmployers":true},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My paused feed","board":"","enabled":false}]}'),
          ('integration-wwr-disabled', '{"preferences":{"discoverEmployers":true},"sources":[{"id":"existing-feed","provider":"jobicy","label":"My feed","board":"","enabled":true},{"id":"paused-wwr","provider":"weworkremotely","label":"My paused WWR","board":"design","enabled":false}]}'),
          ('integration-wwr-empty', '{"preferences":{"discoverEmployers":true},"sources":[]}');
        insert into public.workspace(id, payload)
          select 'integration-wwr-cap', jsonb_build_object(
            'preferences', jsonb_build_object('discoverEmployers', true),
            'sources', jsonb_agg(jsonb_build_object(
              'id', 'capped-' || number, 'provider', 'ashby',
              'board', 'integration-wwr-cap-' || number,
              'label', 'Capped employer ' || number, 'enabled', true
            ))) from generate_series(1, 50) as number;
        create temp table wwr_workspaces_before as
          select id, payload, sources_revision from public.workspace where id like 'integration-wwr-%';
        create temp table wwr_connections_before as
          select workspace_id, id, to_jsonb(connection) as record
          from public.workspace_sources connection where workspace_id like 'integration-wwr-%';
        ${migration}
        do $$ begin
          if (select count(*) from public.workspace_sources connection
              join public.discovery_sources catalog on catalog.id = connection.source_id
              where connection.workspace_id = 'integration-wwr-eligible' and catalog.provider = 'weworkremotely'
                and connection.enabled and connection.company_id is null and connection.keyword = '') <> 1
          then raise exception 'Eligible workspace did not receive exactly one enabled independent feed'; end if;
          if exists(select 1 from public.workspace_sources connection
              join public.discovery_sources catalog on catalog.id = connection.source_id
              where connection.workspace_id in ('integration-wwr-paused-discovery', 'integration-wwr-paused-sources', 'integration-wwr-empty', 'integration-wwr-cap')
                and catalog.provider = 'weworkremotely')
          then raise exception 'Paused, empty, or capped workspace was expanded'; end if;
          if (select count(*) from public.workspace_sources where workspace_id = 'integration-wwr-cap') <> 50
          then raise exception 'Source cap was not preserved'; end if;
          if exists(select 1 from wwr_connections_before original
              left join public.workspace_sources current on current.workspace_id = original.workspace_id and current.id = original.id
              where original.record is distinct from to_jsonb(current))
          then raise exception 'Existing source choices, labels, keywords, or ownership changed'; end if;
          if exists(select 1 from wwr_workspaces_before original join public.workspace current using(id)
              where current.payload is distinct from original.payload
                or current.sources_revision <> original.sources_revision + case when original.id = 'integration-wwr-eligible' then 1 else 0 end)
          then raise exception 'Workspace preferences or source revisions changed unexpectedly'; end if;
        end $$;
        create temp table wwr_after_first as
          select workspace_id, id, to_jsonb(connection) as record
          from public.workspace_sources connection where workspace_id like 'integration-wwr-%';
        create temp table wwr_revisions_after_first as
          select id, sources_revision from public.workspace where id like 'integration-wwr-%';
        ${migration}
        do $$ begin
          if exists(
            (select * from wwr_after_first except
              select workspace_id, id, to_jsonb(connection) from public.workspace_sources connection where workspace_id like 'integration-wwr-%')
            union all
            (select workspace_id, id, to_jsonb(connection) from public.workspace_sources connection where workspace_id like 'integration-wwr-%'
              except select * from wwr_after_first)
          ) or exists(select 1 from wwr_revisions_after_first original join public.workspace current using(id)
              where original.sources_revision <> current.sources_revision)
          then raise exception 'Repeated migration changed source connections or revisions'; end if;
        end $$;
        rollback;
        select 'WWR migration assertions passed; test data rolled back.';`,
    });
    expect(output).toContain("WWR migration assertions passed; test data rolled back.");
  }, 25000);
});
