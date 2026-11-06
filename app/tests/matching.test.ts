import { describe, expect, it } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import { PreferencesSchema } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const now = new Date("2026-11-05T17:00:00Z");
function setup() {
  return { ...demoWorkspace(), job: demoOpportunities(now)[0] };
}

describe("required qualifications as the matching minimum", () => {
  it("keeps a job ready when required qualifications match but preferred skills do not", () => {
    const { job, profile, preferences } = setup();
    job.requirements[2].skills = ["AWS"];
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.essentialScore).toBe(100);
    expect(result.score).toBe(80);
    expect(result.recommendation).toBe("ready");
  });

  it("uses preferred skills for priority without changing readiness", () => {
    const { job, profile, preferences } = setup();
    const supported = assessOpportunity(job, profile, preferences, now);
    job.requirements[2].skills = ["AWS"];
    const unsupported = assessOpportunity(job, profile, preferences, now);
    expect(supported.score).toBeGreaterThan(unsupported.score);
    expect(supported.recommendation).toBe(unsupported.recommendation);
  });

  it("lets the user allow gaps while keeping mandatory requirements under review", () => {
    const { job, profile, preferences } = setup();
    job.requirements.push({
      id: "aws",
      text: "AWS infrastructure",
      skills: ["AWS"],
      essential: true,
      hard: false,
    });
    const relaxed = { ...preferences, essentialMatch: 60 };
    expect(assessOpportunity(job, profile, preferences, now).recommendation)
      .toBe("review");
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("ready");
    job.requirements.at(-1)!.hard = true;
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("review");
  });

  it("does not require confirmation of optional credentials to mark a job ready", () => {
    const { job, profile, preferences } = setup();
    job.requirements[2] = {
      id: "optional-degree",
      text: "Computer science degree preferred",
      skills: [],
      essential: false,
      hard: false,
    };
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.recommendation).toBe("ready");
    expect(result.matches[2].status).toBe("missing");
    job.requirements[2].essential = true;
    expect(assessOpportunity(job, profile, preferences, now).recommendation)
      .toBe("review");
  });

  it("does not let a relaxed minimum override hiring restrictions or missing evidence", () => {
    const { job, profile, preferences } = setup();
    const relaxed = { ...preferences, essentialMatch: 0 };
    job.remoteScope = "us";
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("excluded");
    job.remoteScope = "worldwide";
    profile.evidence.forEach((evidence) => { evidence.verified = false; });
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("review");
  });

  it("requires review when required qualifications could not be identified", () => {
    const { job, profile, preferences } = setup();
    job.requirements.forEach((requirement) => { requirement.essential = false; });
    expect(assessOpportunity(job, profile, preferences, now).recommendation)
      .toBe("review");
  });

  it("preserves the saved required minimum and discards the old overlapping minimum", () => {
    const { preferences } = setup();
    const migrated = PreferencesSchema.parse({ ...preferences, minimumMatch: 100 });
    expect(migrated.essentialMatch).toBe(preferences.essentialMatch);
    expect(migrated).not.toHaveProperty("minimumMatch");
  });
});

