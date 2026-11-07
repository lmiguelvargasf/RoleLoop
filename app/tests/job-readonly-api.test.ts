import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Opportunity } from "../src/shared/types.js";
import { applicationProgressFor } from "../src/shared/application-board.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { buildServer } from "../src/server/index.js";

const mocks = vi.hoisted(() => ({
  store: {
    get: vi.fn(),
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
vi.mock("../src/server/chatgpt.js", () => ({
  stopChatGPTLogins: vi.fn(),
}));
vi.mock("../src/server/resume-import.js", () => ({}));
vi.mock("../src/server/cv.js", () => ({}));
vi.mock("../src/server/documents.js", () => ({}));

describe("read-only job facts through the API", () => {
  let app: FastifyInstance;
  let job: Opportunity;

  beforeEach(async () => {
    vi.clearAllMocks();
    job = {
      ...demoOpportunities()[0],
      stage: "approved",
      descriptionTruncated: true,
      requirementsTruncated: true,
      notes: "Existing source note",
    };
    mocks.store.get.mockImplementation(async () => job);
    mocks.store.getWorkspace.mockResolvedValue(demoWorkspace());
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  const patch = (app: FastifyInstance, id: string, payload: object) =>
    app.inject({
      method: "PATCH",
      url: `/api/opportunities/${id}`,
      headers: {
        host: "127.0.0.1:4310",
        "content-type": "application/json",
        "x-workspace-id": "test-workspace",
      },
      payload,
    });

  it.each([
    { title: "Changed job title" },
    { requirements: [] },
    { salaryMin: 1 },
    { notes: "Changed source note" },
    { kind: "startup" },
    { stage: "archived", company: "Changed employer" },
    { application: { status: "saved" }, description: "Changed posting" },
  ])("rejects job fact edits atomically: %j", async (payload) => {
    const response = await patch(app, job.id, payload);

    expect(response.statusCode, response.body).toBe(400);
    expect(mocks.store.save).not.toHaveBeenCalled();
    expect(mocks.store.setRuntime).not.toHaveBeenCalled();
    expect(mocks.store.saveStartupWithCorrections).not.toHaveBeenCalled();
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.recordOpportunityChanges).not.toHaveBeenCalled();
  });

  it("allows archive and restore without rewriting job facts or application progress", async () => {
    job.application = applicationProgressFor(job, "applied");
    for (const stage of ["archived", "new"] as const) {
      const response = await patch(app, job.id, { stage });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ...job,
        stage,
        updatedAt: expect.any(String),
      });
      job = response.json<Opportunity>();
    }
    expect(mocks.store.setRuntime).not.toHaveBeenCalled();
    expect(mocks.analyze).toHaveBeenCalledTimes(2);
  });

  it("allows application tracking and preserves milestones and job facts", async () => {
    for (const status of ["saved", "applied", "interview", "offer"] as const) {
      const application = {
        ...applicationProgressFor(job, status),
        notes: "My application note",
        nextAction: "Follow up with recruiter",
        followUpOn: "2026-11-10",
      };
      const response = await patch(app, job.id, { application });

      expect(response.statusCode, response.body).toBe(200);
      const saved = response.json<Opportunity>();
      expect(saved).toEqual({
        ...job,
        application: expect.objectContaining({
          status,
          notes: application.notes,
          nextAction: application.nextAction,
          followUpOn: application.followUpOn,
        }),
        updatedAt: expect.any(String),
      });
      for (const field of ["appliedAt", "interviewAt", "offerAt"] as const)
        if (job.application?.[field])
          expect(saved.application?.[field]).toBe(job.application[field]);
      job = saved;
    }
    expect(job.application?.appliedAt).toBeTruthy();
    expect(job.application?.interviewAt).toBeTruthy();
    expect(job.application?.offerAt).toBeTruthy();
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.store.setRuntime).not.toHaveBeenCalled();
  });

  it("keeps startup facts editable without introducing omitted corrections", async () => {
    const startup = demoOpportunities().find((op) => op.kind === "startup")!;
    mocks.store.get.mockResolvedValue(startup);
    const response = await patch(app, startup.id, {
      title: "Reviewed startup prospect",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      ...startup,
      title: "Reviewed startup prospect",
      updatedAt: expect.any(String),
    });
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
  });
});
