import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("database-enforced workspace isolation", () => {
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
