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
      scheduleMinutes: 120,
      dailyLimit: 10,
    },
    sources: [
      {
        id: "hn-startups",
        provider: "hackernews",
        label: "Show HN · startup leads",
        board: "",
        enabled: true,
      },
    ],
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
  const memberships = await identity.client
    .from("workspace_members")
    .select("workspace_id,role")
    .eq("user_id", identity.user.id);
  if (memberships.error)
    throw fail("Could not read workspace permissions.", 503);
  const ids = (memberships.data || []).map((row) => row.workspace_id);
  let workspaces: WorkspaceAccess[] = [];
  if (ids.length) {
    const result = await identity.client
      .from("workspace")
      .select("id,name,owner_user_id")
      .in("id", ids)
      .order("name");
    if (result.error) throw fail("Could not load your workspaces.", 503);
    workspaces = (result.data || []).map((row) => ({
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      role: memberships.data!.find((m) => m.workspace_id === row.id)!
        .role as WorkspaceAccess["role"],
    }));
  }
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
  ownerOnly = false,
) {
  const id = workspaceIdSchema.safeParse(workspaceId);
  if (!id.success) throw fail("Choose a workspace.", 400);
  const result = await identity.client
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", id.data)
    .eq("user_id", identity.user.id)
    .maybeSingle();
  if (result.error || !result.data)
    throw Object.assign(fail("You do not have access to this workspace."), {
      code: "WORKSPACE_ACCESS_DENIED",
    });
  if (ownerOnly && result.data.role !== "owner")
    throw fail("Only the workspace owner can manage access.");
  return {
    store: createWorkspaceStore({
      workspaceId: id.data,
      client: identity.client,
      actorUserId: identity.user.id,
    }),
    role: result.data.role as WorkspaceAccess["role"],
  };
}
export function assertAdmin(identity: Identity) {
  if (!identity.isAdmin)
    throw fail("Only an account administrator can perform this action.");
}
export async function setupAvailable() {
  const { count, error } = await db
    .from("app_admins")
    .select("user_id", { count: "exact", head: true });
  if (error)
    throw fail(
      "Account setup is unavailable. Apply database migrations first.",
      503,
    );
  return count === 0;
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
export async function workspaceMembers(identity: Identity, id: string) {
  await workspaceAccess(identity, id);
  const result = await identity.client
    .from("workspace_members")
    .select("user_id,role")
    .eq("workspace_id", id);
  if (result.error) throw fail("Could not load workspace members.", 503);
  const members = await Promise.all(
    (result.data || []).map(async (member) => {
      const user = await db.auth.admin.getUserById(member.user_id);
      return {
        userId: member.user_id,
        role: member.role,
        email: user.data.user?.email || "",
        name: user.data.user ? userName(user.data.user) : "",
      };
    }),
  );
  return { members };
}
async function accountByEmail(email: string): Promise<User | null> {
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw fail("Account directory is unavailable.", 503);
    const user = data.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (user) return user;
    if (data.users.length < 100) return null;
  }
  throw fail("Account lookup limit reached.", 503);
}
export async function grantManager(
  identity: Identity,
  id: string,
  input: unknown,
) {
  await workspaceAccess(identity, id, true);
  const { email } = z.object({ email: z.email().max(254) }).parse(input);
  const user = await accountByEmail(email);
  if (!user)
    throw fail(
      "No account has that email. Ask the manager to create an account first.",
      404,
    );
  const { error } = await identity.client.rpc("manage_workspace_member", {
    target_workspace: id,
    member_user_id: user.id,
    operation: "grant",
  });
  if (error)
    throw fail(
      "Could not grant manager access. Workspace owners cannot be changed here.",
    );
  return workspaceMembers(identity, id);
}
export async function revokeManager(
  identity: Identity,
  id: string,
  userId: string,
) {
  await workspaceAccess(identity, id, true);
  z.uuid().parse(userId);
  const { error } = await identity.client.rpc("manage_workspace_member", {
    target_workspace: id,
    member_user_id: userId,
    operation: "revoke",
  });
  if (error)
    throw fail(
      "Could not remove this member. The workspace owner cannot be removed.",
    );
  return workspaceMembers(identity, id);
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
