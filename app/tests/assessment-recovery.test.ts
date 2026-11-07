import { describe, expect, it } from "vitest";
import { AssessmentSchema, JobGeographySchema } from "../src/shared/types.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { isPotentialJobMatch } from "../src/shared/job-matches.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

describe("incomplete saved geography recovery", () => {
  it.each([
    { workingCountry: "Ecuador", reasons: [] },
    { status: "unknown", workingCountry: "Ecuador", reasons: [] },
    null,
  ])(
    "loads incomplete derived data as unevaluated, never eligible: %j",
    (geography) => {
      const workspace = demoWorkspace();
      const job = demoOpportunities()[0];
      const assessment = assessOpportunity(
        job,
        workspace.profile,
        workspace.preferences,
      );
      const recovered = AssessmentSchema.parse({ ...assessment, geography });
      expect(recovered.geography).toBeUndefined();
      expect(recovered.matches).toEqual(assessment.matches);
      expect(recovered.rulesVersion).toBe(assessment.rulesVersion);
      expect(
        isPotentialJobMatch(
          { ...job, assessment: recovered },
          workspace.preferences,
        ),
      ).toBe(false);
      expect(() => JobGeographySchema.parse(geography)).toThrow();
    },
  );

  it("retains complete current geography", () => {
    const workspace = demoWorkspace();
    const assessment = assessOpportunity(
      demoOpportunities()[0],
      workspace.profile,
      workspace.preferences,
    );
    expect(AssessmentSchema.parse(assessment).geography).toEqual(
      assessment.geography,
    );
  });

  it("continues rejecting invalid core assessment data", () => {
    expect(() =>
      AssessmentSchema.parse({ score: "invalid", geography: {} }),
    ).toThrow();
  });
});
