import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { demoOpportunities, demoWorkspace } from "../src/domain/fixtures.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { assertApproved, assertFresh } from "../src/server/guards.js";
import type { Opportunity } from "../src/shared/types.js";

// Opt in against the configured local Supabase stack; the ordinary test suite stays offline.
const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

function isolatedOpportunity(): Opportunity {
  const id = randomUUID();
  return {
    ...demoOpportunities()[0],
    id,
    company: `Integration sample ${id}`,
    sourceKey: `integration:${id}`,
  };
}

async function cleanup(
  store: typeof import("../src/server/store.js"),
  id: string,
) {
  const errors: string[] = [];
  // Preserve foreign-key ordering and still attempt all cleanup if a deletion fails.
  const draftResult = await store.db
    .from("drafts")
    .delete()
    .eq("opportunity_id", id);
  if (draftResult.error) errors.push(draftResult.error.message);
  const opportunityResult = await store.db
    .from("opportunities")
    .delete()
    .eq("id", id);
  if (opportunityResult.error) errors.push(opportunityResult.error.message);
  const correctionResult = await store.db
    .from("runtime")
    .delete()
    .eq("key", `corrections:${id}`);
  if (correctionResult.error) errors.push(correctionResult.error.message);
  if (errors.length)
    throw new Error(`Integration cleanup failed: ${errors.join("; ")}`);
}

integration("local Supabase source refresh and lifecycle", () => {
  it("refreshes source facts, keeps human corrections, and invalidates stale approvals", async () => {
    const store = await import("../src/server/store.js");
    const workspace = demoWorkspace();
    const op = isolatedOpportunity();
    const originalFirstSeen = op.firstSeenAt;
    try {
      await store.importOpportunity(op);
      const corrections = {
        companyCountry: "United States",
        remoteScope: "worldwide" as const,
        contactName: "Reviewed recipient",
      };
      await store.setRuntime(`corrections:${op.id}`, corrections);
      const corrected = { ...op, ...corrections, stage: "tested" as const };
      await store.save("opportunities", corrected);

      const assessment = assessOpportunity(
        corrected,
        workspace.profile,
        workspace.preferences,
      );
      const approved = createDraft(
        corrected,
        workspace.profile,
        workspace.preferences,
        assessment,
      );
      approved.status = "tested";
      approved.testReceipt = "Previous local simulation";
      await store.save("drafts", approved);
      expect(() =>
        assertApproved(approved, corrected, workspace),
      ).not.toThrow();

      const incoming: Opportunity = {
        ...op,
        id: randomUUID(),
        firstSeenAt: new Date(Date.now() + 1000).toISOString(),
        companyCountry: "Unknown",
        remoteScope: "unknown",
        contactName: "",
        salaryMin: 130000,
        requirements: [
          ...op.requirements,
          {
            id: "new-aws",
            text: "Must have AWS experience",
            skills: ["AWS"],
            essential: true,
            hard: true,
          },
        ],
      };
      const refreshed = await store.importOpportunity(incoming);
      expect(refreshed.id).toBe(op.id);
      expect(refreshed.firstSeenAt).toBe(originalFirstSeen);
      expect(refreshed.salaryMin).toBe(130000);
      expect(refreshed.requirements.at(-1)?.id).toBe("new-aws");
      expect(refreshed).toMatchObject(corrections);
      expect(refreshed.stage).toBe("new");
      expect(refreshed.assessment).toBeNull();
      const invalidated = await store.get("drafts", approved.id);
      expect(invalidated.status).toBe("draft");
      expect(invalidated.testReceipt).toBeNull();
      expect(() => assertFresh(approved, refreshed, workspace)).toThrow(
        /changed/,
      );
      expect(() =>
        assertApproved(
          { ...invalidated, status: "approved" },
          refreshed,
          workspace,
        ),
      ).toThrow(/changed/);

      // Identical reimports do not disturb a newly reviewed draft or the current lifecycle.
      const freshDraft = createDraft(
        refreshed,
        workspace.profile,
        workspace.preferences,
        assessOpportunity(refreshed, workspace.profile, workspace.preferences),
      );
      freshDraft.status = "approved";
      await store.save("drafts", freshDraft);
      await store.save("opportunities", { ...refreshed, stage: "approved" });
      const unchanged = await store.importOpportunity(incoming);
      expect(unchanged.stage).toBe("approved");
      const unchangedDraft = await store.get("drafts", freshDraft.id);
      expect(unchangedDraft.status).toBe("approved");
      expect(() =>
        assertApproved(unchangedDraft, unchanged, workspace),
      ).not.toThrow();
    } finally {
      await cleanup(store, op.id);
    }
  }, 20000);

  it.each(["drafted", "approved", "tested", "archived"] as const)(
    "preserves the %s stage when reassessing current facts",
    async (stage) => {
      const store = await import("../src/server/store.js");
      const { analyze } = await import("../src/server/service.js");
      const workspace = demoWorkspace();
      const op = { ...isolatedOpportunity(), stage };
      try {
        await store.save("opportunities", op);
        const result = await analyze(op, workspace);
        expect(result.stage).toBe(stage);
        expect(result.assessment?.recommendation).toBe("ready");
        expect((await store.get("opportunities", op.id)).stage).toBe(stage);
      } finally {
        await cleanup(store, op.id);
      }
    },
    20000,
  );
});
