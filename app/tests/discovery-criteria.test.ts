import { beforeEach, describe, expect, it, vi } from "vitest";
import { processRun } from "../src/server/service.js";
import { discover } from "../src/domain/connectors.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { assessWithAI } from "../src/server/fit.js";
import type { WorkspaceStore } from "../src/server/store.js";
import type { Opportunity, Run, Source } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/store.js", () => ({
  getGlobalRuntime: vi.fn(async () => null),
  setGlobalRuntime: vi.fn(async () => {}),
}));
vi.mock("../src/domain/connectors.js", async (original) => ({
  ...(await original()),
  discover: vi.fn(),
}));
vi.mock("../src/server/fit.js", async (original) => ({
  ...(await original()),
  assessWithAI: vi.fn(async (op, workspace) =>
    assessOpportunity(op, workspace.profile, workspace.preferences),
  ),
}));

beforeEach(() => vi.clearAllMocks());

function setup(provider: Source["provider"] = "ashby") {
  const workspace = demoWorkspace();
  workspace.preferences.dateMode = "strict";
  workspace.sources = [{
    id: "source", provider, label: "Test source",
    board: ["ashby", "greenhouse", "lever"].includes(provider) ? "test-employer" : "",
    enabled: true,
  }];
  const jobs: Opportunity[] = [];
  const store = {
    workspaceId: "criteria-test",
    getWorkspace: async () => workspace,
    listAllOpportunities: async () => [...jobs],
    runtime: async () => null,
    setRuntime: vi.fn(async () => {}),
    save: vi.fn(async (_table, value) => value),
    event: vi.fn(async () => ({})),
    importOpportunityWithStatus: vi.fn(async (candidate: Opportunity) => {
      const previous = jobs.find((op) => op.sourceKey === candidate.sourceKey);
      const opportunity = previous
        ? { ...candidate, id: previous.id, application: previous.application }
        : candidate;
      if (!previous) jobs.push(opportunity);
      return { opportunity, created: !previous };
    }),
    saveDerivedOpportunity: vi.fn(async (_original, next) => next),
  } as unknown as WorkspaceStore;
  const now = new Date().toISOString();
  const run: Run = {
    id: "run", workspaceId: store.workspaceId, action: "discover",
    discoveryScope: "jobs", status: "running", progress: 0, message: "",
    createdAt: now, updatedAt: now,
  };
  const job = { ...demoOpportunities()[0], sourceId: "source" };
  return { workspace, store, run, jobs, job };
}

describe("discovery criteria before saving", () => {
  it.each(["ashby", "greenhouse", "lever", "jobicy", "weworkremotely", "himalayas"] as const)(
    "does not save clear mismatches or spend AI calls from %s",
    async (provider) => {
      const t = setup(provider);
      const conflicts: Partial<Opportunity>[] = [
        { location: "Remote, United States", remoteScope: "us" },
        { remoteScope: "onsite" },
        { salaryMin: 1000, salaryMax: 2000 },
        { companyCountry: "Canada" },
        { publishedAt: "2020-01-01T00:00:00Z" },
        { sourceExpiresAt: "2020-01-01T00:00:00Z" },
      ];
      vi.mocked(discover).mockResolvedValue(conflicts.map((patch, index) => ({
        ...t.job, ...patch, id: `conflict-${index}`, sourceKey: `conflict:${index}`,
      })));
      await processRun(t.store, t.run, async () => {});
      expect(t.store.importOpportunityWithStatus).not.toHaveBeenCalled();
      expect(assessWithAI).not.toHaveBeenCalled();
      expect(t.run.summary).toMatchObject({ evaluated: 0, newOpportunities: 0 });
      expect(t.jobs).toEqual([]);
    },
  );

  it("retains unknown and borderline matches for review", async () => {
    const t = setup();
    const uncertain: Opportunity = {
      ...t.job, id: "uncertain", sourceKey: "uncertain",
      location: "Remote", remoteScope: "unknown", description: "React experience",
      companyCountry: "Unknown", salaryMin: null, salaryMax: null, publishedAt: null,
    };
    const borderline: Opportunity = {
      ...t.job, id: "borderline", sourceKey: "borderline",
      salaryMin: 80000, salaryMax: 95000,
    };
    vi.mocked(discover).mockResolvedValue([uncertain, borderline]);
    await processRun(t.store, t.run, async () => {});
    expect(t.store.importOpportunityWithStatus).toHaveBeenCalledTimes(2);
    expect(t.run.summary).toMatchObject({ evaluated: 2, newOpportunities: 2 });
    expect(assessOpportunity(uncertain, t.workspace.profile, t.workspace.preferences))
      .toMatchObject({ recommendation: "review", blockers: [] });
    expect(assessOpportunity(borderline, t.workspace.profile, t.workspace.preferences))
      .toMatchObject({ recommendation: "review", blockers: [] });
  });

  it("saves jobs from any target company country and skips other countries", async () => {
    const t = setup();
    t.workspace.preferences.companyCountry = "Netherlands, Germany";
    vi.mocked(discover).mockResolvedValue(
      ["Netherlands", "Germany", "Canada"].map((companyCountry) => ({
        ...t.job, id: companyCountry, sourceKey: companyCountry, companyCountry,
      })),
    );
    await processRun(t.store, t.run, async () => {});
    expect(t.jobs.map((job) => job.companyCountry)).toEqual(["Netherlands", "Germany"]);
    expect(assessWithAI).toHaveBeenCalledTimes(2);
    expect(t.run.summary).toMatchObject({ evaluated: 2, newOpportunities: 2 });
  });

  it("continues refreshing a saved application when its listing becomes excluded", async () => {
    const t = setup();
    const saved: Opportunity = {
      ...t.job,
      application: {
        status: "applied", appliedAt: new Date().toISOString(), notes: "Keep history",
        nextAction: "Follow up", followUpOn: null,
      },
    };
    t.jobs.push(saved);
    vi.mocked(discover).mockResolvedValue([{
      ...t.job, salaryMin: 1000, salaryMax: 2000,
    }]);
    await processRun(t.store, t.run, async () => {});
    expect(t.store.importOpportunityWithStatus).toHaveBeenCalledOnce();
    expect(t.store.saveDerivedOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ application: saved.application }),
      expect.objectContaining({
        application: saved.application,
        assessment: expect.objectContaining({ recommendation: "excluded" }),
      }),
    );
    expect(t.run.summary).toMatchObject({ evaluated: 1, newOpportunities: 0 });
    expect(assessWithAI).not.toHaveBeenCalled();
  });
});
