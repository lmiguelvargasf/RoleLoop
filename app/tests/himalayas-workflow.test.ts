import { beforeEach, describe, expect, it, vi } from "vitest";
import { processRun } from "../src/server/service.js";
import { discover } from "../src/domain/connectors.js";
import { himalayasJobStatus } from "../src/domain/himalayas.js";
import type { WorkspaceStore } from "../src/server/store.js";
import type { Opportunity, Run } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/store.js", () => ({
  getGlobalRuntime: vi.fn(async () => null),
  setGlobalRuntime: vi.fn(async () => {}),
}));
vi.mock("../src/domain/connectors.js", async (original) => ({
  ...(await original()),
  discover: vi.fn(async () => []),
}));
vi.mock("../src/domain/himalayas.js", async (original) => ({
  ...(await original()),
  himalayasJobStatus: vi.fn(),
}));

function setup(count = 25) {
  const workspace = demoWorkspace();
  workspace.sources = [
    {
      id: "himalayas",
      provider: "himalayas",
      label: "Himalayas",
      board: "",
      enabled: true,
    },
  ];
  const jobs = Array.from(
    { length: count },
    (_, index): Opportunity => ({
      ...demoOpportunities()[0],
      id: `job-${String(index).padStart(2, "0")}`,
      source: "himalayas",
      sourceId: "himalayas",
      sourceKey: `himalayas:https://himalayas.app/companies/acme/jobs/job-${index}`,
      sourceAttributionUrl: `https://himalayas.app/companies/acme/jobs/job-${index}`,
      sourceExpiresAt: "2099-01-01T00:00:00.000Z",
      application: {
        status: "applied",
        appliedAt: "2026-11-01T00:00:00.000Z",
        notes: "Keep notes",
        nextAction: "Follow up",
        followUpOn: null,
      },
    }),
  );
  const runtime = new Map<string, unknown>();
  const store = {
    workspaceId: "himalayas-test",
    getWorkspace: async () => workspace,
    listAllOpportunities: async () => jobs,
    runtime: async (key: string) => runtime.get(key) ?? null,
    runtimeMany: async () => new Map(),
    setRuntime: async (key: string, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Runtime payload must be an object.");
      runtime.set(key, value);
    },
    save: vi.fn(async (_table: string, value: unknown) => value),
    importOpportunityWithStatus: vi.fn(async (candidate: Opportunity) => {
      const index = jobs.findIndex(
        (op) => op.sourceKey === candidate.sourceKey,
      );
      if (index < 0) {
        jobs.push(candidate);
        return { opportunity: candidate, created: true };
      }
      const previous = jobs[index];
      const next = {
        ...previous,
        ...candidate,
        id: previous.id,
        application: previous.application,
        stage: previous.stage,
        assessment: previous.assessment,
        firstSeenAt: previous.firstSeenAt,
      };
      jobs[index] = next;
      return { opportunity: next, created: false };
    }),
    saveDerivedOpportunity: vi.fn(
      async (original: Opportunity, next: Opportunity) => {
        jobs[jobs.indexOf(original)] = next;
        return next;
      },
    ),
    event: vi.fn(async () => ({})),
  } as unknown as WorkspaceStore;
  const run: Run = {
    id: "run",
    workspaceId: store.workspaceId,
    action: "discover",
    discoveryScope: "jobs",
    status: "running",
    progress: 0,
    message: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { workspace, jobs, runtime, store, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(discover).mockResolvedValue([]);
  vi.mocked(himalayasJobStatus).mockResolvedValue({
    status: "open",
    checkedAt: new Date().toISOString(),
  });
});

describe("Himalayas saved listing lifecycle", () => {
  it("bounds and rotates saved-job status checks while preserving application history on closure", async () => {
    const t = setup();
    const closedAt = new Date().toISOString();
    vi.mocked(himalayasJobStatus).mockResolvedValueOnce({
      status: "closed",
      checkedAt: closedAt,
      expiresAt: closedAt,
    });
    await processRun(t.store, t.run, async () => {});
    expect(himalayasJobStatus).toHaveBeenCalledTimes(20);
    expect(t.jobs[0].sourceExpiresAt).toBe(closedAt);
    expect(t.jobs[0].application).toMatchObject({
      status: "applied",
      notes: "Keep notes",
      nextAction: "Follow up",
    });
    expect(t.runtime.get("himalayas-status-offset:himalayas")).toEqual({
      offset: 20,
    });
    vi.mocked(himalayasJobStatus).mockClear();
    await processRun(t.store, t.run, async () => {});
    expect(himalayasJobStatus).toHaveBeenCalledTimes(20);
    expect(vi.mocked(himalayasJobStatus).mock.calls[0][0]).toContain("job-20");
  });

  it("reopens a renewed historical expiry and lets current detail status override cached feed expiry", async () => {
    const t = setup(1);
    t.workspace.preferences.minimumSalary = 1000000; // Keep this lifecycle regression local, without inference.
    t.jobs[0].sourceExpiresAt = "2020-01-01T00:00:00.000Z";
    const renewed = "2099-02-01T00:00:00.000Z";
    vi.mocked(himalayasJobStatus).mockResolvedValue({
      status: "open",
      checkedAt: new Date().toISOString(),
      expiresAt: renewed,
    });
    vi.mocked(discover).mockResolvedValue([
      { ...t.jobs[0], sourceExpiresAt: "2099-01-01T00:00:00.000Z" },
    ]);
    await processRun(t.store, t.run, async () => {});
    expect(himalayasJobStatus).toHaveBeenCalledTimes(1);
    expect(t.store.importOpportunityWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sourceExpiresAt: renewed }),
    );
    expect(t.jobs[0].sourceExpiresAt).toBe(renewed);
    expect(t.jobs[0].assessment?.blockers.join(" ")).not.toContain(
      "deadline has passed",
    );
    expect(t.jobs[0].application).toMatchObject({
      status: "applied",
      notes: "Keep notes",
      nextAction: "Follow up",
    });
  });

  it("keeps a fresh confirmed closure above an otherwise active cached search result", async () => {
    const t = setup(1);
    const closedAt = new Date().toISOString();
    vi.mocked(discover).mockResolvedValue([{ ...t.jobs[0] }]);
    vi.mocked(himalayasJobStatus).mockResolvedValue({
      status: "closed",
      checkedAt: closedAt,
      expiresAt: closedAt,
    });
    await processRun(t.store, t.run, async () => {});
    expect(t.store.importOpportunityWithStatus).not.toHaveBeenCalled();
    expect(t.jobs[0].sourceExpiresAt).toBe(closedAt);
    expect(t.jobs[0].application?.notes).toBe("Keep notes");
  });

  it("retries status updates against concurrent application edits without erasing history", async () => {
    const t = setup(1);
    const renewed = "2099-02-01T00:00:00.000Z";
    vi.mocked(himalayasJobStatus).mockResolvedValue({
      status: "open",
      checkedAt: new Date().toISOString(),
      expiresAt: renewed,
    });
    vi.mocked(t.store.saveDerivedOpportunity).mockImplementationOnce(
      async (original) => {
        const concurrent = {
          ...original,
          updatedAt: new Date(Date.now() + 1).toISOString(),
          application: {
            ...original.application!,
            notes: "Concurrent recruiter reply",
            repliedAt: new Date().toISOString(),
          },
        };
        t.jobs[0] = concurrent;
        return concurrent;
      },
    );
    await processRun(t.store, t.run, async () => {});
    expect(t.store.saveDerivedOpportunity).toHaveBeenCalledTimes(2);
    expect(t.jobs[0].sourceExpiresAt).toBe(renewed);
    expect(t.jobs[0].application).toMatchObject({
      notes: "Concurrent recruiter reply",
      repliedAt: expect.any(String),
      status: "applied",
    });
  });

  it("does not fetch paused sources or turn unknown status into closure", async () => {
    const t = setup(1);
    vi.mocked(himalayasJobStatus).mockResolvedValue({
      status: "unknown",
      checkedAt: new Date().toISOString(),
    });
    await processRun(t.store, t.run, async () => {});
    expect(t.store.saveDerivedOpportunity).not.toHaveBeenCalled();
    t.workspace.sources[0].enabled = false;
    vi.clearAllMocks();
    await expect(processRun(t.store, t.run, async () => {})).rejects.toThrow(
      "No job sources are enabled",
    );
    expect(himalayasJobStatus).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });
});
