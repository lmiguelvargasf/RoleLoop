import { describe, expect, it } from "vitest";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { assertApproved, assertFresh } from "../src/server/guards.js";

describe("geography checks on existing drafts", () => {
  it.each([
    "Remote LATAM. This role is Brazil-only.",
    "Remote worldwide. This role is US-only.",
  ])("blocks an unchanged previously approved draft for %s", (description) => {
    const workspace = demoWorkspace();
    const opportunity = {
      ...demoOpportunities()[0],
      description,
      remoteScope: "worldwide" as const,
      location: "Remote worldwide",
    };
    // Reproduce the approval made before the country restriction was detected:
    // the posting, preferences and draft fingerprints still match exactly.
    const legacyAssessment = {
      ...assessOpportunity(
        opportunity,
        workspace.profile,
        workspace.preferences,
      ),
      rulesVersion: 0,
      recommendation: "ready" as const,
      blockers: [],
      unknowns: [],
    };
    const draft = createDraft(
      opportunity,
      workspace.profile,
      workspace.preferences,
      legacyAssessment,
    );
    draft.status = "approved";
    for (const guard of [assertFresh, assertApproved]) {
      expect(() => guard(draft, opportunity, workspace)).toThrow(
        /Resolve the location restriction before approving or testing:/,
      );
      try {
        guard(draft, opportunity, workspace);
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 409 });
      }
    }
  });

  it("preserves approval for an unchanged eligible LATAM role", () => {
    const workspace = demoWorkspace();
    const opportunity = {
      ...demoOpportunities()[0],
      description: "Remote LATAM role. Candidates based in Ecuador may apply.",
      remoteScope: "latam" as const,
      location: "Remote LATAM",
    };
    const draft = createDraft(
      opportunity,
      workspace.profile,
      workspace.preferences,
      assessOpportunity(opportunity, workspace.profile, workspace.preferences),
    );
    draft.status = "approved";
    expect(() => assertApproved(draft, opportunity, workspace)).not.toThrow();
  });
});
