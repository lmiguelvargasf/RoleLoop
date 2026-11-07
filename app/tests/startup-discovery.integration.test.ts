import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessOpportunity,
  STARTUP_CONTRIBUTION_UNCONFIRMED,
} from "../src/domain/rules.js";
import type { Opportunity, Run, Source } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
afterEach(() => vi.restoreAllMocks());

integration("startup discovery and contribution orchestration", () => {
  async function setup() {
    const { db, createWorkspaceStore } = await import("../src/server/store.js");
    const workspaceId = `startup-flow-${randomUUID()}`;
    const workspace = demoWorkspace();
    workspace.sources = [];
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
      discoveryScope: "startups",
      status: "running",
      progress: 0,
      message: "Startup flow regression",
      createdAt: now,
      updatedAt: now,
    };
    const connectors = await import("../src/domain/connectors.js");
    const fit = await import("../src/server/fit.js");
    const discovery = vi.spyOn(connectors, "discover").mockResolvedValue([]);
    const read = vi
      .spyOn(connectors, "research")
      .mockImplementation(async (op) => ({
        description: `${op.description}\nPublic website describes TypeScript collaboration tools.`,
        contactEmail: "hello@example.test",
        contactSource: op.companyUrl,
      }));
    const evaluate = vi
      .spyOn(fit, "assessWithAI")
      .mockImplementation(async (op, ws) => {
        const assessment = assessOpportunity(op, ws.profile, ws.preferences);
        return {
          ...assessment,
          unknowns: assessment.unknowns.filter(
            (item) => item !== STARTUP_CONTRIBUTION_UNCONFIRMED,
          ),
          recommendation: "review",
          startupFit: { method: "semantic", status: "potential" },
          relevantEvidenceIds: ["demo-e1"],
          fitSummary:
            "Your TypeScript interface work could help explore this collaboration product. Confirm the team's current needs.",
        };
      });
    const { processRun, analyze } = await import("../src/server/service.js");
    const { researchAndSaveOpportunity, STARTUP_RESEARCH_LIMIT } = await import(
      "../src/server/startup-research.js"
    );
    const candidate = (
      source: Source,
      suffix: string,
      description = "Food service scheduling software",
    ): Opportunity => {
      const companyUrl = `https://${workspaceId}-${suffix}.example.test`;
      return {
        ...demoOpportunities()[3],
        id: randomUUID(),
        isDemo: false,
        title: "A product for team collaboration",
        company: `Company ${suffix}`,
        companyUrl,
        url: companyUrl,
        description,
        source: source.provider,
        sourceId: source.id,
        sourceKey: `${source.provider}:${workspaceId}:${suffix}`,
        publishedAt: source.provider === "seedcamp" ? null : now,
        companyCountry: "Unknown",
        contactName: "",
        contactEmail: "",
        contactSource: "",
      };
    };
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
      discovery,
      read,
      evaluate,
      processRun,
      analyze,
      candidate,
      researchAndSaveOpportunity,
      STARTUP_RESEARCH_LIMIT,
      cleanup,
    };
  }

  it("chooses a bounded research shortlist across sources and evaluates product titles without requiring a role title", async () => {
    const t = await setup();
    t.discovery.mockImplementation(async (source) =>
      source.provider === "hackernews"
        ? Array.from({ length: t.STARTUP_RESEARCH_LIMIT + 1 }, (_, index) =>
            t.candidate(source, `feed-${index}`),
          )
        : [
            t.candidate(
              source,
              "priority",
              "React and TypeScript tools for developer collaboration",
            ),
          ],
    );
    try {
      await t.processRun(t.store, t.run, async () => {});
      expect(t.discovery).toHaveBeenCalledTimes(2);
      expect(t.read).toHaveBeenCalledTimes(t.STARTUP_RESEARCH_LIMIT);
      expect(t.evaluate).toHaveBeenCalledTimes(t.STARTUP_RESEARCH_LIMIT);
      expect(t.read.mock.calls[0][0].company).toBe("Company priority");
      expect(
        t.evaluate.mock.calls.every(
          ([op]) => op.title === "A product for team collaboration",
        ),
      ).toBe(true);
      expect(await t.store.get("runs", t.run.id)).toMatchObject({
        outcome: "success",
        summary: {
          evaluated: t.STARTUP_RESEARCH_LIMIT + 2,
          companiesResearched: t.STARTUP_RESEARCH_LIMIT,
        },
      });
      const saved = await t.store.list("opportunities");
      expect(saved).toHaveLength(t.STARTUP_RESEARCH_LIMIT + 2);
      expect(
        saved.filter((op) => op.assessment?.startupFit?.method === "semantic"),
      ).toHaveLength(t.STARTUP_RESEARCH_LIMIT);
      await t.processRun(t.store, t.run, async () => {});
      expect(t.read).toHaveBeenCalledTimes(t.STARTUP_RESEARCH_LIMIT + 2);
      expect(t.evaluate).toHaveBeenCalledTimes(t.STARTUP_RESEARCH_LIMIT + 2);
      expect(await t.store.get("runs", t.run.id)).toMatchObject({
        summary: { newOpportunities: 0, companiesResearched: 2 },
      });
    } finally {
      await t.cleanup();
    }
  });

  it("reuses website research and semantic contributions without downgrading their metadata", async () => {
    const t = await setup();
    t.discovery.mockImplementation(async (source) =>
      source.provider === "hackernews"
        ? [t.candidate(source, "cached", "TypeScript collaboration software")]
        : [],
    );
    try {
      await t.processRun(t.store, t.run, async () => {});
      await t.processRun(t.store, t.run, async () => {});
      expect(t.read).toHaveBeenCalledOnce();
      expect(t.evaluate).toHaveBeenCalledOnce();
      const [saved] = await t.store.list("opportunities");
      const local = await t.analyze(
        t.store,
        saved,
        await t.store.getWorkspace(),
        false,
        { reuseFit: true },
      );
      expect(local.assessment?.startupFit).toEqual({
        method: "semantic",
        status: "potential",
      });
      expect(local.assessment?.relevantEvidenceIds).toEqual(["demo-e1"]);
      expect(local.assessment?.unknowns).not.toContain(
        STARTUP_CONTRIBUTION_UNCONFIRMED,
      );
      expect(await t.store.get("runs", t.run.id)).toMatchObject({
        summary: {
          companiesResearched: 0,
          newOpportunities: 0,
          existingOpportunities: 1,
        },
      });
    } finally {
      await t.cleanup();
    }
  });

  it("keeps failed website research visible with backoff while still evaluating the directory description", async () => {
    const t = await setup();
    t.discovery.mockImplementation(async (source) =>
      source.provider === "hackernews"
        ? [
            t.candidate(
              source,
              "unavailable",
              "TypeScript collaboration software",
            ),
          ]
        : [],
    );
    t.read.mockRejectedValue(new Error("Website unavailable"));
    try {
      await t.processRun(t.store, t.run, async () => {});
      await t.processRun(t.store, t.run, async () => {});
      expect(t.read).toHaveBeenCalledOnce();
      expect(t.evaluate).toHaveBeenCalledOnce();
      expect(await t.store.get("runs", t.run.id)).toMatchObject({
        outcome: "partial",
        summary: { researchFailures: 1, evaluated: 1 },
      });
      expect(
        (await t.store.list("events")).some(
          (event) =>
            event.category === "research" &&
            event.message.includes("Website unavailable"),
        ),
      ).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("does not cache failed contribution analysis as a successful semantic result", async () => {
    const t = await setup();
    t.discovery.mockImplementation(async (source) =>
      source.provider === "hackernews"
        ? [t.candidate(source, "retry", "TypeScript collaboration software")]
        : [],
    );
    t.evaluate.mockImplementationOnce(async (op, ws) => {
      const assessment = assessOpportunity(op, ws.profile, ws.preferences);
      return {
        ...assessment,
        startupFit: {
          ...assessment.startupFit!,
          failureReason: "Contribution service unavailable",
        },
      };
    });
    try {
      await t.processRun(t.store, t.run, async () => {});
      const [saved] = await t.store.list("opportunities");
      expect(await t.store.runtime(`fit:${saved.id}`)).toBeNull();
      expect(await t.store.get("runs", t.run.id)).toMatchObject({
        outcome: "partial",
        summary: { evaluationFailures: 1 },
      });
      await t.processRun(t.store, t.run, async () => {});
      expect(t.read).toHaveBeenCalledOnce();
      expect(t.evaluate).toHaveBeenCalledTimes(2);
      expect(await t.store.runtime(`fit:${saved.id}`)).not.toBeNull();
    } finally {
      await t.cleanup();
    }
  });

  it("retains explicit research corrections and concurrent archives", async () => {
    const t = await setup();
    try {
      const source: Source = {
        id: "manual-test",
        provider: "hackernews",
        board: "",
        label: "Test",
        enabled: true,
      };
      const imported = await t.store.importOpportunityWithStatus(
        t.candidate(source, "corrected"),
      );
      const op = imported.opportunity;
      await t.store.setRuntime(`corrections:${op.id}`, {
        description: "My corrected company description",
        contactEmail: "verified@example.test",
      });
      const researched = await t.researchAndSaveOpportunity(t.store, op);
      expect(researched.researched).toBe(true);
      expect(researched.opportunity.description).toBe(
        "My corrected company description",
      );
      expect(researched.opportunity.contactEmail).toBe("verified@example.test");

      const current = researched.opportunity;
      t.read.mockImplementationOnce(async () => {
        await t.store.save("opportunities", {
          ...current,
          stage: "archived",
          notes: "Preserve this edit",
          updatedAt: "2030-01-01T00:00:00Z",
        });
        return { description: "A newer website description" };
      });
      const concurrent = await t.researchAndSaveOpportunity(t.store, current, {
        force: true,
      });
      expect(concurrent.researched).toBe(false);
      expect(concurrent.opportunity).toMatchObject({
        stage: "archived",
        notes: "Preserve this edit",
        description: "My corrected company description",
      });
    } finally {
      await t.cleanup();
    }
  });
});
