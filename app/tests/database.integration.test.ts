import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("database-enforced workspace isolation", () => {
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
