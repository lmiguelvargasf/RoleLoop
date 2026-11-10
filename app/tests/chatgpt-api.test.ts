import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.js";

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => ({ url: "https://auth.openai.com/example", manual: true })),
  complete: vi.fn(async () => ({ message: "ChatGPT connected." })),
}));
vi.mock("../src/server/auth.js", () => ({
  authenticate: vi.fn(async (req) => {
    if (req.headers.authorization !== "Bearer test-session")
      throw Object.assign(new Error("Sign in to continue."), { statusCode: 401 });
    return { user: { id: "current-user" } };
  }),
}));
vi.mock("../src/server/chatgpt.js", () => ({
  startChatGPTLogin: mocks.start,
  completeChatGPTLogin: mocks.complete,
  stopChatGPTLogins: vi.fn(),
}));
vi.mock("../src/server/service.js", () => ({}));
vi.mock("../src/server/resume-import.js", () => ({}));
vi.mock("../src/server/cv.js", () => ({}));
vi.mock("../src/server/documents.js", () => ({}));

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildServer();
});
afterEach(async () => app.close());
const callbackUrl =
  "http://127.0.0.1:42123/auth/callback?state=test-state&code=test-code";
const post = (path: string, payload: object, headers = {}) =>
  app.inject({
    method: "POST",
    url: `/api/account/chatgpt/${path}`,
    headers: {
      host: "127.0.0.1:4310",
      "content-type": "application/json",
      authorization: "Bearer test-session",
      ...headers,
    },
    payload,
  });

it("requires a verified RoleLoop session before completing a callback", async () => {
  const response = await post("complete", { callbackUrl }, { authorization: "" });
  expect(response.statusCode).toBe(401);
  expect(mocks.complete).not.toHaveBeenCalled();
});
it("completes only the signed-in user's attempt without returning callback data", async () => {
  const response = await post("complete", {
    callbackUrl: ` ${callbackUrl} `,
    userId: "another-user",
  });
  expect(response.statusCode).toBe(200);
  expect(mocks.complete).toHaveBeenCalledWith("current-user", callbackUrl);
  expect(response.json()).toEqual({ message: "ChatGPT connected." });
});
it.each([{}, { callbackUrl: "" }, { callbackUrl: "x".repeat(8193) }])(
  "rejects invalid callback payloads before completing sign-in: %j",
  async (payload) => {
    const response = await post("complete", payload);
    expect(response.statusCode).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
  },
);
it("retains the origin guard for callback submissions", async () => {
  const response = await post("complete", { callbackUrl }, { origin: "https://other.example" });
  expect(response.statusCode).toBe(403);
  expect(mocks.complete).not.toHaveBeenCalled();
});
it("passes an explicit manual sign-in request for the authenticated user", async () => {
  const response = await post("connect", { manual: true });
  expect(response.statusCode).toBe(200);
  expect(mocks.start).toHaveBeenCalledWith("current-user", undefined, true);
});
