import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settings } from "./config.js";
import { opportunityFingerprint } from "../domain/rules.js";
import {
  ProfileSchema,
  CompanySchema,
  PreferencesSchema,
  SourceSchema,
  OpportunitySchema,
  DraftSchema,
  type Activity,
  type Draft,
  type Opportunity,
  type Profile,
  type Run,
  type Workspace,
} from "../shared/types.js";

if (!settings.supabaseKey)
  throw new Error(
    "Local database configuration is missing. Run npm run setup first.",
  );

// Privileged access is reserved for worker orchestration and account administration.
// Ordinary API requests construct a store with the verified user's Supabase client.
export const db = createClient(settings.supabaseUrl, settings.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
function checked<T>(result: {
  data: T;
  error: { message: string; code?: string } | null;
}): T {
  if (result.error) throw new Error(`Database: ${result.error.message}`);
  return result.data;
}
function missing(): never {
  throw Object.assign(
    new Error("This record was not found in your workspace."),
    { statusCode: 404 },
  );
}
const WorkspaceSchema = z.object({
  profile: ProfileSchema,
  preferences: PreferencesSchema,
  sources: z.array(SourceSchema),
});
type Payloads = {
  opportunities: Opportunity;
  drafts: Draft;
  runs: Run;
  events: Activity;
};
const workspaceWrites = new Map<string, Promise<unknown>>();
// Match the database constraint; colons are safe inside a storage path segment.
const safeId = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
type StoredRow = {
  id: string;
  workspace_id?: string;
  payload: unknown;
  kind?: string;
  source_key?: string;
  company_id?: string | null;
  opportunity_id?: string;
  status?: string;
  requested_by?: string | null;
  created_at?: string;
  updated_at?: string;
};
function columns(table: keyof Payloads) {
  const common = "id,workspace_id,payload";
  if (table === "opportunities")
    return `${common},kind,source_key,company_id,updated_at`;
  if (table === "drafts") return `${common},opportunity_id,updated_at`;
  if (table === "runs")
    return `${common},status,requested_by,created_at,updated_at`;
  return `${common},created_at`;
}

function decode<T extends keyof Payloads>(
  table: T,
  row: StoredRow,
): Payloads[T] {
  const payload = row.payload as Record<string, unknown>;
  if (!payload || typeof payload !== "object")
    throw new Error("Stored record is invalid.");
  if (!safeId.test(row.id))
    throw new Error("Stored record identifier is invalid.");
  if (table === "opportunities")
    return OpportunitySchema.parse({
      ...payload,
      id: row.id,
      kind: row.kind,
      sourceKey: row.source_key,
      companyId: row.company_id ?? undefined,
    }) as Payloads[T];
  if (table === "drafts")
    return DraftSchema.parse({
      ...payload,
      id: row.id,
      opportunityId: row.opportunity_id,
    }) as Payloads[T];
  if (table === "runs")
    return {
      ...payload,
      id: row.id,
      workspaceId: row.workspace_id,
      requestedBy: row.requested_by || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } as Payloads[T];
  return { ...payload, id: row.id, createdAt: row.created_at } as Payloads[T];
}

export function createWorkspaceStore({
  workspaceId,
  client,
  actorUserId,
}: {
  workspaceId: string;
  client: SupabaseClient;
  actorUserId?: string;
}) {
  if (!workspaceId || !safeId.test(workspaceId))
    throw new Error("A workspace context is required.");
  if (!client)
    throw new Error("An authenticated or trusted worker client is required.");

  async function getWorkspace(): Promise<Workspace> {
    const row = checked(
      await client
        .from("workspace")
        .select("payload,owner_user_id")
        .eq("id", workspaceId)
        .maybeSingle(),
    );
    if (!row) return missing();
    const [sourceRows, companyRows] = await Promise.all([
      client
        .from("discovery_sources")
        .select(
          "id,kind,company_id,label,provider,board,enabled,companies(name,country,country_source)",
        )
        .eq("workspace_id", workspaceId)
        .order("position"),
      client
        .from("companies")
        .select("id,name,country,country_source,website")
        .eq("workspace_id", workspaceId)
        .order("name"),
    ]);
    const sources = (checked(sourceRows) ?? []).map((s: any) =>
      SourceSchema.parse({
        id: s.id,
        kind: s.kind,
        companyId: s.company_id ?? undefined,
        companyName: s.companies?.name,
        label: s.label,
        provider: s.provider,
        board: s.board,
        enabled: s.enabled,
        companyCountry: s.companies?.country,
        countrySource: s.companies?.country_source ?? undefined,
      }),
    );
    const workspace = {
      ...WorkspaceSchema.parse({ ...(row.payload as object), sources }),
      companies: (checked(companyRows) ?? []).map((c: any) =>
        CompanySchema.parse({ ...c, countrySource: c.country_source }),
      ),
    };
    // A shared workspace uses its owner's contact, never the manager's login.
    // Email is resolved from Auth rather than duplicated in the profile JSON.
    if (row.owner_user_id) {
      const { data, error } = await db.auth.admin.getUserById(
        row.owner_user_id,
      );
      if (error) throw new Error(`Account contact: ${error.message}`);
      workspace.profile.email = data.user.email || "";
    } else {
      workspace.profile.email = "";
    }
    return workspace;
  }
  async function updateWorkspace(
    patch: Partial<Workspace>,
    expectedProfile?: Profile,
  ): Promise<Workspace> {
    const next = (workspaceWrites.get(workspaceId) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = await getWorkspace();
        const changed = () =>
          Object.assign(
            new Error(
              "The master CV changed during processing. Use the current CV.",
            ),
            { statusCode: 409 },
          );
        const { email: _previousContact, ...previousProfile } = current.profile;
        if (expectedProfile) {
          const { email: _expectedContact, ...expected } = expectedProfile;
          if (JSON.stringify(expected) !== JSON.stringify(previousProfile))
            throw changed();
        }
        const workspace = WorkspaceSchema.parse({
          ...current,
          ...patch,
        });
        workspace.profile.email = current.profile.email;
        const { email: _contact, ...storedProfile } = workspace.profile;
        const workspacePatch = {
          ...(Object.hasOwn(patch, "profile")
            ? { profile: storedProfile }
            : {}),
          ...(Object.hasOwn(patch, "preferences")
            ? { preferences: workspace.preferences }
            : {}),
          ...(Object.hasOwn(patch, "sources")
            ? { sources: workspace.sources }
            : {}),
        };
        // The atomic comparison covers other API processes and late extraction
        // results. RPC parameters travel in the body, avoiding URL-size limits.
        const row = checked(
          await client
            .rpc("update_workspace_profile_if_current", {
              target_workspace: workspaceId,
              expected_profile: expectedProfile ? previousProfile : null,
              workspace_patch: workspacePatch,
            })
            .maybeSingle(),
        );
        if (!row) {
          if (expectedProfile) throw changed();
          return missing();
        }
        return workspace;
      });
    workspaceWrites.set(workspaceId, next);
    try {
      return await next;
    } finally {
      if (workspaceWrites.get(workspaceId) === next)
        workspaceWrites.delete(workspaceId);
    }
  }
  async function list<T extends keyof Payloads>(
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
        await client
          .from(table)
          .select(columns(table))
          .eq("workspace_id", workspaceId)
          .order(column, { ascending: false })
          .order("id")
          .range(offset, Math.min(offset + 499, limit - 1)),
      );
      items.push(
        ...(rows || []).map((row) =>
          decode(table, row as unknown as StoredRow),
        ),
      );
      if (!rows || rows.length < Math.min(500, limit - offset)) break;
    }
    return items;
  }
  async function get<T extends keyof Payloads>(
    table: T,
    id: string,
  ): Promise<Payloads[T]> {
    const row = checked(
      await client
        .from(table)
        .select(columns(table))
        .eq("workspace_id", workspaceId)
        .eq("id", id)
        .maybeSingle(),
    );
    if (!row) return missing();
    return decode(table, row as unknown as StoredRow);
  }
  async function save<T extends keyof Payloads>(
    table: T,
    item: Payloads[T],
  ): Promise<Payloads[T]> {
    if (!safeId.test(item.id)) throw new Error("Record identifier is invalid.");
    const payload = table === "runs" ? { ...item, workspaceId } : item;
    const row: Record<string, unknown> = {
      id: item.id,
      workspace_id: workspaceId,
      payload,
    };
    if (table !== "events") row.updated_at = new Date().toISOString();
    if (table === "opportunities") {
      row.kind = (item as Opportunity).kind;
      row.source_key = (item as Opportunity).sourceKey;
    }
    if (table === "drafts") row.opportunity_id = (item as Draft).opportunityId;
    if (table === "runs") {
      row.status = (item as Run).status;
      row.requested_by = (item as Run).requestedBy || null;
    }
    // A global-ID upsert can overwrite another tenant when used by a worker.
    // Both updates and their retry stay scoped; a foreign workspace's ID fails insertion.
    const updated = checked(
      await client
        .from(table)
        .update(row)
        .eq("workspace_id", workspaceId)
        .eq("id", item.id)
        .select(columns(table))
        .maybeSingle(),
    );
    if (updated) return decode(table, updated as unknown as StoredRow);
    const inserted = await client
      .from(table)
      .insert(row)
      .select(columns(table))
      .single();
    if (inserted.error?.code === "23505") {
      const retried = checked(
        await client
          .from(table)
          .update(row)
          .eq("workspace_id", workspaceId)
          .eq("id", item.id)
          .select(columns(table))
          .maybeSingle(),
      );
      if (retried) return decode(table, retried as unknown as StoredRow);
    }
    const saved = checked(inserted);
    if (!saved) return missing();
    return decode(table, saved as unknown as StoredRow);
  }
  async function runtime<T>(key: string): Promise<T | null> {
    const row = checked(
      await client
        .from("workspace_runtime")
        .select("payload")
        .eq("workspace_id", workspaceId)
        .eq("key", key)
        .maybeSingle(),
    );
    return (row?.payload as T) ?? null;
  }
  async function setRuntime(key: string, payload: unknown) {
    checked(
      await client.from("workspace_runtime").upsert(
        {
          workspace_id: workspaceId,
          key,
          payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,key" },
      ),
    );
  }
  async function importOpportunity(op: Opportunity): Promise<Opportunity> {
    const existing = checked(
      await client
        .from("opportunities")
        .select(columns("opportunities"))
        .eq("workspace_id", workspaceId)
        .eq("source_key", op.sourceKey)
        .maybeSingle(),
    );
    if (!existing) return save("opportunities", op);
    const old = decode("opportunities", existing as unknown as StoredRow);
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
      application: old.application,
      notes: old.notes,
    };
    if (opportunityFingerprint(old) === opportunityFingerprint(refreshed))
      return old;
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
  async function event(
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
  return {
    db: client,
    workspaceId,
    actorUserId,
    getWorkspace,
    updateWorkspace,
    list,
    get,
    save,
    importOpportunity,
    event,
    runtime,
    setRuntime,
  };
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export async function getGlobalRuntime<T>(key: string): Promise<T | null> {
  const row = checked(
    await db.from("runtime").select("payload").eq("key", key).maybeSingle(),
  );
  return (row?.payload as T) ?? null;
}
export async function setGlobalRuntime(key: string, payload: unknown) {
  checked(
    await db
      .from("runtime")
      .upsert({ key, payload, updated_at: new Date().toISOString() }),
  );
}
export async function listOwnedWorkspaces(): Promise<
  { id: string; owner_user_id: string }[]
> {
  const result: { id: string; owner_user_id: string }[] = [];
  for (let offset = 0; ; offset += 500) {
    const rows = checked(
      await db
        .from("workspace")
        .select("id,owner_user_id")
        .not("owner_user_id", "is", null)
        .order("id")
        .range(offset, offset + 499),
    );
    result.push(...(rows || []));
    if (!rows || rows.length < 500) break;
  }
  return result;
}
export async function isOwnedWorkspace(workspaceId: string): Promise<boolean> {
  const row = checked(
    await db
      .from("workspace")
      .select("id")
      .eq("id", workspaceId)
      .not("owner_user_id", "is", null)
      .maybeSingle(),
  );
  return !!row;
}
export async function claimRun(): Promise<
  (Run & { workspaceId: string }) | null
> {
  const rows = checked(await db.rpc("claim_run"));
  const row = rows?.[0];
  if (!row) return null;
  if (!row.workspace_id)
    throw new Error("Claimed task has no workspace context.");
  return {
    ...row.payload,
    id: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.requested_by || undefined,
  };
}
