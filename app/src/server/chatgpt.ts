import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { appDir, settings } from "./config.js";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const permission = "chatgpt.tokens.use.direct";
const scopes = `openid profile email offline_access resource.invoke ${permission}`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
type Tokens = {
  access: string;
  refresh?: string;
  idToken?: string;
  expiresAt: number;
  scopes: string[];
};
type Profile = {
  suspended?: { message: string; code: string };
  id: string;
  clientId: string;
  subject?: string;
  email?: string;
  label: string;
  model?: string;
  tokens?: Tokens;
  models?: { slug: string; displayName: string }[];
};
type Connections = {
  mode: "api" | "chatgpt";
  activeId?: string;
  profiles: Profile[];
};
type Pending = {
  userId: string;
  profileId: string;
  state: string;
  nonce: string;
  verifier: string;
  clientId: string;
  isNew: boolean;
  subject?: string;
  manual: boolean;
  launch: string;
  authUrl: string;
  redirectUri: string;
  server: Server;
  consumed: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Pending>();
const errors = new Map<string, string>();
const modelLoads = new Map<string, Promise<unknown>>();
const root = () => resolve(appDir, ".local/chatgpt");
const random = () => randomBytes(32).toString("base64url");
function userFile(userId: string) {
  return resolve(root(), `${z.string().uuid().parse(userId)}.json`);
}
export function chatgptError(
  message: string,
  code = "chatgpt_unavailable",
  statusCode = 503,
) {
  return Object.assign(new Error(message), { code, statusCode });
}
async function atomic(path: string, value: unknown) {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}
async function read(userId: string): Promise<Connections> {
  try {
    return JSON.parse(await readFile(userFile(userId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { mode: "api", profiles: [] };
  }
}
async function locked<T>(
  userId: string,
  action: (state: Connections) => Promise<T>,
): Promise<T> {
  const path = userFile(userId);
  await mkdir(root(), { recursive: true, mode: 0o700 });
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      lock = await open(`${path}.lock`, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(`${path}.lock`).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 120000)
        await unlink(`${path}.lock`).catch(() => {});
      await delay(100);
    }
  }
  if (!lock) throw chatgptError("ChatGPT connection is busy. Please retry.");
  try {
    const state = await read(userId);
    const result = await action(state);
    await atomic(path, state);
    return result;
  } finally {
    await lock.close();
    await unlink(`${path}.lock`).catch(() => {});
  }
}
async function hostId() {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const path = resolve(root(), "host-id");
  try {
    await writeFile(path, `urn:uuid:${randomUUID()}`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return (await readFile(path, "utf8")).trim();
}
export async function openaiFailure(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string | { code?: string; message?: string };
    detail?: string;
  };
  const details = typeof body.error === "object" ? body.error : undefined;
  const code =
    (typeof body.error === "string" ? body.error : details?.code) ||
    "chatgpt_request_failed";
  const messages: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded:
      "Your ChatGPT usage limit was reached. Open Manage usage to review your allowance.",
    subscription_sharing_usage_unavailable:
      "ChatGPT usage is temporarily unavailable. Try again later.",
    subscription_sharing_user_not_eligible:
      "This ChatGPT account or workspace is not eligible to share its plan.",
    subscription_sharing_unsupported_capability:
      "This request is not supported by ChatGPT plan usage. Try a different available model.",
  };
  return Object.assign(
    chatgptError(
      messages[code] ||
        `ChatGPT could not complete the request (${response.status}). ${details?.message || body.detail || "Reconnect or retry later."}`.slice(
          0,
          600,
        ),
      code,
      response.status === 429 ? 429 : 502,
    ),
    {
      providerStatus: response.status,
      requestId: response.headers.get("x-request-id"),
    },
  );
}
async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw await openaiFailure(response);
  return TokenSchema.parse(await response.json());
}
export async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce?: string,
  subject?: string,
) {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "sub"],
  });
  if (
    (nonce && payload.nonce !== nonce) ||
    (subject && payload.sub !== subject)
  )
    throw chatgptError(
      "ChatGPT identity did not match this sign-in attempt.",
      "chatgpt_identity_mismatch",
      400,
    );
  return {
    subject: payload.sub!,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}
function tokens(
  result: z.infer<typeof TokenSchema>,
  previous?: Tokens,
): Tokens {
  return {
    access: result.access_token,
    refresh: result.refresh_token || previous?.refresh,
    idToken: result.id_token || previous?.idToken,
    expiresAt: Date.now() + result.expires_in * 1000,
    scopes:
      result.scope === undefined
        ? previous?.scopes || []
        : result.scope.split(/\s+/),
  };
}
export async function chatgptStatus(userId: string) {
  let state = await read(userId);
  const active = state.profiles.find((p) => p.id === state.activeId);
  let modelsError: string | undefined;
  if (
    state.mode === "chatgpt" &&
    active?.tokens?.scopes.includes(permission) &&
    !active.models?.length
  ) {
    try {
      let request = modelLoads.get(userId);
      if (!request) {
        request = listChatGPTModels(userId).finally(() =>
          modelLoads.delete(userId),
        );
        modelLoads.set(userId, request);
      }
      await request;
    } catch (error) {
      modelsError =
        error instanceof Error
          ? error.message
          : "Could not load models. Try again.";
    }
    // Discovery may refresh or revoke credentials, or another request may switch accounts.
    state = await read(userId);
  }
  return {
    mode: state.mode,
    activeId: state.activeId,
    apiConfigured: !!settings.openaiKey,
    pending: pending.has(userId),
    error: errors.get(userId),
    modelsError,
    profiles: state.profiles.map((p) => ({
      id: p.id,
      label: p.label,
      email: p.email,
      model: p.model,
      connected: !!p.tokens,
      planEnabled: !!p.tokens?.scopes.includes(permission),
      models: p.models || [],
      error: p.suspended?.message,
    })),
  };
}
function cancel(userId: string) {
  const attempt = pending.get(userId);
  if (attempt) {
    attempt.cancelled = true;
    clearTimeout(attempt.timer);
    attempt.server.close();
    pending.delete(userId);
  }
}
function validCallback(attempt: Pending, url: URL) {
  const redirect = new URL(attempt.redirectUri);
  return (
    url.origin === redirect.origin &&
    url.pathname === redirect.pathname &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.searchParams.getAll("state").length === 1 &&
    url.searchParams.get("state") === attempt.state &&
    ["code", "client_id", "error"].every(
      (key) => url.searchParams.getAll(key).length <= 1,
    ) &&
    !(url.searchParams.has("code") && url.searchParams.has("error")) &&
    !attempt.consumed &&
    !attempt.cancelled
  );
}
async function finishChatGPTLogin(attempt: Pending, url: URL) {
  if (!validCallback(attempt, url))
    throw chatgptError(
      "This sign-in attempt is invalid or expired. Start sign-in again.",
      "chatgpt_invalid_callback",
      400,
    );
  // Both callback routes share this one-time claim before any asynchronous work.
  attempt.consumed = true;
  const { userId } = attempt;
  try {
    if (url.searchParams.has("error"))
      throw chatgptError("ChatGPT sign-in was cancelled. You can try again.");
    const clientId = url.searchParams.has("client_id")
      ? url.searchParams.get("client_id")!
      : !attempt.isNew
        ? attempt.clientId
        : "";
    if (
      !clientId ||
      clientId === "dynamic_agent_client" ||
      (!attempt.isNew && clientId !== attempt.clientId)
    )
      throw chatgptError(
        "ChatGPT registration could not be verified. Start sign-in again.",
      );
    const code = url.searchParams.get("code");
    if (!code) throw chatgptError("ChatGPT did not return a sign-in code.");
    // Retain an issued registration even if its short-lived code expires.
    await locked(userId, async (state) => {
      if (!state.profiles.some((p) => p.id === attempt.profileId))
        state.profiles.push({
          id: attempt.profileId,
          clientId,
          label: `ChatGPT account ${state.profiles.length + 1}`,
        });
    });
    const result = await tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource,
      }),
    );
    if (!result.id_token)
      throw chatgptError("ChatGPT did not return a verifiable identity.");
    const identity = await verifyIdentity(
      result.id_token,
      clientId,
      attempt.nonce,
      attempt.subject,
    );
    if (attempt.cancelled) throw chatgptError("Sign-in was cancelled.");
    await locked(userId, async (state) => {
      if (attempt.cancelled) throw chatgptError("Sign-in was cancelled.");
      const profile = state.profiles.find((p) => p.id === attempt.profileId)!;
      delete profile.suspended;
      delete profile.models;
      Object.assign(profile, identity, {
        tokens: tokens(result),
        label: `${identity.email || "ChatGPT account"} · ${profile.id.slice(0, 6)}`,
      });
      state.activeId = profile.id;
      state.mode = "chatgpt";
    });
    return {
      message: result.scope?.split(/\s+/).includes(permission)
        ? "ChatGPT connected. Return to RoleLoop to select your model."
        : "Signed in. Return to RoleLoop and enable ChatGPT plan usage to run AI requests.",
    };
  } catch (error) {
    if (!attempt.cancelled)
      errors.set(
        userId,
        error instanceof Error
          ? error.message
          : "ChatGPT sign-in failed. Try again.",
      );
    throw error;
  } finally {
    clearTimeout(attempt.timer);
    if (pending.get(userId) === attempt) pending.delete(userId);
    attempt.server.close();
  }
}
export async function completeChatGPTLogin(userId: string, callbackUrl: string) {
  const attempt = pending.get(userId);
  if (!attempt?.manual)
    throw chatgptError(
      "Start a new ChatGPT sign-in from this browser before completing it.",
      "chatgpt_no_pending_login",
      400,
    );
  let url: URL;
  try {
    if (callbackUrl.length > 8192) throw new Error();
    url = new URL(callbackUrl);
  } catch {
    throw chatgptError(
      "Paste the complete callback URL from the sign-in window's address bar.",
      "chatgpt_invalid_callback",
      400,
    );
  }
  return finishChatGPTLogin(attempt, url);
}
export async function startChatGPTLogin(
  userId: string,
  profileId?: string,
  manual = false,
) {
  const state = await read(userId);
  const existing = profileId
    ? state.profiles.find((p) => p.id === profileId)
    : undefined;
  if (profileId && !existing)
    throw chatgptError("This ChatGPT account was not found.", "not_found", 404);
  cancel(userId);
  errors.delete(userId);
  const attempt = {
    userId,
    profileId: existing?.id || randomUUID(),
    state: random(),
    nonce: random(),
    verifier: random(),
    clientId: existing?.clientId || "dynamic_agent_client",
    isNew: !existing?.clientId,
    subject: existing?.subject,
    manual,
    launch: random(),
    consumed: false,
    cancelled: false,
  } as Pending;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    const url = new URL(req.url || "/", attempt.redirectUri);
    if (
      req.method === "GET" &&
      url.pathname === "/auth/start" &&
      url.searchParams.get("launch") === attempt.launch &&
      !attempt.consumed
    ) {
      attempt.launch = random();
      res.writeHead(302, { Location: attempt.authUrl });
      res.end();
      return;
    }
    if (req.method !== "GET" || !validCallback(attempt, url)) {
      res.writeHead(400);
      res.end("This sign-in attempt is invalid or expired.");
      return;
    }
    let message: string;
    try {
      ({ message } = await finishChatGPTLogin(attempt, url));
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "ChatGPT sign-in failed. Try again.";
      res.statusCode = 400;
    }
    const escaped = message.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><title>RoleLoop · ChatGPT</title><meta name="viewport" content="width=device-width"><style>body{font:17px system-ui;max-width:540px;margin:12vh auto;padding:24px;line-height:1.6;color:#18293b}a{color:#087f8c}</style><h1>RoleLoop</h1><p>${escaped}</p><a href="${settings.appUrl}/#account">Return to RoleLoop</a>`,
    );
  });
  attempt.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  attempt.redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const query = new URLSearchParams({
    client_id: attempt.clientId,
    ext_agent_host_id: await hostId(),
    response_type: "code",
    redirect_uri: attempt.redirectUri,
    scope: scopes,
    resource,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(attempt.verifier)
      .digest("base64url"),
  });
  if (attempt.isNew) query.set("agent_name_hint", "RoleLoop");
  // Reconnect is an explicit user action that may need previously declined permission.
  if (existing && !existing.tokens?.scopes.includes(permission))
    query.set("prompt", "consent");
  attempt.authUrl = `${issuer}/api/accounts/authorize?${query}`;
  attempt.timer = setTimeout(
    () => {
      errors.set(userId, "ChatGPT sign-in expired. Please try again.");
      cancel(userId);
    },
    10 * 60 * 1000,
  );
  attempt.timer.unref();
  pending.set(userId, attempt);
  return {
    url: manual
      ? attempt.authUrl
      : `http://127.0.0.1:${port}/auth/start?launch=${attempt.launch}`,
    ...(manual ? { manual: true } : {}),
  };
}
export async function selectChatGPT(
  userId: string,
  profileId: string,
  model?: string,
) {
  return locked(userId, async (state) => {
    const profile = state.profiles.find((p) => p.id === profileId);
    if (!profile)
      throw chatgptError("ChatGPT account not found.", "not_found", 404);
    if (model && !profile.models?.some((m) => m.slug === model))
      throw chatgptError(
        "Choose a model available to this account.",
        "invalid_model",
        400,
      );
    if (model) profile.model = model;
    if (state.activeId !== profile.id || state.mode !== "chatgpt")
      delete profile.models;
    state.activeId = profile.id;
    state.mode = "chatgpt";
  });
}
export async function useAPIKey(userId: string) {
  if (!settings.openaiKey)
    throw chatgptError(
      "An OpenAI API key has not been configured on this server.",
    );
  await locked(userId, async (state) => {
    state.mode = "api";
  });
}
export async function chatgptCredential(userId: string) {
  return locked(userId, async (state) => {
    if (state.mode !== "chatgpt") return null;
    const profile = state.profiles.find((p) => p.id === state.activeId);
    if (!profile?.tokens)
      throw chatgptError(
        "Connect your ChatGPT account under Account.",
        "chatgpt_reconnect",
      );
    if (profile.suspended)
      throw chatgptError(
        profile.suspended.message,
        profile.suspended.code,
        429,
      );
    if (!profile.tokens.scopes.includes(permission))
      throw chatgptError(
        "Enable ChatGPT plan usage under Account.",
        "chatgpt_permission_required",
      );
    if (profile.tokens.expiresAt < Date.now() + 60000) {
      if (!profile.tokens.refresh)
        throw chatgptError(
          "Reconnect ChatGPT to renew this connection.",
          "chatgpt_reconnect",
        );
      try {
        const result = await tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: profile.clientId,
            refresh_token: profile.tokens.refresh,
            resource,
          }),
        );
        if (result.id_token)
          await verifyIdentity(
            result.id_token,
            profile.clientId,
            undefined,
            profile.subject,
          );
        profile.tokens = tokens(result, profile.tokens);
        await atomic(userFile(userId), state);
      } catch (error) {
        if (
          [
            "invalid_grant",
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
          ].includes((error as { code?: string }).code || "")
        ) {
          delete profile.tokens;
          await atomic(userFile(userId), state);
          throw chatgptError(
            "Your ChatGPT connection expired. Reconnect under Account.",
            "chatgpt_reconnect",
          );
        }
        throw error;
      }
    }
    if (!profile.tokens.scopes.includes(permission))
      throw chatgptError(
        "ChatGPT plan usage permission is no longer enabled.",
        "chatgpt_permission_required",
      );
    return {
      token: profile.tokens.access,
      model: profile.model,
    };
  });
}
export async function listChatGPTModels(userId: string) {
  const profileId = (await read(userId)).activeId;
  const credential = await chatgptCredential(userId);
  if (!credential) throw chatgptError("Select a ChatGPT connection first.");
  const response = await fetch(`${resource}/models`, {
    headers: { Authorization: `Bearer ${credential.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw await openaiFailure(response);
  const data = z
    .object({
      models: z.array(
        z.object({
          slug: z.string(),
          display_name: z.string(),
          visibility: z.string(),
        }),
      ),
    })
    .parse(await response.json());
  const models = data.models
    .filter((m) => m.visibility === "list")
    .map((m) => ({ slug: m.slug, displayName: m.display_name }));
  if (!models.length)
    throw chatgptError(
      "No models are available for this ChatGPT account. Try again later.",
    );
  await locked(userId, async (state) => {
    const profile = state.profiles.find((p) => p.id === state.activeId);
    // Never associate a catalog with another account after a concurrent switch.
    if (
      state.activeId !== profileId ||
      profile?.tokens?.access !== credential.token
    )
      throw chatgptError("The ChatGPT account changed. Try again.");
    profile.models = models;
    if (!models.some((m) => m.slug === profile.model))
      profile.model = models[0]?.slug;
  });
  return models;
}
export async function disconnectChatGPT(userId: string, profileId: string) {
  cancel(userId);
  errors.delete(userId);
  let revoked = true;
  await locked(userId, async (state) => {
    const profile = state.profiles.find((p) => p.id === profileId);
    if (!profile)
      throw chatgptError("ChatGPT account not found.", "not_found", 404);
    if (profile.tokens?.refresh) {
      try {
        const discovery = (await fetch(
          `${issuer}/.well-known/openid-configuration`,
          { redirect: "error", signal: AbortSignal.timeout(10000) },
        ).then((r) => r.json())) as {
          issuer: string;
          revocation_endpoint: string;
        };
        const endpoint = new URL(discovery.revocation_endpoint);
        if (discovery.issuer !== issuer || endpoint.origin !== issuer)
          throw new Error("Invalid revocation endpoint");
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: profile.tokens.refresh,
                token_type_hint: "refresh_token",
                client_id: profile.clientId,
              }),
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            });
            if (response.status < 500) break;
          } catch (error) {
            if (attempt === 1) throw error;
          }
          if (attempt === 0) await delay(200);
        }
        revoked = response?.status === 200;
      } catch {
        revoked = false;
      }
    }
    delete profile.tokens;
    delete profile.suspended;
    delete profile.models;
    delete profile.model;
  });
  return {
    message: revoked
      ? "ChatGPT disconnected."
      : "Disconnected locally. Remote revocation could not be confirmed; remove RoleLoop access in ChatGPT settings.",
  };
}
export function stopChatGPTLogins() {
  for (const id of pending.keys()) cancel(id);
}

export async function suspendChatGPT(
  userId: string,
  token: string,
  error: unknown,
) {
  const failure = error as { code?: string; message?: string };
  if (failure.code !== "subscription_sharing_usage_limit_exceeded") return;
  await locked(userId, async (state) => {
    const profile = state.profiles.find((p) => p.id === state.activeId);
    if (profile?.tokens?.access === token)
      profile.suspended = {
        code: failure.code!,
        message:
          failure.message || "ChatGPT usage limit reached. Open Manage usage.",
      };
  });
}
export async function retryChatGPT(userId: string) {
  await locked(userId, async (state) => {
    const profile = state.profiles.find((p) => p.id === state.activeId);
    if (profile) delete profile.suspended;
  });
}
