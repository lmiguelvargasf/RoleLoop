import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueue,
  processRun,
  recordOpportunityChanges,
} from "../src/server/service.js";
import { discover } from "../src/domain/connectors.js";
import { discoverEmployerBoards } from "../src/domain/employer-discovery.js";
import { generateDraft } from "../src/server/model.js";
import { assessWithAI } from "../src/server/fit.js";
import {
  assessOpportunity,
  opportunityFingerprint,
  preferencesFingerprint,
  profileFingerprint,
} from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import type { WorkspaceStore } from "../src/server/store.js";
import type { Activity, Draft, Opportunity, Run } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/store.js", () => ({
  getGlobalRuntime: vi.fn(async () => null),
  setGlobalRuntime: vi.fn(async () => {}),
}));
vi.mock("../src/domain/connectors.js", () => ({
  discover: vi.fn(),
  research: vi.fn(),
  freshFeedRecords: vi.fn(),
}));
vi.mock("../src/domain/employer-discovery.js", () => ({
  discoverEmployerBoards: vi.fn(),
}));
vi.mock("../src/server/fit.js", () => ({
  assessWithAI: vi.fn(),
  FIT_PROMPT_VERSION: 2,
}));
vi.mock("../src/server/model.js", () => ({ generateDraft: vi.fn() }));
vi.mock("../src/server/chatgpt.js", () => ({ chatgptStatus: vi.fn() }));
vi.mock("../src/server/documents.js", () => ({
  resumePdf: vi.fn(),
  sendToLocalInbox: vi.fn(),
}));

function setup(existing: Opportunity[] = []) {
  const workspace = demoWorkspace();
  workspace.sources = [
    {
      id: "acme",
      label: "Acme",
      provider: "ashby",
      board: "acme",
      enabled: true,
    },
  ];
  const opportunities = new Map(existing.map((op) => [op.id, op]));
  const drafts = new Map<string, Draft>();
  const runs = new Map<string, Run>();
  const runtime = new Map<string, unknown>();
  const events: Activity[] = [];
  const tables = { opportunities, drafts, runs };
  const store = {
    workspaceId: "activity-test",
    getWorkspace: async () => workspace,
    ignoredDiscoveryIdentities: async () => [],
    list: async (table: keyof typeof tables) => [...tables[table].values()],
    get: async (table: keyof typeof tables, id: string) =>
      tables[table].get(id),
    save: async (
      table: keyof typeof tables,
      value: Opportunity | Draft | Run,
    ) => {
      (tables[table] as Map<string, Opportunity | Draft | Run>).set(
        value.id,
        structuredClone(value),
      );
      return value;
    },
    saveDerivedOpportunity: async (
      original: Opportunity,
      next: Opportunity,
    ) => {
      const current = opportunities.get(original.id);
      if (!current || current.updatedAt !== original.updatedAt)
        return current ?? null;
      opportunities.set(next.id, structuredClone(next));
      return next;
    },
    importOpportunityWithStatus: async (candidate: Opportunity) => {
      const old = [...opportunities.values()].find(
        (op) => op.sourceKey === candidate.sourceKey,
      );
      const opportunity = old
        ? { ...candidate, ...old }
        : structuredClone(candidate);
      opportunities.set(opportunity.id, opportunity);
      return { opportunity, created: !old };
    },
    runtime: async (key: string) => runtime.get(key) ?? null,
    setRuntime: async (key: string, value: unknown) => runtime.set(key, value),
    event: vi.fn(
      async (
        message: string,
        kind: Activity["kind"] = "info",
        opportunityId?: string,
        context: Pick<Activity, "runId" | "category"> = {},
      ) => {
        const event = {
          id: randomUUID(),
          message,
          kind,
          opportunityId,
          ...context,
          createdAt: new Date().toISOString(),
        };
        events.push(event);
        return event;
      },
    ),
  } as unknown as WorkspaceStore;
  const now = new Date().toISOString();
  const run: Run = {
    id: randomUUID(),
    workspaceId: store.workspaceId,
    action: "discover",
    discoveryScope: "jobs",
    status: "running",
    progress: 0,
    message: "Starting",
    createdAt: now,
    updatedAt: now,
  };
  return {
    workspace,
    store,
    run,
    runs,
    opportunities,
    drafts,
    events,
    runtime,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(discover).mockResolvedValue([]);
  vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => ({
    ...assessOpportunity(op, workspace.profile, workspace.preferences),
    recommendation: "ready",
    blockers: [],
    unknowns: [],
  }));
  vi.mocked(generateDraft).mockImplementation(
    async (op, workspace, assessment) =>
      createDraft(op, workspace.profile, workspace.preferences, assessment),
  );
});

describe("useful discovery history", () => {
  it("refreshes fit produced by the old prompt, then reuses the current prompt result", async () => {
    const [job] = demoOpportunities();
    const t = setup([job]);
    job.assessment = {
      ...assessOpportunity(job, t.workspace.profile, t.workspace.preferences),
      fitSummary: "Previous prompt summary",
    };
    t.runtime.set(`fit:${job.id}`, {
      fingerprint: `${opportunityFingerprint(job)}:${profileFingerprint(t.workspace.profile)}:${preferencesFingerprint(t.workspace.preferences)}:api`,
      at: Date.now(),
    });
    vi.mocked(discover).mockResolvedValue([job]);
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => ({
      ...assessOpportunity(op, workspace.profile, workspace.preferences),
      fitSummary: "Current pragmatic fit summary",
    }));
    await processRun(t.store, t.run, async () => {});
    expect(assessWithAI).toHaveBeenCalledTimes(1);
    expect(t.opportunities.get(job.id)?.assessment?.fitSummary).toBe(
      "Current pragmatic fit summary",
    );
    await processRun(t.store, t.run, async () => {});
    expect(assessWithAI).toHaveBeenCalledTimes(1);
  });

  it("evaluates jobs without automatically preparing applications, even when eligible", async () => {
    const [base] = demoOpportunities();
    const jobs = [
      { ...base, id: "eligible", sourceKey: "ashby:eligible" },
      {
        ...base,
        id: "foreign",
        sourceKey: "ashby:foreign",
        location: "Bangalore, India",
        description: "Fully remote. Candidates must be based in India.",
        remoteScope: "worldwide" as const,
      },
      {
        ...base,
        id: "unclear",
        sourceKey: "ashby:unclear",
        location: "Remote",
        description: "Build TypeScript applications for our global customers.",
        remoteScope: "worldwide" as const,
      },
    ];
    const t = setup();
    vi.mocked(discover).mockResolvedValue(jobs);
    await processRun(t.store, t.run, async () => {});
    expect(vi.mocked(assessWithAI).mock.calls.map(([op]) => op.id)).toEqual([
      "eligible",
      "unclear",
    ]);
    expect(generateDraft).not.toHaveBeenCalled();
    expect(t.drafts.size).toBe(0);
    expect(t.opportunities.get("foreign")?.assessment?.recommendation).toBe(
      "excluded",
    );
    expect(t.opportunities.get("unclear")?.assessment?.geography?.status).toBe(
      "review",
    );
    expect(t.opportunities.size).toBe(3);
  });

  it("counts new and existing records separately and skips archives and duplicate results", async () => {
    const [old] = demoOpportunities();
    const archived = {
      ...old,
      id: "archived",
      sourceKey: "ashby:archived",
      stage: "archived" as const,
    };
    const fresh = { ...old, id: "fresh", sourceKey: "ashby:fresh" };
    const t = setup([old, archived]);
    vi.mocked(discover).mockResolvedValue([
      { ...old, id: "incoming-old" },
      fresh,
      { ...fresh, id: "duplicate" },
      { ...archived, id: "incoming-archived" },
      {
        ...fresh,
        id: "unrelated",
        sourceKey: "civil",
        title: "Civil Engineer",
      },
    ]);

    await processRun(t.store, t.run, async () => {});

    expect(t.runs.get(t.run.id)).toMatchObject({
      outcome: "success",
      summary: {
        evaluated: 2,
        newOpportunities: 1,
        existingOpportunities: 1,
        draftsCreated: 0,
        sourcesChecked: 1,
        sourcesFailed: 0,
        companiesConnected: 0,
        draftFailures: 0,
      },
    });
    expect(t.events).toHaveLength(1);
    expect(t.events.every((event) => event.runId === t.run.id)).toBe(true);
    expect(t.events.filter((event) => event.category === "draft")).toHaveLength(
      0,
    );
    expect(t.events.at(-1)).toMatchObject({
      category: "search",
      kind: "success",
    });
  });

  it("reports partial results when a source fails, even though the search can finish", async () => {
    const t = setup();
    t.workspace.sources.push({
      ...t.workspace.sources[0],
      id: "failed",
      board: "failed",
      label: "Failed board",
    });
    vi.mocked(discover)
      .mockResolvedValueOnce([demoOpportunities()[0]])
      .mockRejectedValueOnce(new Error("Request timed out"));
    await processRun(t.store, t.run, async () => {});
    expect(t.run).toMatchObject({
      outcome: "partial",
      summary: { sourcesChecked: 2, sourcesFailed: 1, draftsCreated: 0 },
    });
    expect(t.events.find((event) => event.kind === "error")).toMatchObject({
      runId: t.run.id,
      category: "search",
      message: "Failed board: Request timed out",
    });
    expect(t.events.at(-1)?.kind).toBe("warning");
  });

  it("keeps startup draft failures visible on completed research", async () => {
    const t = setup();
    t.workspace.sources = demoWorkspace().sources;
    t.run.discoveryScope = "startups";
    vi.mocked(discover).mockResolvedValue([
      { ...demoOpportunities()[3], title: "Software Engineer" },
    ]);
    vi.mocked(generateDraft).mockRejectedValue(
      new Error("Draft service unavailable"),
    );
    await processRun(t.store, t.run, async () => {});
    expect(t.run).toMatchObject({
      outcome: "partial",
      summary: {
        evaluated: 1,
        draftsCreated: 0,
        draftFailures: 1,
        sourcesFailed: 0,
      },
    });
    expect(t.events.every((event) => event.runId === t.run.id)).toBe(true);
    expect(t.events.find((event) => event.category === "draft")?.kind).toBe(
      "error",
    );
    expect(t.events.at(-1)?.kind).toBe("warning");
  });

  it("continues preparing startup outreach during research", async () => {
    const t = setup();
    t.workspace.sources = demoWorkspace().sources;
    t.run.discoveryScope = "startups";
    const startup = { ...demoOpportunities()[3], title: "Software Engineer" };
    vi.mocked(discover).mockResolvedValue([startup]);
    await processRun(t.store, t.run, async () => {});
    expect(generateDraft).toHaveBeenCalledTimes(1);
    expect([...t.drafts.values()]).toEqual([
      expect.objectContaining({ kind: "outreach", opportunityId: startup.id }),
    ]);
    expect(t.run.summary?.draftsCreated).toBe(1);
  });

  it("preserves counts for a failed search and does not claim saved records were evaluated", async () => {
    const t = setup();
    vi.mocked(discover).mockResolvedValue([demoOpportunities()[0]]);
    vi.mocked(assessWithAI).mockRejectedValue(
      new Error("Assessment interrupted"),
    );
    await expect(processRun(t.store, t.run, async () => {})).rejects.toThrow(
      "All selected sources failed",
    );
    expect(t.runs.get(t.run.id)?.summary).toMatchObject({
      newOpportunities: 1,
      evaluated: 0,
      sourcesFailed: 1,
      draftsCreated: 0,
    });
    expect(t.events).toHaveLength(1);
    expect(t.events[0].runId).toBe(t.run.id);
  });
});

describe("explicit draft preparation", () => {
  it.each([0, 3])(
    "rejects archived jobs and startups before queueing or execution (%s)",
    async (index) => {
      const op = { ...demoOpportunities()[index], stage: "archived" as const };
      const t = setup([op]);
      const rpc = vi.fn();
      const store = { ...t.store, db: { rpc } } as unknown as WorkspaceStore;
      await expect(
        enqueue(store, { action: "draft", opportunityId: op.id }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Restore this opportunity"),
      });
      expect(rpc).not.toHaveBeenCalled();
      t.run.action = "draft";
      t.run.opportunityId = op.id;
      await expect(processRun(t.store, t.run, async () => {})).rejects.toThrow(
        "Restore this opportunity",
      );
      expect(assessWithAI).not.toHaveBeenCalled();
      expect(generateDraft).not.toHaveBeenCalled();
      expect(t.drafts.size).toBe(0);
      expect(t.opportunities.get(op.id)?.stage).toBe("archived");
    },
  );

  it.each(["assessment", "generation"] as const)(
    "preserves archiving and application progress during %s",
    async (phase) => {
      const op = demoOpportunities()[0];
      const t = setup([op]);
      t.run.action = "draft";
      t.run.opportunityId = op.id;
      const archived: Opportunity = {
        ...op,
        stage: "archived",
        updatedAt: "2026-11-07T23:00:00Z",
        application: {
          status: "withdrawn",
          appliedAt: "2026-11-06T12:00:00Z",
          notes: "Keep the submission history.",
          nextAction: "",
          followUpOn: null,
        },
      };
      if (phase === "assessment") {
        vi.mocked(assessWithAI).mockImplementation(async () => {
          t.opportunities.set(op.id, archived);
          return assessOpportunity(
            op,
            t.workspace.profile,
            t.workspace.preferences,
          );
        });
      } else {
        vi.mocked(generateDraft).mockImplementation(
          async (job, workspace, assessment) => {
            t.opportunities.set(op.id, archived);
            return createDraft(
              job,
              workspace.profile,
              workspace.preferences,
              assessment,
            );
          },
        );
      }
      await expect(processRun(t.store, t.run, async () => {})).rejects.toThrow(
        "Restore this opportunity",
      );
      expect(t.opportunities.get(op.id)).toEqual(archived);
      expect(t.drafts.size).toBe(0);
      if (phase === "assessment") expect(generateDraft).not.toHaveBeenCalled();
    },
  );

  it("prepares an explicitly requested application and retains progress edited during generation", async () => {
    const op = demoOpportunities()[0];
    const t = setup([op]);
    t.run.action = "draft";
    t.run.opportunityId = op.id;
    const application: Opportunity["application"] = {
      status: "saved",
      appliedAt: null,
      notes: "Discussed the role with a recruiter.",
      nextAction: "Send the application",
      followUpOn: "2026-11-10",
    };
    vi.mocked(generateDraft).mockImplementation(
      async (job, workspace, assessment) => {
        t.opportunities.set(op.id, {
          ...op,
          application,
          updatedAt: "2026-11-07T23:00:00Z",
        });
        return createDraft(
          job,
          workspace.profile,
          workspace.preferences,
          assessment,
        );
      },
    );
    await expect(processRun(t.store, t.run, async () => {})).resolves.toBe(
      "Draft prepared for review",
    );
    expect(t.drafts.size).toBe(1);
    expect(t.opportunities.get(op.id)).toMatchObject({
      stage: "drafted",
      application,
    });
  });

  it("never restores a job archived between draft storage and the final stage update", async () => {
    const op = demoOpportunities()[0];
    const t = setup([op]);
    t.run.action = "draft";
    t.run.opportunityId = op.id;
    const saveDerived = t.store.saveDerivedOpportunity;
    vi.spyOn(t.store, "saveDerivedOpportunity").mockImplementation(
      async (original, next) => {
        t.opportunities.set(op.id, {
          ...op,
          stage: "archived",
          updatedAt: "2026-11-07T23:00:00Z",
        });
        return saveDerived(original, next);
      },
    );
    await processRun(t.store, t.run, async () => {});
    expect(t.opportunities.get(op.id)?.stage).toBe("archived");
  });
});

describe("application decision history", () => {
  it("records actual status transitions without recording notes-only edits", async () => {
    const t = setup();
    let previous = demoOpportunities()[0];
    for (const status of [
      "applied",
      "interview",
      "offer",
      "rejected",
      "withdrawn",
      "saved",
    ] as const) {
      const saved = {
        ...previous,
        application: {
          status,
          appliedAt: null,
          nextAction: "",
          followUpOn: null,
          notes: "Updated",
        },
      };
      await recordOpportunityChanges(t.store, previous, saved);
      await recordOpportunityChanges(t.store, saved, {
        ...saved,
        application: { ...saved.application, notes: "Another note" },
      });
      previous = saved;
    }
    expect(t.events).toHaveLength(6);
    expect(t.events[0]).toMatchObject({
      category: "application",
      opportunityId: previous.id,
      kind: "info",
    });
    expect(t.events[0].message).toContain("Saved → Applied");
    expect(t.events.at(-1)?.message).toContain("Withdrawn → Saved");
  });

  it("records archive and restore decisions once", async () => {
    const t = setup();
    const previous = demoOpportunities()[0];
    const archived = { ...previous, stage: "archived" as const };
    await recordOpportunityChanges(t.store, previous, archived);
    await recordOpportunityChanges(t.store, archived, archived);
    await recordOpportunityChanges(t.store, archived, previous);
    expect(t.events.map((event) => event.message)).toEqual([
      `Archived ${previous.title} at ${previous.company}.`,
      `Restored ${previous.title} at ${previous.company} from the archive.`,
    ]);
  });
});
