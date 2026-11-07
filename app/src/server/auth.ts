import { recommendedSources } from "../shared/discovery.js";
import { createHash } from "node:crypto";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { settings } from "./config.js";
import { db, createWorkspaceStore } from "./store.js";
import type {
  AccountContext,
  Workspace,
  WorkspaceAccess,
} from "../shared/types.js";

export interface Identity {
  user: User;
  client: SupabaseClient;
  isAdmin: boolean;
}
export const fail = (message: string, statusCode = 403) =>
  Object.assign(new Error(message), { statusCode });
export const workspaceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/);
export function authClient(token?: string) {
  if (!settings.supabaseAnonKey)
    throw fail(
      "Authentication configuration is missing. Run npm run setup and restart the app.",
      503,
    );
  return createClient(settings.supabaseUrl, settings.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    ...(token
      ? { global: { headers: { Authorization: `Bearer ${token}` } } }
      : {}),
  });
}
export async function authenticate(request: FastifyRequest): Promise<Identity> {
  const authorization = request.headers.authorization;
  const token =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)?.[1]
      : undefined;
  if (!token || token.length > 8192) throw fail("Sign in to continue.", 401);
  const client = authClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user)
    throw fail("Your session expired. Sign in again.", 401);
  const admin = await client
    .from("app_admins")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (admin.error)
    throw fail("Account permissions are unavailable. Retry shortly.", 503);
  return { user: data.user, client, isAdmin: !!admin.data };
}
export function userName(user: User): string {
  return typeof user.user_metadata?.name === "string"
    ? user.user_metadata.name.slice(0, 200)
    : "";
}
export function emptyWorkspace(user: User): Workspace {
  return {
    profile: {
      source: null,
      email: user.email || "",
      cache: null,
    },
    preferences: {
      roles: ["Software Engineer", "Full Stack Engineer"],
      minimumSalary: 90000,
      targetSalary: null,
      salaryPolicy: "overlap",
      salaryFlexibility: false,
      missingSalary: "review",
      lookback: 30,
      lookbackUnit: "days",
      dateMode: "emphasize",
      essentialMatch: 90,
      country: "",
      companyCountry: "United States",
      industries: ["Developer tools", "B2B software"],
      industryPreference: "prefer",
      topIndustries: [],
      scheduleEnabled: false,
      discoverEmployers: true,
      scheduleMinutes: 120,
      dailyLimit: 10,
    },
    sources: recommendedSources.map((s) => ({ ...s })),
  };
}
export async function ensurePersonalWorkspace(
  identity: Identity,
): Promise<void> {
  const { error } = await identity.client.rpc("ensure_workspace", {
    initial_payload: emptyWorkspace(identity.user),
  });
  if (error)
    throw fail("Could not initialize your workspace. Retry shortly.", 503);
}
export async function accountContext(
  identity: Identity,
): Promise<AccountContext> {
  await ensurePersonalWorkspace(identity);
  const result = await identity.client
    .from("workspace")
    .select("id,name,owner_user_id")
    .eq("owner_user_id", identity.user.id)
    .order("name");
  if (result.error) throw fail("Could not load your workspaces.", 503);
  const workspaces: WorkspaceAccess[] = (result.data || []).map((row) => ({
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    role: "owner",
  }));
  return {
    user: {
      id: identity.user.id,
      email: identity.user.email || "",
      name: userName(identity.user),
    },
    isAdmin: identity.isAdmin,
    workspaces,
  };
}
export async function workspaceAccess(
  identity: Identity,
  workspaceId: unknown,
) {
  const id = workspaceIdSchema.safeParse(workspaceId);
  if (!id.success) throw fail("Choose a workspace.", 400);
  const result = await identity.client
    .from("workspace")
    .select("id")
    .eq("id", id.data)
    .eq("owner_user_id", identity.user.id)
    .maybeSingle();
  if (result.error || !result.data)
    throw Object.assign(fail("You do not have access to this workspace."), {
      code: "WORKSPACE_ACCESS_DENIED",
    });
  return {
    store: createWorkspaceStore({
      workspaceId: id.data,
      client: identity.client,
      actorUserId: identity.user.id,
    }),
    role: "owner" as const,
  };
}
export function assertAdmin(identity: Identity) {
  if (!identity.isAdmin)
    throw fail("Only an account administrator can perform this action.");
}
export async function claimOwner(identity: Identity, input: unknown) {
  const { token } = z
    .object({ token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) })
    .parse(input);
  await ensurePersonalWorkspace(identity);
  const digest = createHash("sha256").update(token).digest("hex");
  const { data, error } = await db.rpc("claim_initial_owner", {
    owner_uuid: identity.user.id,
    token_digest: digest,
  });
  if (error || !data?.[0])
    throw fail(
      "The setup key is invalid, expired, or already used. Run npm run account:setup on the host if setup is still available.",
    );
  return { workspaceId: data[0].id };
}
export async function adminUsers(identity: Identity, page: unknown) {
  assertAdmin(identity);
  const selected = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1)
    .parse(page);
  const { data, error } = await db.auth.admin.listUsers({
    page: selected,
    perPage: 100,
  });
  if (error) throw fail("Could not load accounts.", 503);
  return {
    users: data.users.map((user) => ({
      id: user.id,
      email: user.email || "",
      name: userName(user),
      createdAt: user.created_at,
    })),
    nextPage: data.users.length === 100 ? selected + 1 : null,
  };
}
export async function createAccount(identity: Identity, input: unknown) {
  assertAdmin(identity);
  const body = z
    .object({
      email: z.email().max(254),
      password: z.string().min(12).max(128),
      name: z.string().max(200),
    })
    .parse(input);
  const { data, error } = await db.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { name: body.name },
  });
  if (error || !data.user)
    throw fail(
      "Could not create the account. Check the email, password requirements, or whether the account already exists.",
      400,
    );
  return { id: data.user.id, email: data.user.email };
}
