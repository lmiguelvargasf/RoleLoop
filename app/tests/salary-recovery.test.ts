import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { bootstrap } from "../src/server/service.js";
import { assessOpportunity } from "../src/domain/rules.js";
import {
  REQUIREMENT_EXTRACTION_VERSION,
  SALARY_EXTRACTION_VERSION,
} from "../src/domain/connectors.js";
import type { Opportunity } from "../src/shared/types.js";
import type { WorkspaceStore } from "../src/server/store.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/store.js", () => ({
  getGlobalRuntime: vi.fn(async () => null),
  setGlobalRuntime: vi.fn(),
}));
vi.mock("../src/server/fit.js", () => ({
  assessWithAI: vi.fn(() => {
    throw new Error("Salary recovery must not call AI.");
  }),
  FIT_PROMPT_VERSION: 1,
}));

function setup() {
  const workspace = demoWorkspace();
  const records = new Map<string, Opportunity>();
  const corrections = new Map<string, Partial<Opportunity>>();
  const save = vi.fn(async (original: Opportunity, next: Opportunity) => {
    records.set(original.id, structuredClone(next));
    return next;
  });
  const store = {
    workspaceId: randomUUID(),
    getWorkspace: async () => workspace,
    listAllOpportunities: async () => [...records.values()],
    list: async () => [],
    runtime: async () => null,
    runtimeMany: async (keys: string[]) =>
      new Map([...corrections].filter(([key]) => keys.includes(key))),
    saveDerivedOpportunity: save,
  } as unknown as WorkspaceStore;
  function job(patch: Partial<Opportunity> = {}) {
    const id = randomUUID();
    const op: Opportunity = {
      ...demoOpportunities()[0],
      id,
      source: "greenhouse",
      sourceKey: `greenhouse:employer:${id}`,
      isDemo: false,
      title: "Experienced Software Engineer",
      description: "Salary range: $70,000-$170,000 USD.",
      salaryMin: null,
      salaryMax: null,
      requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
      ...patch,
    };
    op.assessment = {
      ...assessOpportunity(op, workspace.profile, workspace.preferences),
      fitSummary:
        "Salary is undisclosed; confirm compensation before applying.",
      learningGaps: ["Confirm compensation."],
    };
    records.set(id, op);
    return op;
  }
  return { store, records, corrections, save, job };
}

describe("saved salary recovery", () => {
  it("fills existing jobs on load, clears obsolete policy prose, and preserves application history", async () => {
    const t = setup();
    const op = t.job({ stage: "approved", notes: "Keep my research." });
    op.assessment!.fitEvaluation = {
      ...op.assessment!.fitEvaluation!,
      method: "semantic",
    };
    op.assessment!.matches = op.assessment!.matches.map((match) => ({
      ...match,
      explanation: "Demonstrated this work in the cited project.",
    }));
    op.application = {
      status: "interview",
      appliedAt: "2026-11-02T00:00:00Z",
      interviewAt: "2026-11-03T00:00:00Z",
      offerAt: null,
      nextAction: "Prepare examples",
      followUpOn: null,
      notes: "Interview scheduled",
    };
    const result = (await bootstrap(t.store)).opportunities[0];
    expect(result).toMatchObject({
      salaryMin: 70000,
      salaryMax: 170000,
      salaryCurrency: "USD",
      salaryPeriod: "unknown",
      salaryVersion: SALARY_EXTRACTION_VERSION,
      stage: "approved",
      notes: op.notes,
      application: op.application,
    });
    expect(result.assessment?.unknowns).not.toContain("Salary is undisclosed.");
    expect(result.assessment?.unknowns.join(" ")).toMatch(/pay-period/);
    expect(result.assessment?.fitSummary).toBeUndefined();
    expect(result.assessment?.learningGaps).toBeUndefined();
    expect(result.assessment?.matches).toEqual(op.assessment?.matches);
    expect(result.assessment?.fitEvaluation?.method).toBe("semantic");
    t.save.mockClear();
    await bootstrap(t.store);
    expect(t.save).not.toHaveBeenCalled();
  });

  it("preserves corrections, entered values, manual jobs, and demo jobs", async () => {
    const t = setup();
    const corrected = [
      "salaryMin",
      "salaryMax",
      "salaryCurrency",
      "salaryPeriod",
    ].map((key) => {
      const op = t.job();
      t.corrections.set(`corrections:${op.id}`, {
        [key]: op[key as keyof Opportunity],
      });
      return op;
    });
    const entered = t.job({ salaryMin: 90000, salaryMax: null });
    const manual = t.job({ source: "Manual entry", sourceKey: "manual:job" });
    const demo = t.job({ isDemo: true });
    const result = await bootstrap(t.store);
    for (const original of [...corrected, entered, manual, demo]) {
      const current = result.opportunities.find((op) => op.id === original.id)!;
      expect(current.salaryMin).toBe(original.salaryMin);
      expect(current.salaryMax).toBe(original.salaryMax);
      expect(current.assessment).toEqual(original.assessment);
    }
  });

  it("retains legacy semantic evidence even without fit provenance metadata", async () => {
    const t = setup();
    const op = t.job();
    delete op.assessment!.fitEvaluation;
    op.assessment!.matches = op.assessment!.matches.map((match) => ({
      ...match,
      explanation: "An older semantic comparison with verified evidence.",
    }));
    const result = (await bootstrap(t.store)).opportunities[0];
    expect(result.assessment?.matches).toEqual(op.assessment?.matches);
    expect(result.assessment?.fitSummary).toBeUndefined();
    expect(result.assessment?.fitEvaluation?.method).toBe("semantic");
  });

  it("checks ambiguous and missing salary once without inventing amounts", async () => {
    const t = setup();
    t.job({ description: "Salary: $90,000–$120,000 per year." });
    t.job({ description: "Salary depends on experience." });
    const result = await bootstrap(t.store);
    for (const op of result.opportunities) {
      expect(op.salaryMin).toBeNull();
      expect(op.salaryMax).toBeNull();
      expect(op.salaryVersion).toBe(SALARY_EXTRACTION_VERSION);
    }
    expect(t.save).toHaveBeenCalledTimes(2);
    t.save.mockClear();
    await bootstrap(t.store);
    expect(t.save).not.toHaveBeenCalled();
  });
});
