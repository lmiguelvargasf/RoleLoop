import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { appDir, settings } from "../src/server/config.js";
let key: Awaited<ReturnType<typeof generateKeyPair>>;
vi.mock("jose", async (original) => ({
  ...(await original<typeof import("jose")>()),
  createRemoteJWKSet: () => async () => key.publicKey,
}));
import {
  chatgptStatus,
  startChatGPTLogin,
  stopChatGPTLogins,
  verifyIdentity,
  listChatGPTModels,
  selectChatGPT,
  disconnectChatGPT,
  chatgptCredential,
} from "../src/server/chatgpt.js";
import { structuredAI } from "../src/server/ai.js";
import { completedResponse } from "../src/server/openai-stream.js";
const originalFetch = globalThis.fetch;
const ids: string[] = [];
const user = () => {
  const id = randomUUID();
  ids.push(id);
  return id;
};
const originalKey = settings.openaiKey;
beforeAll(async () => {
  key = await generateKeyPair("RS256");
});
afterEach(async () => {
  stopChatGPTLogins();
  vi.unstubAllGlobals();
  settings.openaiKey = originalKey;
  for (const id of ids.splice(0))
    await rm(resolve(appDir, `.local/chatgpt/${id}.json`), { force: true });
});
async function signed(clientId: string, nonce: string, sub = "subject-a") {
  return new SignJWT({ nonce, email: "alex@example.test" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://auth.openai.com")
    .setAudience(clientId)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key.privateKey);
}
function mockNetwork(
  nonce: string,
  scope = "openid chatgpt.tokens.use.direct",
  expires = 3600,
) {
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("oauth/token"))
        return new Response(
          JSON.stringify({
            access_token: "private-access",
            refresh_token: "private-refresh",
            id_token: await signed("oaiapp_test", nonce),
            expires_in: expires,
            scope,
          }),
        );
      if (target.endsWith("/v1/models"))
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: "available-model",
                display_name: "Available model",
                visibility: "list",
              },
              { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
            ],
          }),
        );
      if (target.endsWith("openid-configuration"))
        return new Response(
          JSON.stringify({
            issuer: "https://auth.openai.com",
            revocation_endpoint: "https://auth.openai.com/revoke",
          }),
        );
      if (target.endsWith("/revoke")) return new Response("");
      return originalFetch(url, init);
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function start(id: string, profileId?: string) {
  const result = await startChatGPTLogin(id, profileId);
  const startResponse = await originalFetch(result.url, { redirect: "manual" });
  expect(startResponse.status).toBe(302);
  return new URL(startResponse.headers.get("location")!);
}
async function connect(id: string, scope?: string, expires?: number) {
  const auth = await start(id);
  const network = mockNetwork(auth.searchParams.get("nonce")!, scope, expires);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  callback.searchParams.set("client_id", "oaiapp_test");
  callback.searchParams.set("code", "one-time-code");
  const result = await originalFetch(callback);
  expect(result.status, await result.text()).toBe(200);
  return { network, auth };
}
it("uses PKCE, a stable host, and one-time state-bound loopback callbacks", async () => {
  const id = user(),
    auth = await start(id);
  expect(auth.origin).toBe("https://auth.openai.com");
  expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(auth.searchParams.get("agent_name_hint")).toBe("RoleLoop");
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  expect(callback.hostname).toBe("127.0.0.1");
  expect(callback.pathname).toBe("/auth/callback");
  callback.searchParams.set("state", "wrong");
  callback.searchParams.set("code", "bad");
  expect((await originalFetch(callback)).status).toBe(400);
  expect((await chatgptStatus(id)).profiles).toHaveLength(0);
  const again = await start(id);
  expect(again.searchParams.get("state")).not.toBe(
    auth.searchParams.get("state"),
  );
  expect(again.searchParams.get("ext_agent_host_id")).toBe(
    auth.searchParams.get("ext_agent_host_id"),
  );
});
it("checks signed identity, audience, nonce, and selected-account identity", async () => {
  const token = await signed("oaiapp_test", "nonce");
  expect((await verifyIdentity(token, "oaiapp_test", "nonce")).subject).toBe(
    "subject-a",
  );
  await expect(verifyIdentity(token, "wrong", "nonce")).rejects.toThrow();
  await expect(verifyIdentity(token, "oaiapp_test", "wrong")).rejects.toThrow();
  await expect(
    verifyIdentity(token, "oaiapp_test", "nonce", "another-subject"),
  ).rejects.toThrow();
});
it("protects credentials, isolates users, discovers models and reuses issued registrations", async () => {
  const alice = user(),
    bob = user();
  const { network } = await connect(alice);
  const state = await chatgptStatus(alice);
  expect(state).toMatchObject({
    mode: "chatgpt",
    profiles: [
      {
        connected: true,
        planEnabled: true,
        model: "available-model",
        models: [{ slug: "available-model", displayName: "Available model" }],
      },
    ],
  });
  await chatgptStatus(alice);
  expect(
    network.mock.calls.filter(([url]) => String(url).endsWith("/v1/models")),
  ).toHaveLength(1);
  expect(JSON.stringify(state)).not.toMatch(
    /private-access|private-refresh|idToken/,
  );
  expect((await chatgptStatus(bob)).profiles).toHaveLength(0);
  await expect(selectChatGPT(bob, state.activeId!)).rejects.toThrow(
    "not found",
  );
  expect(
    (await stat(resolve(appDir, `.local/chatgpt/${alice}.json`))).mode & 0o777,
  ).toBe(0o600);
  expect(await listChatGPTModels(alice)).toEqual([
    { slug: "available-model", displayName: "Available model" },
  ]);
  await expect(selectChatGPT(alice, state.activeId!, "hidden")).rejects.toThrow(
    "available",
  );
  const again = await start(alice, state.activeId);
  expect(again.searchParams.get("client_id")).toBe("oaiapp_test");
  expect(again.searchParams.has("agent_name_hint")).toBe(false);
});
it("keeps identity-only connections but blocks plan requests and API fallback", async () => {
  const id = user();
  await connect(id, "openid email");
  settings.openaiKey = "api-key-must-not-be-used";
  expect((await chatgptStatus(id)).profiles[0].planEnabled).toBe(false);
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  await expect(
    structuredAI(
      z.object({ value: z.string() }),
      "test",
      "instructions",
      {},
      id,
    ),
  ).rejects.toThrow("Enable ChatGPT plan usage");
  expect(network).not.toHaveBeenCalled();
});
it("streams plan requests with the selected model and requires final completion", async () => {
  const id = user();
  await connect(id);
  await listChatGPTModels(id);
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":"{\\\"value\\\":\\\"ok\\\"}"}]}]}}\n\n',
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await structuredAI(
      z.object({ value: z.string() }),
      "test",
      "instructions",
      {},
      id,
    ),
  ).toEqual({ value: "ok" });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body).toMatchObject({
    model: "available-model",
    stream: true,
    store: false,
    instructions: "instructions",
  });
  expect(body.input).toEqual([{ role: "user", content: "{}" }]);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
    "Bearer private-access",
  );
  await expect(
    completedResponse(
      new Response(
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      ),
    ),
  ).rejects.toThrow("interrupted");
  await expect(
    completedResponse(
      new Response(
        'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
      ),
    ),
  ).rejects.toMatchObject({ statusCode: 429 });
});
it("revokes and disconnects without silently switching to API billing", async () => {
  const id = user();
  await connect(id);
  const state = await chatgptStatus(id);
  expect(await disconnectChatGPT(id, state.activeId!)).toEqual({
    message: "ChatGPT disconnected.",
  });
  expect((await chatgptStatus(id)).mode).toBe("chatgpt");
  await expect(chatgptCredential(id)).rejects.toThrow(
    "Connect your ChatGPT account",
  );
  expect(
    await readFile(resolve(appDir, `.local/chatgpt/${id}.json`), "utf8"),
  ).not.toMatch(/private-access|private-refresh/);
});
it("serializes rotating token refresh across concurrent requests", async () => {
  const id = user();
  await connect(id, "openid chatgpt.tokens.use.direct", 1);
  const network = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
        }),
      ),
  );
  vi.stubGlobal("fetch", network);
  const results = await Promise.all([
    chatgptCredential(id),
    chatgptCredential(id),
  ]);
  expect(results.map((result) => result?.token)).toEqual([
    "rotated-access",
    "rotated-access",
  ]);
  expect(network).toHaveBeenCalledTimes(1);
  const stored = await readFile(
    resolve(appDir, `.local/chatgpt/${id}.json`),
    "utf8",
  );
  expect(stored).toContain("rotated-refresh");
  expect(stored).not.toContain("private-refresh");
});
it("clears revoked refresh credentials while retaining the client registration", async () => {
  const id = user();
  await connect(id, "openid chatgpt.tokens.use.direct", 1);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    ),
  );
  await expect(chatgptCredential(id)).rejects.toThrow("expired");
  const status = await chatgptStatus(id);
  expect(status.mode).toBe("chatgpt");
  expect(status.profiles[0].connected).toBe(false);
  const stored = await readFile(
    resolve(appDir, `.local/chatgpt/${id}.json`),
    "utf8",
  );
  expect(stored).toContain("oaiapp_test");
  expect(stored).not.toContain("private-refresh");
});
it("preserves credentials after a temporary refresh failure", async () => {
  const id = user();
  await connect(id, "openid chatgpt.tokens.use.direct", 1);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "Temporarily unavailable" }), {
          status: 503,
        }),
    ),
  );
  await expect(chatgptCredential(id)).rejects.toThrow("503");
  expect((await chatgptStatus(id)).profiles[0].connected).toBe(true);
});
it("rejects expired signed identities", async () => {
  const token = await new SignJWT({ nonce: "nonce" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://auth.openai.com")
    .setAudience("oaiapp_test")
    .setSubject("subject-a")
    .setExpirationTime("1 second ago")
    .sign(key.privateKey);
  await expect(verifyIdentity(token, "oaiapp_test", "nonce")).rejects.toThrow();
});
it("pauses subscription requests after a usage limit until explicitly retried", async () => {
  const id = user();
  await connect(id);
  await listChatGPTModels(id);
  settings.openaiKey = "do-not-fallback";
  const network = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        }),
        { status: 429 },
      ),
  );
  vi.stubGlobal("fetch", network);
  const request = () =>
    structuredAI(
      z.object({ value: z.string() }),
      "test",
      "instructions",
      {},
      id,
    );
  await expect(request()).rejects.toMatchObject({ statusCode: 429 });
  await expect(request()).rejects.toMatchObject({ statusCode: 429 });
  expect(network).toHaveBeenCalledTimes(1);
  const { retryChatGPT } = await import("../src/server/chatgpt.js");
  await retryChatGPT(id);
  await expect(request()).rejects.toMatchObject({ statusCode: 429 });
  expect(network).toHaveBeenCalledTimes(2);
});

it("automatically retries failed model discovery without losing the connection", async () => {
  const id = user();
  const { network } = await connect(id);
  const modelFailure = vi.fn(
    async () =>
      new Response(JSON.stringify({ detail: "Temporarily unavailable" }), {
        status: 503,
      }),
  );
  vi.stubGlobal("fetch", modelFailure);
  const failed = await chatgptStatus(id);
  expect(failed.profiles[0].connected).toBe(true);
  expect(failed.profiles[0].models).toEqual([]);
  expect(failed.modelsError).toContain("503");
  vi.stubGlobal("fetch", network);
  const recovered = await chatgptStatus(id);
  expect(recovered.modelsError).toBeUndefined();
  expect(recovered.profiles[0].model).toBe("available-model");
});
it("reports an empty model catalog with an actionable error", async () => {
  const id = user();
  await connect(id);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ models: [] }))),
  );
  const state = await chatgptStatus(id);
  expect(state.profiles[0].connected).toBe(true);
  expect(state.modelsError).toContain("No models are available");
});
it("shares concurrent catalog loads and keeps the result cached", async () => {
  const id = user();
  const { network } = await connect(id);
  const results = await Promise.all([
    chatgptStatus(id),
    chatgptStatus(id),
    chatgptStatus(id),
  ]);
  expect(
    results.every((state) => state.profiles[0].model === "available-model"),
  ).toBe(true);
  await chatgptStatus(id);
  expect(
    network.mock.calls.filter(([url]) => String(url).endsWith("/v1/models")),
  ).toHaveLength(1);
});
it("reloads the model catalog when switching back to a saved account", async () => {
  const id = user();
  await connect(id);
  const first = (await chatgptStatus(id)).activeId!;
  const { network } = await connect(id);
  await chatgptStatus(id);
  network.mockClear();
  await selectChatGPT(id, first);
  const selected = await chatgptStatus(id);
  expect(selected.activeId).toBe(first);
  expect(selected.profiles.find((p) => p.id === first)?.model).toBe(
    "available-model",
  );
  expect(
    network.mock.calls.filter(([url]) => String(url).endsWith("/v1/models")),
  ).toHaveLength(1);
});
