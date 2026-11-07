import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSESSMENT_RULES_VERSION,
  assessOpportunity,
  preferencesFingerprint,
} from "../src/domain/rules.js";
import {
  extractRequirements,
  REQUIREMENT_EXTRACTION_VERSION,
  SALARY_EXTRACTION_VERSION,
} from "../src/domain/connectors.js";
import { createDraft } from "../src/domain/templates.js";
import { applicationProgressFor } from "../src/shared/application-board.js";
import type { Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const { db, createWorkspaceStore } = await import("../src/server/store.js");
  const workspaceId = `saved-assessment-${randomUUID()}`;
  const otherWorkspaceId = `saved-assessment-other-${randomUUID()}`;
  const workspace = { ...demoWorkspace(), sources: [] };
  const inserted = await db.from("workspace").insert([
    { id: workspaceId, payload: workspace },
    { id: otherWorkspaceId, payload: workspace },
  ]);
  if (inserted.error) throw inserted.error;
  const store = createWorkspaceStore({ workspaceId, client: db });
  const otherStore = createWorkspaceStore({
    workspaceId: otherWorkspaceId,
    client: db,
  });
  const cleanup = async () => {
    for (const table of [
      "drafts",
      "runs",
      "events",
      "opportunities",
      "workspace_runtime",
    ]) {
      const result = await db
        .from(table)
        .delete()
        .in("workspace_id", [workspaceId, otherWorkspaceId]);
      if (result.error) throw result.error;
    }
    const removed = await db
      .from("workspace")
      .delete()
      .in("id", [workspaceId, otherWorkspaceId]);
    if (removed.error) throw removed.error;
  };
  return { store, otherStore, workspace: await store.getWorkspace(), cleanup };
}

function job(): Opportunity {
  const id = randomUUID();
  return {
    ...demoOpportunities()[0],
    id,
    sourceKey: `saved-assessment:${id}`,
    isDemo: false,
  };
}

integration("saved assessment refresh", () => {
  it("persists a missing published salary once while retaining semantic evidence and manual corrections", async () => {
    const t = await setup();
    const fit = await import("../src/server/fit.js");
    const ai = vi
      .spyOn(fit, "assessWithAI")
      .mockRejectedValue(new Error("Salary recovery must not call AI."));
    const { bootstrap } = await import("../src/server/service.js");
    const op = job();
    Object.assign(op, {
      requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
      title: "Experienced Software Engineer",
      description: "Salary range: $70,000-$170,000 USD.",
      salaryMin: null,
      salaryMax: null,
      stage: "approved",
      application: applicationProgressFor(op, "interview"),
    });
    const matches = assessOpportunity(
      op,
      t.workspace.profile,
      t.workspace.preferences,
    ).matches;
    op.assessment = {
      ...assessOpportunity(
        op,
        t.workspace.profile,
        t.workspace.preferences,
        new Date(),
        matches,
      ),
      fitSummary: "Confirm the undisclosed salary.",
    };
    const corrected = {
      ...op,
      id: randomUUID(),
      sourceKey: `saved-assessment:${randomUUID()}`,
    };
    try {
      await t.store.save("opportunities", op);
      await t.store.save("opportunities", corrected);
      await t.store.setRuntime(`corrections:${corrected.id}`, {
        salaryMin: null,
        salaryMax: null,
      });
      await bootstrap(t.store);
      const saved = await t.store.get("opportunities", op.id);
      expect(saved).toMatchObject({
        salaryMin: 70000,
        salaryMax: 170000,
        salaryCurrency: "USD",
        salaryPeriod: "unknown",
        salaryVersion: SALARY_EXTRACTION_VERSION,
        stage: "approved",
        application: op.application,
      });
      expect(saved.assessment?.unknowns).not.toContain(
        "Salary is undisclosed.",
      );
      expect(saved.assessment?.fitSummary).toBeUndefined();
      expect(saved.assessment?.matches).toEqual(matches);
      expect(saved.assessment?.fitEvaluation?.method).toBe("semantic");
      expect(await t.store.get("opportunities", corrected.id)).toMatchObject({
        salaryMin: null,
        salaryMax: null,
      });
      const save = vi.spyOn(t.store, "saveDerivedOpportunity");
      await bootstrap(t.store);
      expect(save).not.toHaveBeenCalled();
      expect(ai).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  it("repairs automatic requirements once, preserves manual corrections and application/draft history, and discards incompatible semantic results", async () => {
    const t = await setup();
    const fit = await import("../src/server/fit.js");
    const ai = vi
      .spyOn(fit, "assessWithAI")
      .mockRejectedValue(new Error("Bootstrap must not call AI."));
    const { bootstrap } = await import("../src/server/service.js");
    const automatic = job();
    automatic.description =
      "<h2>Requirements</h2><ul><li>Experience developing TypeScript applications.</li><li>Experience building React interfaces.</li></ul><h2>Equal opportunity</h2><p>We welcome candidates regardless of age or disability.</p>";
    automatic.requirements = [
      {
        id: "bad-heading",
        text: "Equal opportunity",
        essential: true,
        hard: false,
        skills: [],
      },
    ];
    automatic.assessment = {
      ...assessOpportunity(
        automatic,
        t.workspace.profile,
        t.workspace.preferences,
      ),
      fitSummary:
        "This obsolete summary must not survive different requirements.",
    };
    automatic.stage = "approved";
    automatic.notes = "Keep my original research.";
    automatic.application = {
      ...applicationProgressFor(automatic, "interview"),
      notes: "Interview on Tuesday",
      nextAction: "Prepare examples",
    };
    const draft = createDraft(
      automatic,
      t.workspace.profile,
      t.workspace.preferences,
      automatic.assessment,
    );
    draft.status = "approved";
    const corrected = job();
    corrected.requirements = [
      {
        id: "human",
        text: "Build TypeScript applications",
        skills: ["TypeScript"],
        essential: true,
        hard: false,
      },
    ];
    const emptyCorrection = job();
    emptyCorrection.requirements = [];
    const manual = job();
    manual.source = "Manual entry";
    manual.sourceKey = `manual:${manual.id}`;
    const unchanged = job();
    unchanged.requirements = extractRequirements(unchanged.description);
    unchanged.assessment = {
      ...assessOpportunity(
        unchanged,
        t.workspace.profile,
        t.workspace.preferences,
      ),
      fitSummary: "Keep this evidence-based comparison.",
      learningGaps: ["Confirm exact framework version."],
      rulesVersion: 0,
    };
    try {
      for (const op of [
        automatic,
        corrected,
        emptyCorrection,
        manual,
        unchanged,
      ])
        await t.store.save("opportunities", op);
      await t.store.save("drafts", draft);
      await t.store.setRuntime(`corrections:${corrected.id}`, {
        requirements: corrected.requirements,
      });
      await t.store.setRuntime(`corrections:${emptyCorrection.id}`, {
        requirements: [],
      });
      await t.otherStore.setRuntime(`corrections:${automatic.id}`, {
        requirements: corrected.requirements,
      });
      const save = vi.spyOn(t.store, "saveDerivedOpportunity");
      const result = await bootstrap(t.store);
      const repaired = result.opportunities.find(
        (op) => op.id === automatic.id,
      )!;
      expect(repaired.requirements).toEqual(
        extractRequirements(automatic.description),
      );
      expect(repaired.requirements.length).toBeGreaterThan(0);
      expect(repaired.requirements.map((r) => r.text).join(" ")).not.toMatch(
        /Equal opportunity|disability/i,
      );
      expect(repaired.assessment?.fitSummary).toBeUndefined();
      expect(repaired.assessment?.fitEvaluation?.method).not.toBe("semantic");
      expect(repaired.stage).toBe("approved");
      expect(repaired.application).toEqual(automatic.application);
      expect(repaired.notes).toBe(automatic.notes);
      expect(await t.store.get("drafts", draft.id)).toEqual(draft);
      for (const original of [corrected, emptyCorrection, manual])
        expect(
          result.opportunities.find((op) => op.id === original.id)
            ?.requirements,
        ).toEqual(original.requirements);
      const retained = result.opportunities.find(
        (op) => op.id === unchanged.id,
      )!;
      expect(retained.assessment?.fitSummary).toBe(
        unchanged.assessment.fitSummary,
      );
      expect(retained.assessment?.matches).toEqual(
        unchanged.assessment.matches,
      );
      expect(retained.assessment?.learningGaps).toEqual(
        unchanged.assessment.learningGaps,
      );
      for (const op of result.opportunities) {
        expect(op.requirementsVersion).toBe(REQUIREMENT_EXTRACTION_VERSION);
        expect(op.assessment?.rulesVersion).toBe(ASSESSMENT_RULES_VERSION);
        expect(op.assessment?.preferencesFingerprint).toBe(
          preferencesFingerprint(t.workspace.preferences),
        );
      }
      expect(ai).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(5);
      save.mockClear();
      await bootstrap(t.store);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  it("refreshes stale preferences without treating old skill-tag results as semantic fit", async () => {
    const t = await setup();
    const { bootstrap } = await import("../src/server/service.js");
    const op = job();
    op.requirementsVersion = REQUIREMENT_EXTRACTION_VERSION;
    op.location = "Remote Brazil only";
    op.description = "A Brazil-only remote position.";
    const oldPreferences = { ...t.workspace.preferences, country: "Brazil" };
    op.assessment = assessOpportunity(op, t.workspace.profile, oldPreferences);
    // The schema existed before preferences fingerprints and fit provenance.
    delete op.assessment.preferencesFingerprint;
    delete op.assessment.fitEvaluation;
    try {
      await t.store.save("opportunities", op);
      const state = await bootstrap(t.store);
      const assessment = state.opportunities[0].assessment!;
      expect(assessment.geography).toMatchObject({
        status: "excluded",
        workingCountry: "Ecuador",
      });
      expect(assessment.preferencesFingerprint).toBe(
        preferencesFingerprint(t.workspace.preferences),
      );
      expect(assessment.fitEvaluation?.method).not.toBe("semantic");
      expect(assessment.fitSummary).toBeUndefined();
      const save = vi.spyOn(t.store, "saveDerivedOpportunity");
      await bootstrap(t.store);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  it("rechecks the entire collection when preferences change during a rollout", async () => {
    const t = await setup();
    const { bootstrap } = await import("../src/server/service.js");
    const previousWorkspace = {
      ...t.workspace,
      preferences: { ...t.workspace.preferences, country: "Brazil" },
    };
    const jobs = [job(), job()].map((op) => {
      op.requirementsVersion = REQUIREMENT_EXTRACTION_VERSION;
      op.location = "Remote Brazil only";
      op.description = "A Brazil-only remote position.";
      op.assessment = assessOpportunity(
        op,
        previousWorkspace.profile,
        previousWorkspace.preferences,
      );
      return op;
    });
    jobs[0].assessment!.rulesVersion = 0;
    try {
      for (const op of jobs) await t.store.save("opportunities", op);
      vi.spyOn(t.store, "getWorkspace").mockResolvedValueOnce(
        previousWorkspace,
      );
      const state = await bootstrap(t.store);
      expect(state.preferences.country).toBe("Ecuador");
      for (const op of state.opportunities) {
        expect(op.assessment?.geography).toMatchObject({
          status: "excluded",
          workingCountry: "Ecuador",
        });
        expect(op.assessment?.preferencesFingerprint).toBe(
          preferencesFingerprint(t.workspace.preferences),
        );
      }
    } finally {
      await t.cleanup();
    }
  });

  it("preserves valid semantic fit on preference saves and invalidates it when the profile changes", async () => {
    const t = await setup();
    const { refreshAssessments } = await import("../src/server/service.js");
    const fit = await import("../src/server/fit.js");
    const ai = vi
      .spyOn(fit, "assessWithAI")
      .mockRejectedValue(new Error("Preference refresh must not request AI."));
    const op = job();
    op.requirementsVersion = REQUIREMENT_EXTRACTION_VERSION;
    op.location = "Remote LATAM";
    op.remoteScope = "latam";
    op.description = "Build developer software remotely within Latin America.";
    const semanticMatches = assessOpportunity(
      op,
      t.workspace.profile,
      t.workspace.preferences,
    ).matches.map((match) => ({
      ...match,
      explanation: "Verified experience demonstrates this work in context.",
    }));
    op.assessment = {
      ...assessOpportunity(
        op,
        t.workspace.profile,
        t.workspace.preferences,
        new Date(),
        semanticMatches,
      ),
      fitSummary:
        "Strong product engineering experience and eligibility to work from Ecuador.",
      learningGaps: ["Confirm the team's deployment tools."],
      relevantEvidenceIds: ["demo-e1", "demo-e2"],
    };
    op.application = {
      ...applicationProgressFor(op, "applied"),
      notes: "Already submitted",
    };
    op.stage = "approved";
    try {
      await t.store.save("opportunities", op);
      const preferences = { ...t.workspace.preferences, country: "Germany" };
      await t.store.updateWorkspace({ preferences });
      await refreshAssessments(t.store);
      const refreshed = await t.store.get("opportunities", op.id);
      expect(refreshed.assessment?.geography).toMatchObject({
        status: "excluded",
        workingCountry: "Germany",
      });
      expect(refreshed.assessment?.preferencesFingerprint).toBe(
        preferencesFingerprint(preferences),
      );
      expect(refreshed.assessment?.matches).toEqual(semanticMatches);
      expect(refreshed.assessment?.fitSummary).toBeUndefined();
      expect(refreshed.assessment?.essentialScore).toBe(
        op.assessment.essentialScore,
      );
      expect(refreshed.assessment?.relevantEvidenceIds).toEqual(
        op.assessment.relevantEvidenceIds,
      );
      expect(refreshed.assessment?.learningGaps).toEqual(
        op.assessment.learningGaps,
      );
      expect(refreshed.assessment?.fitEvaluation?.method).toBe("semantic");
      expect(refreshed.application).toEqual(op.application);
      expect(refreshed.stage).toBe("approved");
      const save = vi.spyOn(t.store, "saveDerivedOpportunity");
      await refreshAssessments(t.store);
      expect(save).not.toHaveBeenCalled();
      const profile = structuredClone(t.workspace.profile);
      if (!profile.cache?.facts)
        throw new Error("Fixture evidence is required.");
      profile.cache.facts.evidence = [];
      await t.store.updateWorkspace({ profile });
      await refreshAssessments(t.store);
      const changedProfile = await t.store.get("opportunities", op.id);
      expect(changedProfile.assessment?.fitSummary).toBeUndefined();
      expect(changedProfile.assessment?.fitEvaluation?.method).not.toBe(
        "semantic",
      );
      expect(changedProfile.assessment?.matches).not.toEqual(semanticMatches);
      expect(ai).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  it("drops legacy summaries with unknown preference context while preserving semantic evidence", async () => {
    const t = await setup();
    const { refreshAssessments } = await import("../src/server/service.js");
    const op = job();
    op.requirementsVersion = REQUIREMENT_EXTRACTION_VERSION;
    const matches = assessOpportunity(
      op,
      t.workspace.profile,
      t.workspace.preferences,
    ).matches;
    op.assessment = {
      ...assessOpportunity(
        op,
        t.workspace.profile,
        t.workspace.preferences,
        new Date(),
        matches,
      ),
      fitSummary:
        "An old summary whose country and salary context were not recorded.",
    };
    delete op.assessment.preferencesFingerprint;
    try {
      await t.store.save("opportunities", op);
      await refreshAssessments(t.store);
      const refreshed = await t.store.get("opportunities", op.id);
      expect(refreshed.assessment?.fitSummary).toBeUndefined();
      expect(refreshed.assessment?.matches).toEqual(matches);
      expect(refreshed.assessment?.essentialScore).toBe(
        op.assessment.essentialScore,
      );
      expect(refreshed.assessment?.fitEvaluation?.method).toBe("semantic");
    } finally {
      await t.cleanup();
    }
  });

  it("does not overwrite concurrent edits, recreate deleted rows, or cross workspace boundaries", async () => {
    const t = await setup();
    const op = job();
    try {
      await t.store.save("opportunities", op);
      const edited = await t.store.save("opportunities", {
        ...op,
        updatedAt: "2030-01-01T00:00:00.000Z",
        stage: "archived",
        notes: "Keep this concurrent edit",
        application: applicationProgressFor(op, "applied"),
      });
      const derived = {
        ...op,
        requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
        assessment: assessOpportunity(
          op,
          t.workspace.profile,
          t.workspace.preferences,
        ),
      };
      expect(await t.store.saveDerivedOpportunity(op, derived)).toEqual(edited);
      expect(await t.otherStore.saveDerivedOpportunity(op, derived)).toBeNull();
      expect(await t.otherStore.listAllOpportunities()).toEqual([]);
      const removed = await t.store.db
        .from("opportunities")
        .delete()
        .eq("workspace_id", t.store.workspaceId)
        .eq("id", op.id);
      expect(removed.error).toBeNull();
      expect(await t.store.saveDerivedOpportunity(op, derived)).toBeNull();
      expect(await t.store.listAllOpportunities()).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
