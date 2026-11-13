import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("database-enforced workspace isolation", () => {
  it("removes only the former default role pair while retaining custom titles and other preferences", () => {
    const migration = readFileSync(new URL(
      "../supabase/migrations/20261113000100_resume_target_roles.sql", import.meta.url,
    ), "utf8").replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "");
    const output = execFileSync("docker", [
      "exec", "-i", "supabase_db_roleloop-ts", "psql", "-X", "-q",
      "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    ], {
      encoding: "utf8", timeout: 20000,
      input: `begin;
        insert into public.workspace(id, payload) values
          ('integration-roles-default', '{"preferences":{"roles":["Software Engineer","Full Stack Engineer"],"minimumSalary":123456},"sources":[]}'),
          ('integration-roles-custom', '{"preferences":{"roles":["Software Engineer","Designer"],"minimumSalary":123456},"sources":[]}'),
          ('integration-roles-empty', '{"preferences":{"roles":[],"minimumSalary":123456},"sources":[]}');
        ${migration}
        do $$ begin
          if (select payload #> '{preferences}' from public.workspace where id = 'integration-roles-default')
            is distinct from '{"roles":[],"minimumSalary":123456}'::jsonb
          then raise exception 'Default roles were not cleared or other preferences changed'; end if;
          if (select payload #> '{preferences,roles}' from public.workspace where id = 'integration-roles-custom')
            is distinct from '["Software Engineer","Designer"]'::jsonb
          then raise exception 'Custom roles changed'; end if;
          if (select payload #> '{preferences,roles}' from public.workspace where id = 'integration-roles-empty')
            is distinct from '[]'::jsonb
          then raise exception 'Empty roles changed'; end if;
        end $$;
        rollback;
        select 'Role default migration passed';`,
    });
    expect(output).toContain("Role default migration passed");
  }, 25000);

  it("moves legacy working countries to preferences without replacing a saved preference", () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../supabase/migrations/20261105000700_preferences_working_country.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const output = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_roleloop-ts",
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      {
        input: `begin;
          alter table public.workspace disable trigger clean_workspace_profile;
          insert into public.workspace (id, payload) values
            ('integration-country-saved', '{"profile":{"name":"Candidate","country":"Ecuador","location":"Quito"},"preferences":{"country":"Canada","minimumSalary":90000}}'),
            ('integration-country-empty', '{"profile":{"country":"Ecuador","location":"Quito"},"preferences":{"country":""}}'),
            ('integration-country-missing', '{"profile":{"country":"Ecuador"},"preferences":{}}'),
            ('integration-country-blank', '{"profile":{"country":"Ecuador"},"preferences":{"country":"   "}}'),
            ('integration-country-unset', '{"profile":{"country":"","location":""},"preferences":{"country":""}}');
          ${migration}
          do $$ begin
            if exists (
              select 1 from public.workspace
              where id in ('integration-country-saved', 'integration-country-empty', 'integration-country-missing', 'integration-country-blank', 'integration-country-unset')
              and (
                (payload -> 'profile') ?| array['country', 'location']
                or payload #>> '{preferences,country}' is distinct from case
                  when id = 'integration-country-saved' then 'Canada'
                  when id = 'integration-country-unset' then ''
                  else 'Ecuador' end
              )
            ) then raise exception 'Working country migration failed'; end if;
            if (select payload from public.workspace where id = 'integration-country-saved')
              is distinct from '{"profile":{"name":"Candidate"},"preferences":{"country":"Canada","minimumSalary":90000}}'::jsonb
            then raise exception 'Unrelated profile or preference facts changed'; end if;
          end $$;
          rollback;
          select 'Working country migration assertions passed; test data rolled back.';`,
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(output).toContain(
      "Working country migration assertions passed; test data rolled back.",
    );
  }, 25000);

  it("removes editable profile fields and invalid caches without changing application history", () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../supabase/migrations/20261106000100_cv_first_profile.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const output = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_roleloop-ts",
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      {
        input: `begin;
        alter table public.workspace disable trigger clean_workspace_profile;
        insert into public.workspace (id, payload) values ('integration-cv-migration', '{"profile":{"source":{"id":"11111111-1111-4111-8111-111111111111","name":"original.pdf","kind":"pdf","importedAt":"2026-11-05"},"name":"Manual name","portfolio":"Manual link","evidence":[{"text":"Manual fact"}],"headline":"Old","summary":"Old","skills":[],"email":"old@example.test","isDemo":false},"preferences":{"country":"Ecuador"},"sources":[]}');
        alter table public.workspace enable trigger clean_workspace_profile;
        create temp table cv_history_before as
          select 'draft' as kind, id, to_jsonb(drafts) as record from public.drafts
          union all select 'event', id, to_jsonb(events) from public.events
          union all select 'object', id::text, to_jsonb(objects) from storage.objects;
        ${migration}
        do $$ begin
          if (select payload->'profile' from public.workspace where id='integration-cv-migration')
            is distinct from '{"source":{"id":"11111111-1111-4111-8111-111111111111","name":"original.pdf","kind":"pdf","importedAt":"2026-11-05"},"cache":null}'::jsonb
          then raise exception 'Legacy career fields were not removed'; end if;
          if (select payload->'preferences' from public.workspace where id='integration-cv-migration') is distinct from '{"country":"Ecuador"}'::jsonb
          then raise exception 'Preferences changed'; end if;
          if exists (
            (select * from cv_history_before) except (
              select 'draft', id, to_jsonb(drafts) from public.drafts
              union all select 'event', id, to_jsonb(events) from public.events
              union all select 'object', id::text, to_jsonb(objects) from storage.objects
            )
          ) then raise exception 'Historical documents or activity changed'; end if;
        end $$;
        update public.workspace set payload=jsonb_set(payload, '{profile,cache}', '{"sourceId":"22222222-2222-4222-8222-222222222222","extractorVersion":1,"facts":{"name":"Stale"}}') where id='integration-cv-migration';
        do $$ begin
          if (select payload#>'{profile,cache}' from public.workspace where id='integration-cv-migration') is distinct from 'null'::jsonb
          then raise exception 'Mismatched cache survived'; end if;
        end $$;
        rollback;
        select 'CV migration assertions passed; test data rolled back.';`,
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(output).toContain(
      "CV migration assertions passed; test data rolled back.",
    );
  }, 25000);

  it("enforces membership, tenant references, scoped queues, storage and bootstrap permissions", () => {
    const input = readFileSync(
      fileURLToPath(
        new URL("../supabase/tests/workspace_isolation.sql", import.meta.url),
      ),
      "utf8",
    );
    const output = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_roleloop-ts",
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      { input, encoding: "utf8", timeout: 20000 },
    );
    expect(output).toContain(
      "All workspace isolation assertions passed; test data rolled back.",
    );
  }, 25000);
});
