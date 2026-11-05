import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { settings } from "./config.js";
import { demoWorkspace } from "../domain/fixtures.js";
import { opportunityFingerprint } from "../domain/rules.js";
import type {
  Activity,
  Draft,
  Opportunity,
  Run,
  Workspace,
} from "../shared/types.js";

if (!settings.supabaseKey)
  throw new Error(
    "Local database configuration is missing. Run npm run setup first.",
  );
export const db = createClient(settings.supabaseUrl, settings.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
function checked<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Database: ${result.error.message}`);
  return result.data;
}
export async function getWorkspace(): Promise<Workspace> {
  let row = checked(
    await db
      .from("workspace")
      .select("payload")
      .eq("id", "default")
      .maybeSingle(),
  );
  if (!row) {
    checked(
      await db
        .from("workspace")
        .upsert(
          { id: "default", payload: demoWorkspace() },
          { onConflict: "id", ignoreDuplicates: true },
        ),
    );
    row = checked(
      await db.from("workspace").select("payload").eq("id", "default").single(),
    );
  }
  return row!.payload as Workspace;
}
let writes: Promise<unknown> = Promise.resolve();
export async function updateWorkspace(
  patch: Partial<Workspace>,
): Promise<Workspace> {
  const next = writes
    .catch(() => {})
    .then(async () => {
      const workspace = { ...(await getWorkspace()), ...patch };
      checked(
        await db
          .from("workspace")
          .update({ payload: workspace, updated_at: new Date().toISOString() })
          .eq("id", "default"),
      );
      return workspace;
    });
  writes = next;
  return next;
}
type Payloads = {
  opportunities: Opportunity;
  drafts: Draft;
  runs: Run;
  events: Activity;
};
export async function list<T extends keyof Payloads>(
  table: T,
  limit = 300,
): Promise<Payloads[T][]> {
  const column =
    table === "opportunities" || table === "drafts"
      ? "updated_at"
      : "created_at";
  const items: Payloads[T][] = [];
  for (let offset = 0; offset < limit; offset += 500) {
    const rows = checked(
      await db
        .from(table)
        .select("payload")
        .order(column, { ascending: false })
        .order("id")
        .range(offset, Math.min(offset + 499, limit - 1)),
    );
    items.push(...(rows || []).map((row) => row.payload as Payloads[T]));
    if (!rows || rows.length < Math.min(500, limit - offset)) break;
  }
  return items;
}
export async function get<T extends keyof Payloads>(
  table: T,
  id: string,
): Promise<Payloads[T]> {
  const row = checked(
    await db.from(table).select("payload").eq("id", id).maybeSingle(),
  );
  if (!row)
    throw Object.assign(new Error("This record was not found."), {
      statusCode: 404,
    });
  return row.payload as Payloads[T];
}
export async function save<T extends keyof Payloads>(
  table: T,
  item: Payloads[T],
): Promise<Payloads[T]> {
  const row: Record<string, unknown> = { id: item.id, payload: item };
  if (table !== "events") row.updated_at = new Date().toISOString();
  if (table === "opportunities") {
    row.kind = (item as Opportunity).kind;
    row.source_key = (item as Opportunity).sourceKey;
  }
  if (table === "drafts") row.opportunity_id = (item as Draft).opportunityId;
  if (table === "runs") row.status = (item as Run).status;
  checked(await db.from(table).upsert(row, { onConflict: "id" }));
  return item;
}
export async function importOpportunity(op: Opportunity): Promise<Opportunity> {
  const existing = checked(
    await db
      .from("opportunities")
      .select("payload")
      .eq("source_key", op.sourceKey)
      .maybeSingle(),
  );
  if (!existing) return save("opportunities", op);
  const old = existing.payload as Opportunity;
  const corrections =
    (await runtime<Partial<Opportunity>>(`corrections:${old.id}`)) || {};
  const refreshed = {
    ...op,
    ...corrections,
    id: old.id,
    sourceKey: old.sourceKey,
    firstSeenAt: old.firstSeenAt,
    stage: old.stage,
    assessment: old.assessment,
    notes: old.notes,
  };
  if (opportunityFingerprint(old) === opportunityFingerprint(refreshed))
    return old;
  // Fresh source facts invalidate old approvals; explicit user corrections remain authoritative.
  for (const draft of await list("drafts", 10000))
    if (draft.opportunityId === old.id)
      await save("drafts", {
        ...draft,
        status: "draft",
        testReceipt: null,
        updatedAt: new Date().toISOString(),
      });
  return save("opportunities", {
    ...refreshed,
    stage: old.stage === "archived" ? "archived" : "new",
    assessment: null,
    updatedAt: new Date().toISOString(),
  });
}
export async function event(
  message: string,
  kind: Activity["kind"] = "info",
  opportunityId?: string,
) {
  return save("events", {
    id: randomUUID(),
    message,
    kind,
    opportunityId,
    createdAt: new Date().toISOString(),
  });
}
export async function runtime<T>(key: string): Promise<T | null> {
  const row = checked(
    await db.from("runtime").select("payload").eq("key", key).maybeSingle(),
  );
  return (row?.payload as T) ?? null;
}
export async function setRuntime(key: string, payload: unknown) {
  checked(
    await db
      .from("runtime")
      .upsert({ key, payload, updated_at: new Date().toISOString() }),
  );
}
export async function claimRun(): Promise<Run | null> {
  const rows = checked(await db.rpc("claim_run"));
  return (rows?.[0]?.payload as Run) ?? null;
}
