import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Opportunity } from "../src/shared/types.js";
import { outreachProgressFor } from "../src/shared/outreach-board.js";
import { opportunityFingerprint } from "../src/domain/rules.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { buildServer } from "../src/server/index.js";

const mocks = vi.hoisted(() => ({
  store: {
    get: vi.fn(),
    saveDerivedOpportunity: vi.fn(
      async (_original: unknown, value: unknown) => value,
    ),
    save: vi.fn(async (_table: string, value: unknown) => value),
    getWorkspace: vi.fn(),
    saveStartupWithCorrections: vi.fn(async (value: unknown) => value),
    runtime: vi.fn(async () => null),
    setRuntime: vi.fn(),
  },
  analyze: vi.fn(async (_store: unknown, value: unknown) => value),
  recordOpportunityChanges: vi.fn(),
  invalidateDrafts: vi.fn(),
}));
vi.mock("../src/server/auth.js", () => ({
  authenticate: vi.fn(async () => ({ user: { id: "test-user" } })),
  workspaceAccess: vi.fn(async () => ({ store: mocks.store })),
}));
vi.mock("../src/server/service.js", () => ({
  analyze: mocks.analyze,
  recordOpportunityChanges: mocks.recordOpportunityChanges,
  invalidateDrafts: mocks.invalidateDrafts,
}));
vi.mock("../src/server/chatgpt.js", () => ({ stopChatGPTLogins: vi.fn() }));
vi.mock("../src/server/resume-import.js", () => ({}));
vi.mock("../src/server/cv.js", () => ({}));
vi.mock("../src/server/documents.js", () => ({}));

describe("startup outreach API", () => {
  let app: FastifyInstance;
  let startup: Opportunity;
  beforeEach(async () => {
    vi.clearAllMocks();
    startup = { ...demoOpportunities()[3], stage: "approved" };
    mocks.store.get.mockImplementation(async () => startup);
    mocks.store.getWorkspace.mockResolvedValue(demoWorkspace());
    app = await buildServer();
  });
  afterEach(async () => {
    await app.close();
  });
  const patch = (payload: object) =>
    app.inject({
      method: "PATCH",
      url: `/api/opportunities/${startup.id}`,
      headers: {
        host: "127.0.0.1:4310",
        "content-type": "application/json",
        "x-workspace-id": "test-workspace",
      },
      payload,
    });

  it("explicitly adds a startup and retains notes, milestones, fit and draft validity during status-only moves", async () => {
    const fingerprint = opportunityFingerprint(startup);
    const added = await patch({
      outreach: {
        status: "saved",
        notes: "Ask Maya about the platform",
        nextAction: "Write intro",
        followUpOn: "2026-11-12",
      },
    });
    expect(added.statusCode, added.body).toBe(200);
    startup = added.json<Opportunity>();
    expect(startup.outreach?.contactedAt).toBeNull();
    for (const status of [
      "contacted",
      "conversation",
      "closed",
      "saved",
      "contacted",
    ] as const) {
      const old = startup.outreach!;
      const response = await patch({
        outreach: {
          status,
          ...(status === "closed" ? { outcome: "opportunity" } : {}),
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      startup = response.json<Opportunity>();
      expect(startup.outreach).toMatchObject({
        status,
        notes: old.notes,
        nextAction: old.nextAction,
        followUpOn: old.followUpOn,
      });
      for (const field of [
        "contactedAt",
        "conversationAt",
        "closedAt",
      ] as const)
        if (old[field]) expect(startup.outreach![field]).toBe(old[field]);
      expect(opportunityFingerprint(startup)).toBe(fingerprint);
      expect(startup.stage).toBe("approved");
    }
    expect(startup.outreach).toMatchObject({
      contactedAt: expect.any(String),
      conversationAt: expect.any(String),
      closedAt: expect.any(String),
      outcome: "opportunity",
    });
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.invalidateDrafts).not.toHaveBeenCalled();
    expect(mocks.store.saveStartupWithCorrections).not.toHaveBeenCalled();
    expect(mocks.store.setRuntime).not.toHaveBeenCalled();
  });

  it("allows clearing notes and follow-ups without resetting the status", async () => {
    startup.outreach = {
      ...outreachProgressFor(startup, "conversation"),
      notes: "Old note",
      followUpOn: "2026-11-12",
    };
    const response = await patch({ outreach: { notes: "", followUpOn: null } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outreach).toMatchObject({
      status: "conversation",
      notes: "",
      followUpOn: null,
    });
  });

  it("retries a board move against current company facts and notes after a concurrent refresh", async () => {
    startup.outreach = outreachProgressFor(startup, "saved");
    const current = {
      ...startup,
      description: "Fresh website research",
      outreach: { ...startup.outreach, notes: "A note saved in another tab" },
    };
    mocks.store.saveDerivedOpportunity.mockResolvedValueOnce(current);
    const response = await patch({ outreach: { status: "contacted" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      description: current.description,
      outreach: { status: "contacted", notes: current.outreach.notes },
    });
    expect(mocks.store.saveDerivedOpportunity).toHaveBeenCalledTimes(2);
  });

  it("does not put tracking data into company corrections when editing both", async () => {
    const response = await patch({
      company: "Reviewed company",
      outreach: { status: "saved" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.store.saveStartupWithCorrections).toHaveBeenCalledWith(
      expect.objectContaining({
        outreach: expect.objectContaining({ status: "saved" }),
      }),
      { company: "Reviewed company" },
    );
  });

  it.each([
    { outreach: { status: "closed" } },
    { outreach: { status: "invalid" } },
    { outreach: { outcome: "invalid" } },
    { outreach: { notes: "x".repeat(10001) } },
    { outreach: null },
    { application: { status: "applied" } },
  ])(
    "rejects invalid outreach and job tracking on startups: %j",
    async (payload) => {
      const response = await patch(payload);
      expect(response.statusCode).toBe(400);
      expect(mocks.store.save).not.toHaveBeenCalled();
      expect(mocks.store.saveStartupWithCorrections).not.toHaveBeenCalled();
    },
  );

  it("rejects outreach tracking on jobs", async () => {
    startup = demoOpportunities()[0];
    const response = await patch({ outreach: { status: "saved" } });
    expect(response.statusCode).toBe(400);
    expect(mocks.store.save).not.toHaveBeenCalled();
  });
});
