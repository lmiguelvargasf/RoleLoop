import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { assessOpportunity } from "../src/domain/rules.js";
import type { Run, Source } from "../src/shared/types.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
afterEach(() => vi.restoreAllMocks());

integration("employer discovery job-search orchestration", () => {
  async function setup() {
    const { db, createWorkspaceStore } = await import("../src/server/store.js");
    const workspaceId = `employer-flow-${randomUUID()}`;
    const workspace = demoWorkspace();
    workspace.sources = [];
    workspace.preferences.discoverEmployers = true;
    const inserted = await db
      .from("workspace")
      .insert({ id: workspaceId, payload: workspace });
    if (inserted.error) throw inserted.error;
    const store = createWorkspaceStore({ workspaceId, client: db });
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      workspaceId,
      action: "discover",
      discoveryScope: "jobs",
      status: "running",
      progress: 0,
      message: "Isolated test",
      createdAt: now,
      updatedAt: now,
    };
    const source: Source = {
      id: "new-employer",
      provider: "ashby",
      board: "flow-employer",
      label: "Flow employer",
      enabled: true,
      discoveredFrom: "https://himalayas.app/companies/flow-employer",
      discoveredAt: now,
    };
    const job = {
      ...demoOpportunities()[0],
      id: randomUUID(),
      isDemo: false,
      company: source.label,
      companyCountry: "Unknown",
      source: "ashby",
      sourceId: source.id,
      sourceKey: "ashby:flow-employer:one",
      url: "https://jobs.ashbyhq.com/flow-employer/one",
    };
    const engine = await import("../src/domain/employer-discovery.js");
    const connectors = await import("../src/domain/connectors.js");
    const fit = await import("../src/server/fit.js");
    vi.spyOn(fit, "assessWithAI").mockImplementation(async (op, ws) =>
      assessOpportunity(op, ws.profile, ws.preferences),
    );
    const discovery = vi
      .spyOn(engine, "discoverEmployerBoards")
      .mockResolvedValue({
        boards: [{ source, opportunities: [job] }],
        companiesFound: 1,
        boardsChecked: 1,
        errors: [],
      });
    const readBoard = vi.spyOn(connectors, "discover").mockResolvedValue([job]);
    const { processRun } = await import("../src/server/service.js");
    const cleanup = async () => {
      for (const table of [
        "drafts",
        "runs",
        "events",
        "opportunities",
        "workspace_runtime",
      ])
        await db.from(table).delete().eq("workspace_id", workspaceId);
      const removed = await db.from("workspace").delete().eq("id", workspaceId);
      if (removed.error) throw removed.error;
    };
    return {
      store,
      run,
      source,
      job,
      discovery,
      readBoard,
      processRun,
      cleanup,
    };
  }

  it("connects a new employer, imports once, and preserves the application on repeat searches", async () => {
    const t = await setup();
    try {
      expect(await t.processRun(t.store, t.run, async () => {})).toContain(
        "1 company connected",
      );
      expect(t.readBoard).not.toHaveBeenCalled(); // Validated jobs are reused in the same run.
      const ws = await t.store.getWorkspace();
      expect(ws.sources).toHaveLength(1);
      expect(ws.sources[0].discoveredFrom).toBe(t.source.discoveredFrom);
      const [saved] = await t.store.list("opportunities");
      expect(saved.companyId).toBe(ws.sources[0].companyId);
      expect(saved.assessment?.recommendation).toBe("review"); // HQ stays unknown.
      await t.store.save("opportunities", {
        ...saved,
        application: {
          status: "applied",
          appliedAt: new Date().toISOString(),
          nextAction: "Follow up",
          followUpOn: null,
          notes: "Sent",
        },
      });
      await t.processRun(t.store, t.run, async () => {});
      expect((await t.store.getWorkspace()).sources).toHaveLength(1);
      const jobs = await t.store.list("opportunities");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(saved.id);
      expect(jobs[0].application?.status).toBe("applied");
    } finally {
      await t.cleanup();
    }
  });

  it("keeps followed-company searches working when employer discovery is unavailable", async () => {
    const t = await setup();
    try {
      await t.store.updateWorkspace({ sources: [t.source] });
      t.discovery.mockRejectedValue(
        new Error("Search provider temporarily unavailable."),
      );
      expect(await t.processRun(t.store, t.run, async () => {})).toContain(
        "Evaluated 1",
      );
      expect(
        (await t.store.runtime<{ status: string }>("employer-discovery"))
          ?.status,
      ).toBe("error");
      expect(await t.store.list("opportunities")).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  it("does not expand single-company searches and only imports target roles", async () => {
    const t = await setup();
    try {
      await t.store.updateWorkspace({ sources: [t.source] });
      t.readBoard.mockResolvedValue([
        t.job,
        {
          ...t.job,
          id: randomUUID(),
          sourceKey: "ashby:flow-employer:civil",
          title: "Civil Engineer",
        },
      ]);
      await t.processRun(
        t.store,
        { ...t.run, sourceId: t.source.id },
        async () => {},
      );
      expect(t.discovery).not.toHaveBeenCalled();
      expect(await t.store.list("opportunities")).toHaveLength(1);
      expect(await t.store.runtime("source-health")).toMatchObject({
        "new-employer": { found: 2, evaluated: 1 },
      });
    } finally {
      await t.cleanup();
    }
  });

  it("reads the current board if its connection changes after discovery", async () => {
    const t = await setup();
    try {
      const connect = t.store.connectDiscoveredSource;
      vi.spyOn(t.store, "connectDiscoveredSource").mockImplementationOnce(
        async (source) => {
          const result = await connect(source);
          const workspace = await t.store.getWorkspace();
          await t.store.updateWorkspace({
            sources: workspace.sources.map((s) => ({
              ...s,
              provider: "lever",
              board: "replacement",
            })),
          });
          return result;
        },
      );
      t.readBoard.mockResolvedValue([
        {
          ...t.job,
          source: "lever",
          sourceKey: "lever:replacement:current",
          url: "https://jobs.lever.co/replacement/current",
        },
      ]);
      await t.processRun(t.store, t.run, async () => {});
      expect(t.readBoard).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "lever", board: "replacement" }),
        expect.anything(),
      );
      const [saved] = await t.store.list("opportunities");
      expect(saved.sourceKey).toBe("lever:replacement:current");
    } finally {
      await t.cleanup();
    }
  });

  it("requires role and country preferences before expansion", async () => {
    const t = await setup();
    try {
      const workspace = await t.store.getWorkspace();
      await t.store.updateWorkspace({
        preferences: { ...workspace.preferences, country: "" },
      });
      await expect(
        t.processRun(t.store, t.run, async () => {}),
      ).rejects.toThrow("working country");
      expect(t.discovery).not.toHaveBeenCalled();
      expect(await t.store.runtime("employer-discovery")).toMatchObject({
        status: "needs_preferences",
      });
    } finally {
      await t.cleanup();
    }
  });

  it.each(["preferences changed", "paused"])(
    "stops connecting companies when discovery is %s mid-search",
    async (change) => {
      const t = await setup();
      try {
        t.discovery.mockImplementationOnce(async () => {
          const workspace = await t.store.getWorkspace();
          await t.store.updateWorkspace({
            preferences: {
              ...workspace.preferences,
              ...(change === "paused"
                ? { discoverEmployers: false }
                : { country: "Canada" }),
            },
          });
          return {
            boards: [{ source: t.source, opportunities: [t.job] }],
            companiesFound: 1,
            boardsChecked: 1,
            errors: [],
          };
        });
        const result = await t.processRun(t.store, t.run, async () => {});
        expect(result).toContain(
          change === "paused" ? "paused" : "preferences changed",
        );
        expect((await t.store.getWorkspace()).sources).toHaveLength(0);
        expect(await t.store.list("opportunities")).toHaveLength(0);
      } finally {
        await t.cleanup();
      }
    },
  );

  it("uses current salary preferences when they change during an assessment", async () => {
    const t = await setup();
    try {
      const workspace = await t.store.getWorkspace();
      const saved = await t.store.importOpportunity(t.job);
      const fit = await import("../src/server/fit.js");
      vi.mocked(fit.assessWithAI).mockImplementationOnce(async (op, ws) => {
        await t.store.updateWorkspace({
          preferences: { ...ws.preferences, minimumSalary: 200000 },
        });
        return assessOpportunity(op, ws.profile, ws.preferences);
      });
      const { analyze } = await import("../src/server/service.js");
      const result = await analyze(t.store, saved, workspace);
      expect(result.assessment?.recommendation).toBe("excluded");
      expect(result.assessment?.blockers.join(" ")).toContain(
        "salary maximum is below",
      );
    } finally {
      await t.cleanup();
    }
  });
});
