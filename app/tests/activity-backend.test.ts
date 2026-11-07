import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueue,
  analyze,
  processRun,
  recordOpportunityChanges,
} from "../src/server/service.js";
import {
  discover,
  freshFeedRecords,
  research,
} from "../src/domain/connectors.js";
import { getGlobalRuntime } from "../src/server/store.js";
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
    runtimeMany: async (keys: string[]) =>
      new Map(
        keys
          .filter((key) => runtime.has(key))
          .map((key) => [key, runtime.get(key)]),
      ),
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
  vi.mocked(freshFeedRecords).mockImplementation((ops) => ops);
  vi.mocked(research).mockImplementation(async (op) => ({
    description: op.description,
    notes: "The public company website was inspected for this test.",
  }));
  vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => ({
    ...assessOpportunity(op, workspace.profile, workspace.preferences),
    ...(op.kind === "startup"
      ? {
          startupFit: {
            method: "semantic" as const,
            status: "potential" as const,
          },
          fitSummary:
            "Your interface delivery experience could contribute to this collaboration product.",
          relevantEvidenceIds: ["demo-e1"],
        }
      : {}),
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
  it.each(["drafted", "archived"] as const)(
    "retains AI fit after a concurrent local refresh and preserves %s progress",
    async (stage) => {
      const [job] = demoOpportunities();
      const t = setup([job]);
      const local = assessOpportunity(
        job,
        t.workspace.profile,
        t.workspace.preferences,
      );
      const semantic = {
        ...assessOpportunity(
          job,
          t.workspace.profile,
          t.workspace.preferences,
          new Date(),
          local.matches,
        ),
        fitSummary: "The required work is supported by the resume.",
      };
      const concurrent: Opportunity = {
        ...job,
        assessment: local,
        stage,
        notes: "Keep this note added while evaluation was running.",
        application: {
          status: "applied",
          appliedAt: "2026-11-07T12:00:00Z",
          notes: "Already sent through the employer website.",
          nextAction: "Follow up next week",
          followUpOn: "2026-11-14",
        },
        updatedAt: new Date(Date.parse(job.updatedAt) + 1000).toISOString(),
      };
      vi.mocked(assessWithAI).mockImplementation(async () => {
        // Bootstrap can save a local assessment while the AI call is pending.
        t.opportunities.set(job.id, concurrent);
        return semantic;
      });

      const result = await analyze(t.store, job, t.workspace);

      expect(result.assessment).toEqual(semantic);
      expect(result).toMatchObject({
        notes: concurrent.notes,
        application: concurrent.application,
        stage,
      });
      expect(t.opportunities.get(job.id)).toEqual(result);
      expect(assessWithAI).toHaveBeenCalledTimes(1);
    },
  );

  it("retains the AI result when a local refresh wins the final conditional write", async () => {
    const [job] = demoOpportunities();
    const t = setup([job]);
    const local = assessOpportunity(job, t.workspace.profile, t.workspace.preferences);
    const semantic = {
      ...assessOpportunity(job, t.workspace.profile, t.workspace.preferences, new Date(), local.matches),
      fitSummary: "Completed experience comparison.",
    };
    vi.mocked(assessWithAI).mockResolvedValue(semantic);
    const conditionalSave = t.store.saveDerivedOpportunity;
    let conflicted = false;
    const save = vi.spyOn(t.store, "saveDerivedOpportunity").mockImplementation(
      async (original, next) => {
        if (!conflicted) {
          conflicted = true;
          t.opportunities.set(job.id, {
            ...job,
            assessment: local,
            updatedAt: new Date(Date.parse(original.updatedAt) + 1000).toISOString(),
          });
        }
        return conditionalSave(original, next);
      },
    );

    const result = await analyze(t.store, job, t.workspace);

    expect(result.assessment).toEqual(semantic);
    expect(t.opportunities.get(job.id)?.assessment).toEqual(semantic);
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(assessWithAI).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a same-millisecond local refresh for a successful AI save", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
    try {
      const [job] = demoOpportunities(new Date(Date.now() - 1000));
      const t = setup([job]);
      const local = assessOpportunity(job, t.workspace.profile, t.workspace.preferences);
      const semantic = {
        ...assessOpportunity(job, t.workspace.profile, t.workspace.preferences, new Date(), local.matches),
        fitSummary: "Completed experience comparison.",
      };
      vi.mocked(assessWithAI).mockImplementation(async () => {
        t.opportunities.set(job.id, {
          ...job,
          assessment: local,
          updatedAt: new Date().toISOString(),
        });
        return semantic;
      });

      const result = await analyze(t.store, job, t.workspace);

      expect(result.assessment).toEqual(semantic);
      expect(t.opportunities.get(job.id)?.assessment).toEqual(semantic);
      expect(assessWithAI).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["profile", "preferences"] as const)(
    "discards stale AI fit when %s change between conditional-write attempts",
    async (changed) => {
      const [job] = demoOpportunities();
      const t = setup([job]);
      const snapshot = structuredClone(t.workspace);
      const local = assessOpportunity(job, snapshot.profile, snapshot.preferences);
      const semantic = {
        ...assessOpportunity(job, snapshot.profile, snapshot.preferences, new Date(), local.matches),
        fitSummary: "This comparison uses the old workspace facts.",
      };
      vi.mocked(assessWithAI).mockResolvedValue(semantic);
      const conditionalSave = t.store.saveDerivedOpportunity;
      let conflicted = false;
      vi.spyOn(t.store, "saveDerivedOpportunity").mockImplementation(
        async (original, next) => {
          if (!conflicted) {
            conflicted = true;
            if (changed === "profile")
              t.workspace.profile.cache!.facts!.evidence = [];
            else t.workspace.preferences.minimumSalary = 1_000_000;
            t.opportunities.set(job.id, {
              ...job,
              assessment: local,
              notes: "Keep the concurrent note.",
              updatedAt: new Date(Date.parse(original.updatedAt) + 1000).toISOString(),
            });
          }
          return conditionalSave(original, next);
        },
      );

      const result = await analyze(t.store, job, snapshot);

      expect(result.assessment?.fitSummary).toBeUndefined();
      expect(result.assessment?.fitEvaluation?.method).not.toBe("semantic");
      expect(result.assessment?.profileFingerprint).toBe(profileFingerprint(t.workspace.profile));
      expect(result.assessment?.preferencesFingerprint).toBe(preferencesFingerprint(t.workspace.preferences));
      expect(result.notes).toBe("Keep the concurrent note.");
      expect(t.opportunities.get(job.id)).toEqual(result);
      expect(assessWithAI).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves an edit and archive made while AI is evaluating a job", async () => {
    const [job] = demoOpportunities();
    const t = setup([job]);
    const edited = {
      ...job,
      title: "Corrected title",
      notes: "Keep my note",
      stage: "archived" as const,
      updatedAt: new Date(Date.parse(job.updatedAt) + 1000).toISOString(),
    };
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => {
      t.opportunities.set(job.id, edited);
      return {
        ...assessOpportunity(op, workspace.profile, workspace.preferences),
        fitSummary: "This assessment belongs to the previous job facts.",
      };
    });
    const result = await analyze(t.store, job, t.workspace);
    expect(result).toEqual(edited);
    expect(t.opportunities.get(job.id)).toEqual(edited);
  });

  it("does not recreate a job removed during AI evaluation", async () => {
    const [job] = demoOpportunities();
    const t = setup([job]);
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => {
      t.opportunities.delete(job.id);
      return assessOpportunity(op, workspace.profile, workspace.preferences);
    });
    await expect(analyze(t.store, job, t.workspace)).rejects.toThrow("removed");
    expect(t.opportunities.size).toBe(0);
  });

  it("reports AI failures even when a concurrent local refresh updates the imported job", async () => {
    const [job] = demoOpportunities();
    const t = setup();
    vi.mocked(discover).mockResolvedValue([job]);
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => {
      const base = assessOpportunity(op, workspace.profile, workspace.preferences);
      t.opportunities.set(op.id, {
        ...op,
        assessment: base,
        updatedAt: new Date(Date.parse(op.updatedAt) + 1000).toISOString(),
      });
      return {
        ...base,
        recommendation: "review",
        fitEvaluation: {
          ...base.fitEvaluation!,
          failureReason: "AI fit is unavailable. Retry evaluation.",
        },
      };
    });
    await processRun(t.store, t.run, async () => {});
    expect(t.run).toMatchObject({
      outcome: "partial",
      summary: { evaluated: 1, evaluationFailures: 1, sourcesFailed: 0 },
    });
    expect(t.events.some((event) =>
      event.category === "evaluation" && event.kind === "warning" && event.opportunityId === job.id,
    )).toBe(true);
    expect(t.runtime.get(`fit:${job.id}`)).toBeUndefined();
  });

  it("does not report a failed feed refresh as healthy by replaying stale cached jobs", async () => {
    const t = setup();
    t.workspace.sources = [{ id: "feed", label: "Jobicy", provider: "jobicy", board: "", enabled: true }];
    t.workspace.preferences.discoverEmployers = false;
    vi.mocked(getGlobalRuntime).mockResolvedValue({
      at: Date.now(),
      opportunities: [demoOpportunities()[0]],
      ok: false,
    });
    await expect(processRun(t.store, t.run, async () => {})).rejects.toThrow("All selected sources failed");
    expect(discover).not.toHaveBeenCalled();
    expect(t.opportunities.size).toBe(0);
    expect(t.run.summary).toMatchObject({ sourcesFailed: 1, evaluated: 0 });
  });

  it("rechecks cached AI fit when a source expiry passes without another AI call", async () => {
    const [job] = demoOpportunities();
    job.sourceExpiresAt = new Date(Date.now() - 1000).toISOString();
    const t = setup([job]);
    job.assessment = {
      ...assessOpportunity(job, t.workspace.profile, t.workspace.preferences),
      evaluatedAt: new Date(Date.now() - 2000).toISOString(),
      recommendation: "ready",
      blockers: [],
      fitSummary: "Previous fit",
    };
    t.runtime.set(`fit:${job.id}`, {
      fingerprint: `2:${opportunityFingerprint(job)}:${profileFingerprint(t.workspace.profile)}:${preferencesFingerprint(t.workspace.preferences)}:api`,
      at: Date.now(),
    });
    vi.mocked(discover).mockResolvedValue([job]);
    await processRun(t.store, t.run, async () => {});
    expect(assessWithAI).not.toHaveBeenCalled();
    expect(t.opportunities.get(job.id)?.assessment?.recommendation).toBe("excluded");
    expect(t.opportunities.get(job.id)?.assessment?.fitSummary).toBeUndefined();
  });

  it("does not extend the AI cache lifetime after a local date recheck", async () => {
    const [job] = demoOpportunities();
    const t = setup([job]);
    const at = Date.now() - 23 * 60 * 60 * 1000;
    job.assessment = {
      ...assessOpportunity(job, t.workspace.profile, t.workspace.preferences),
      evaluatedAt: new Date(at).toISOString(),
      fitSummary: "Original semantic fit",
    };
    const cached = {
      fingerprint: `2:${opportunityFingerprint(job)}:${profileFingerprint(t.workspace.profile)}:${preferencesFingerprint(t.workspace.preferences)}:api`,
      at,
    };
    t.runtime.set(`fit:${job.id}`, cached);
    vi.mocked(discover).mockResolvedValue([job]);
    await processRun(t.store, t.run, async () => {});
    expect(assessWithAI).not.toHaveBeenCalled();
    expect(t.runtime.get(`fit:${job.id}`)).toEqual(cached);
  });

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
      { ...demoOpportunities()[3], title: "A collaborative product" },
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
    const startup = {
      ...demoOpportunities()[3],
      title: "A collaborative product",
    };
    vi.mocked(discover).mockResolvedValue([startup]);
    await processRun(t.store, t.run, async () => {});
    expect(generateDraft).toHaveBeenCalledTimes(1);
    expect([...t.drafts.values()]).toEqual([
      expect.objectContaining({ kind: "outreach", opportunityId: startup.id }),
    ]);
    expect(t.run.summary?.draftsCreated).toBe(1);
  });

  it("reports evaluation failure without misclassifying a successful source fetch", async () => {
    const t = setup();
    vi.mocked(discover).mockResolvedValue([demoOpportunities()[0]]);
    vi.mocked(assessWithAI).mockRejectedValue(
      new Error("Assessment interrupted"),
    );
    await expect(processRun(t.store, t.run, async () => {})).resolves.toContain(
      "1 evaluation(s) need retry",
    );
    expect(t.runs.get(t.run.id)).toMatchObject({
      outcome: "partial",
      summary: {
        newOpportunities: 1,
        evaluated: 0,
        sourcesFailed: 0,
        evaluationFailures: 1,
        draftsCreated: 0,
      },
    });
    expect(t.events).toHaveLength(2);
    expect(t.events[0]).toMatchObject({
      runId: t.run.id,
      category: "evaluation",
      kind: "warning",
    });
    expect(t.runtime.get("source-health")).toMatchObject({
      acme: { status: "success", found: 1, evaluated: 0 },
    });
  });
});

describe("concurrent discovery evaluations", () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  it("evaluates at most three unique jobs together and reports ordered progress", async () => {
    const [base] = demoOpportunities();
    const jobs = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      id: `parallel-${index}`,
      sourceKey: `ashby:parallel-${index}`,
    }));
    const t = setup();
    t.workspace.sources.push({
      ...t.workspace.sources[0], id: "next", board: "next", label: "Next board",
    });
    vi.mocked(discover)
      .mockResolvedValueOnce([jobs[0], { ...jobs[0], id: "duplicate" }, ...jobs.slice(1)])
      .mockResolvedValueOnce([]);
    const firstWave = gate();
    const fourthJob = gate();
    const pending = new Map<string, ReturnType<typeof gate>>();
    const started: string[] = [];
    let active = 0, peak = 0, releaseRemaining = false;
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => {
      active++;
      peak = Math.max(peak, active);
      started.push(op.id);
      const deferred = gate();
      pending.set(op.id, deferred);
      if (started.length === 3) firstWave.release();
      if (started.length === 4) fourthJob.release();
      if (!releaseRemaining) await deferred.promise;
      active--;
      return assessOpportunity(op, workspace.profile, workspace.preferences);
    });
    const messages: string[] = [];
    const amounts: number[] = [];
    let progressActive = 0, progressPeak = 0;
    const run = processRun(t.store, t.run, async (amount, message) => {
      progressActive++;
      progressPeak = Math.max(progressPeak, progressActive);
      amounts.push(amount);
      messages.push(message);
      await Promise.resolve();
      progressActive--;
    });
    try {
      await firstWave.promise;
      expect(active).toBe(3);
      expect(started).toEqual(jobs.slice(0, 3).map((job) => job.id));
      expect(discover).toHaveBeenCalledTimes(1);
      pending.get(jobs[1].id)!.release();
      await fourthJob.promise;
      expect(active).toBe(3);
      expect(started).toHaveLength(4);
      expect(t.opportunities.has("duplicate")).toBe(false);
    } finally {
      releaseRemaining = true;
      for (const deferred of pending.values()) deferred.release();
      await run;
    }
    expect(peak).toBe(3);
    expect(progressPeak).toBe(1);
    expect(assessWithAI).toHaveBeenCalledTimes(5);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    expect(messages.filter((message) => message.startsWith("Evaluating Acme:"))).toEqual(
      Array.from({ length: 6 }, (_, finished) => `Evaluating Acme: ${finished}/5 checked`),
    );
    expect(t.run.summary).toMatchObject({ evaluated: 5, newOpportunities: 5, sourcesFailed: 0 });
    expect(t.runtime.get("source-health")).toMatchObject({
      acme: { status: "success", found: 6, evaluated: 5 },
    });
  });

  it("continues after an individual failure and waits for every in-flight job", async () => {
    const [base] = demoOpportunities();
    const jobs = Array.from({ length: 4 }, (_, index) => ({
      ...base,
      id: `failure-${index}`,
      sourceKey: `ashby:failure-${index}`,
    }));
    const t = setup();
    vi.mocked(discover).mockResolvedValue(jobs);
    const waiting = gate();
    const release = gate();
    let active = 0;
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => {
      if (op.id === jobs[0].id) throw new Error("One assessment failed");
      active++;
      if (active === 3) waiting.release();
      await release.promise;
      active--;
      return assessOpportunity(op, workspace.profile, workspace.preferences);
    });
    let settled = false;
    const run = processRun(t.store, t.run, async () => {}).finally(() => { settled = true; });
    try {
      await waiting.promise;
      expect(settled).toBe(false);
      expect(active).toBe(3);
    } finally {
      release.release();
      await run;
    }
    expect(active).toBe(0);
    expect(t.run).toMatchObject({
      outcome: "partial",
      summary: { evaluated: 3, newOpportunities: 4, evaluationFailures: 1, sourcesFailed: 0 },
    });
    expect(jobs.slice(1).every((job) => t.opportunities.get(job.id)?.assessment)).toBe(true);
    expect(t.events.filter((event) => event.category === "evaluation")).toEqual([
      expect.objectContaining({ opportunityId: jobs[0].id, kind: "warning", message: expect.stringContaining("One assessment failed") }),
    ]);
  });

  it("drains in-flight evaluations before returning a progress-write failure", async () => {
    const [base] = demoOpportunities();
    const jobs = Array.from({ length: 3 }, (_, index) => ({
      ...base,
      id: `progress-error-${index}`,
      sourceKey: `ashby:progress-error-${index}`,
    }));
    const t = setup();
    vi.mocked(discover).mockResolvedValue(jobs);
    const started = gate();
    const failedProgress = gate();
    const pending = jobs.map(() => gate());
    let active = 0, settled = false;
    vi.mocked(assessWithAI).mockImplementation(async (op, workspace) => {
      active++;
      if (active === 3) started.release();
      await pending[jobs.findIndex((job) => job.id === op.id)].promise;
      active--;
      return assessOpportunity(op, workspace.profile, workspace.preferences);
    });
    const result = processRun(t.store, t.run, async (_, message) => {
      if (message === "Evaluating Acme: 1/3 checked") {
        failedProgress.release();
        throw new Error("Progress storage unavailable");
      }
    }).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await started.promise;
      pending[0].release();
      await failedProgress.promise;
      expect(settled).toBe(false);
      expect(active).toBe(2);
    } finally {
      pending.forEach((deferred) => deferred.release());
    }
    expect(await result).toEqual(new Error("All selected sources failed. See Activity for source errors."));
    expect(active).toBe(0);
    expect(jobs.every((job) => t.opportunities.get(job.id)?.assessment)).toBe(true);
    expect(t.run.summary).toMatchObject({ evaluated: 3, sourcesFailed: 1 });
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
