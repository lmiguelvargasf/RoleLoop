import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import {
  ASSESSMENT_RULES_VERSION,
  assessOpportunity,
  opportunityFingerprint,
  preferencesFingerprint,
  profileFingerprint,
} from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import type { Opportunity, Run, Source } from "../src/shared/types.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
afterEach(() => vi.restoreAllMocks());

async function setup(sources: Source[] = []) {
  const { db, createWorkspaceStore } = await import("../src/server/store.js");
  const workspaceId = `geography-rollout-${randomUUID()}`;
  const workspace = demoWorkspace();
  workspace.sources = sources;
  workspace.preferences.discoverEmployers = false;
  const inserted = await db.from("workspace").insert({
    id: workspaceId,
    payload: workspace,
  });
  if (inserted.error) throw inserted.error;
  const store = createWorkspaceStore({ workspaceId, client: db });
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
        .eq("workspace_id", workspaceId);
      if (result.error) throw result.error;
    }
    const removed = await db.from("workspace").delete().eq("id", workspaceId);
    if (removed.error) throw removed.error;
  };
  return { store, workspace: await store.getWorkspace(), workspaceId, cleanup };
}

function restrictedOpportunity(): Opportunity {
  const id = randomUUID();
  return {
    ...demoOpportunities()[0],
    id,
    isDemo: false,
    sourceKey: `geography:${id}`,
    remoteScope: "worldwide",
    location: "Remote LATAM",
    description: "Remote worldwide. This role is Brazil-only.",
  };
}

integration("geography rules rollout", () => {
  it("repairs malformed current-version geography in bounded batches while retaining career fit", async () => {
    const t = await setup();
    const fit = await import("../src/server/fit.js");
    const ai = vi
      .spyOn(fit, "assessWithAI")
      .mockRejectedValue(
        new Error("Derived location repair must not call AI."),
      );
    const { bootstrap } = await import("../src/server/service.js");
    const jobs = Array.from({ length: 12 }, (_, index) => {
      const op = restrictedOpportunity();
      const assessment = assessOpportunity(
        op,
        t.workspace.profile,
        t.workspace.preferences,
      );
      return {
        ...op,
        notes: `Keep note ${index}`,
        assessment: {
          ...assessment,
          recommendation: "ready" as const,
          blockers: [],
          unknowns: [],
          fitSummary: `Retain semantic fit ${index}`,
          learningGaps: ["Confirm a tooling example."],
          relevantEvidenceIds: assessment.matches[0].evidenceIds,
        },
        application: {
          status: "applied" as const,
          appliedAt: new Date().toISOString(),
          notes: `Application history ${index}`,
          nextAction: "Follow up",
          followUpOn: null,
        },
      };
    });
    try {
      for (const op of jobs) {
        await t.store.save("opportunities", op);
        // Reproduce a live-reload write that retained the rule version and
        // geography metadata but omitted the new derived status field.
        const { status: _status, ...brokenGeography } =
          op.assessment.geography!;
        const updated = await t.store.db
          .from("opportunities")
          .update({
            payload: {
              ...op,
              assessment: { ...op.assessment, geography: brokenGeography },
            },
          })
          .eq("workspace_id", t.workspaceId)
          .eq("id", op.id);
        expect(updated.error).toBeNull();
      }
      const readWorkspace = t.store.getWorkspace.bind(t.store);
      let active = 0;
      let peak = 0;
      const reads = vi
        .spyOn(t.store, "getWorkspace")
        .mockImplementation(async () => {
          active++;
          peak = Math.max(peak, active);
          try {
            return await readWorkspace();
          } finally {
            active--;
          }
        });
      const state = await bootstrap(t.store);
      expect(state.opportunities).toHaveLength(jobs.length);
      expect(peak).toBeLessThanOrEqual(4);
      expect(reads).toHaveBeenCalledTimes(jobs.length + 1);
      expect(ai).not.toHaveBeenCalled();
      for (const original of jobs) {
        const repaired = state.opportunities.find(
          (op) => op.id === original.id,
        )!;
        expect(repaired.assessment).toMatchObject({
          rulesVersion: ASSESSMENT_RULES_VERSION,
          geography: { status: "excluded", workingCountry: "Ecuador" },
          recommendation: "excluded",
          fitSummary: original.assessment.fitSummary,
          learningGaps: original.assessment.learningGaps,
          relevantEvidenceIds: original.assessment.relevantEvidenceIds,
          matches: original.assessment.matches,
        });
        expect(repaired.notes).toBe(original.notes);
        expect(repaired.application).toEqual(original.application);
        const persisted = await t.store.get("opportunities", original.id);
        expect(persisted.assessment?.geography?.status).toBe("excluded");
      }
      reads.mockClear();
      await bootstrap(t.store);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      await t.cleanup();
    }
  });

  it("upgrades stored assessments without losing semantic fit, applications or draft content", async () => {
    const t = await setup();
    const fit = await import("../src/server/fit.js");
    const ai = vi
      .spyOn(fit, "assessWithAI")
      .mockRejectedValue(
        new Error("A rule upgrade must not request AI assessment."),
      );
    const { bootstrap } = await import("../src/server/service.js");
    const op = restrictedOpportunity();
    const assessed = assessOpportunity(
      op,
      t.workspace.profile,
      t.workspace.preferences,
    );
    const semanticMatches = assessed.matches.map((match, index) =>
      index === 0
        ? {
            ...match,
            status: "partial" as const,
            explanation:
              "Transferable experience; direct product work needs review.",
          }
        : match,
    );
    op.assessment = {
      ...assessed,
      rulesVersion: 0,
      recommendation: "ready",
      blockers: [],
      unknowns: [],
      matches: semanticMatches,
      fitSummary: "Existing evidence-based fit summary.",
      learningGaps: ["A small tooling gap."],
      relevantEvidenceIds: semanticMatches[0].evidenceIds,
    };
    op.stage = "approved";
    op.application = {
      status: "applied",
      appliedAt: new Date().toISOString(),
      notes: "Already sent through the employer portal.",
      nextAction: "Follow up",
      followUpOn: null,
    };
    const draft = createDraft(
      op,
      t.workspace.profile,
      t.workspace.preferences,
      op.assessment,
    );
    draft.status = "approved";
    try {
      await t.store.save("opportunities", op);
      await t.store.save("drafts", draft);
      // Legacy JSON has no version at all, as in an existing database.
      const { rulesVersion: _version, ...legacyAssessment } = op.assessment;
      const legacy = await t.store.db
        .from("opportunities")
        .update({ payload: { ...op, assessment: legacyAssessment } })
        .eq("workspace_id", t.workspaceId)
        .eq("id", op.id);
      expect(legacy.error).toBeNull();

      const state = await bootstrap(t.store);
      const upgraded = state.opportunities.find((item) => item.id === op.id)!;
      expect(upgraded.assessment?.rulesVersion).toBe(ASSESSMENT_RULES_VERSION);
      expect(upgraded.assessment?.recommendation).toBe("excluded");
      expect(upgraded.assessment?.blockers.join(" ")).toMatch(/Brazil/i);
      expect(upgraded.assessment?.matches).toEqual(semanticMatches);
      expect(upgraded.assessment?.fitSummary).toBe(op.assessment.fitSummary);
      expect(upgraded.assessment?.learningGaps).toEqual(
        op.assessment.learningGaps,
      );
      expect(upgraded.assessment?.relevantEvidenceIds).toEqual(
        op.assessment.relevantEvidenceIds,
      );
      expect(upgraded.application).toEqual(op.application);
      const savedDraft = await t.store.get("drafts", draft.id);
      expect(savedDraft).toMatchObject({
        subject: draft.subject,
        body: draft.body,
        resume: draft.resume,
        coverLetter: draft.coverLetter,
        answers: draft.answers,
        contentHash: draft.contentHash,
      });
      expect(ai).not.toHaveBeenCalled();
      const persisted = await t.store.get("opportunities", op.id);
      expect(persisted.assessment?.rulesVersion).toBe(ASSESSMENT_RULES_VERSION);
      const evaluatedAt = persisted.assessment?.evaluatedAt;
      await bootstrap(t.store);
      expect(
        (await t.store.get("opportunities", op.id)).assessment?.evaluatedAt,
      ).toBe(evaluatedAt);
    } finally {
      await t.cleanup();
    }
  });

  it("does not reuse a recent AI fit cache from the previous geography rules", async () => {
    const source: Source = {
      id: "geo-employer",
      label: "Geography employer",
      provider: "ashby",
      board: "geography-employer",
      enabled: true,
    };
    const t = await setup([source]);
    const connectors = await import("../src/domain/connectors.js");
    const fit = await import("../src/server/fit.js");
    const ai = vi
      .spyOn(fit, "assessWithAI")
      .mockRejectedValue(
        new Error("An excluded job must not request AI assessment."),
      );
    const { processRun } = await import("../src/server/service.js");
    const op = {
      ...restrictedOpportunity(),
      company: source.label,
      source: "ashby",
      sourceId: source.id,
      sourceKey: "ashby:geography-employer:one",
      url: "https://jobs.ashbyhq.com/geography-employer/one",
    };
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      workspaceId: t.workspaceId,
      action: "discover",
      discoveryScope: "jobs",
      status: "running",
      progress: 0,
      message: "Isolated geography rollout test",
      createdAt: now,
      updatedAt: now,
    };
    try {
      const imported = await t.store.importOpportunity(op);
      const assessment = assessOpportunity(
        imported,
        t.workspace.profile,
        t.workspace.preferences,
      );
      const legacy = await t.store.save("opportunities", {
        ...imported,
        assessment: {
          ...assessment,
          rulesVersion: 0,
          recommendation: "ready",
          blockers: [],
          unknowns: [],
          fitSummary: "Previously cached fit.",
        },
      });
      await t.store.setRuntime(`fit:${legacy.id}`, {
        fingerprint: `${opportunityFingerprint(legacy)}:${profileFingerprint(t.workspace.profile)}:${preferencesFingerprint(t.workspace.preferences)}:api`,
        at: Date.now(),
      });
      vi.spyOn(connectors, "discover").mockResolvedValue([op]);
      await processRun(t.store, run, async () => {});
      const updated = await t.store.get("opportunities", legacy.id);
      expect(updated.assessment?.rulesVersion).toBe(ASSESSMENT_RULES_VERSION);
      expect(updated.assessment?.recommendation).toBe("excluded");
      expect(updated.assessment?.blockers.join(" ")).toMatch(/Brazil/i);
      expect(ai).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });
});
