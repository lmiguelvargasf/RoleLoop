import { describe, expect, it } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import {
  opportunityMatchesView,
  type OpportunityView,
} from "../src/shared/opportunity-views.js";
import type { Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const workspace = demoWorkspace();
const preferences = workspace.preferences;

function job(patch: Partial<Opportunity> = {}): Opportunity {
  const opportunity = { ...demoOpportunities()[0], ...patch };
  opportunity.assessment = assessOpportunity(
    opportunity,
    workspace.profile,
    preferences,
  );
  return opportunity;
}

const matches = (
  opportunity: Opportunity,
  view: OpportunityView,
  detail = "all",
) => opportunityMatchesView(opportunity, preferences, view, detail);

describe("simplified opportunity views", () => {
  it("preserves the selected-country gate in the default Matches view", () => {
    const eligible = job({ stage: "drafted" });
    const restricted = job({
      stage: "drafted",
      location: "Remote India",
      description: "Candidates must be based in India. Fully remote role.",
    });
    expect(matches(eligible, "matches")).toBe(true);
    expect(matches(restricted, "matches")).toBe(false);
    expect(matches(restricted, "all")).toBe(true);
    expect(matches(restricted, "all", "excluded")).toBe(true);
  });

  it("combines location and other review questions while allowing relevant narrowing", () => {
    const location = job({
      location: "Remote",
      description: "Build software for global customers.",
      remoteScope: "unknown",
    });
    const salary = job({ salaryMin: null, salaryMax: null });
    expect(matches(location, "review")).toBe(true);
    expect(matches(salary, "review")).toBe(true);
    expect(matches(location, "review", "location-review")).toBe(true);
    expect(matches(location, "review", "fit-review")).toBe(false);
    expect(matches(salary, "review", "location-review")).toBe(false);
    expect(matches(salary, "review", "fit-review")).toBe(true);
    expect(matches(salary, "matches")).toBe(true);
  });

  it("keeps unrelated and excluded roles out of the review queue", () => {
    const unrelated = job({
      title: "Civil Engineer",
      salaryMin: null,
      salaryMax: null,
    });
    const excluded = job({ salaryMin: 20000, salaryMax: 30000 });
    expect(matches(unrelated, "review")).toBe(false);
    expect(matches(excluded, "review")).toBe(false);
    const unevaluated = { ...job(), assessment: null };
    expect(matches(unevaluated, "review")).toBe(true);
    expect(matches(unevaluated, "matches")).toBe(false);
  });

  it("narrows All saved by exclusion or location questions", () => {
    const excluded = job({ salaryMin: 20000, salaryMax: 30000 });
    const location = job({
      location: "Remote",
      description: "Build software for global customers.",
      remoteScope: "unknown",
    });
    expect(matches(excluded, "all", "excluded")).toBe(true);
    expect(matches(job(), "all", "excluded")).toBe(false);
    expect(matches(location, "all", "location-review")).toBe(true);
    expect(matches(job(), "all", "location-review")).toBe(false);
  });

  it("keeps archived records accessible only in Archived", () => {
    const archived = job({ stage: "archived" });
    for (const view of ["matches", "review", "all"] as const) {
      expect(matches(archived, view)).toBe(false);
      expect(matches(archived, view, "location-review")).toBe(false);
    }
    expect(matches(archived, "archived")).toBe(true);
    expect(matches(archived, "archived", "location-review")).toBe(false);
    expect(matches(job(), "archived")).toBe(false);
  });

  it("does not expose job-specific views and details for startup entries", () => {
    const startup = { ...demoOpportunities()[3], stage: "drafted" as const };
    expect(matches(startup, "all")).toBe(true);
    for (const view of ["matches", "review"] as const)
      expect(matches(startup, view)).toBe(false);
    expect(matches(startup, "all", "excluded")).toBe(false);
    expect(matches(startup, "all", "location-review")).toBe(false);
  });

  it.each([
    "new",
    "review",
    "ready",
    "drafted",
    "approved",
    "applied",
    "followups",
    "unexpected",
  ])("rejects obsolete or invalid detail %s in every view", (detail) => {
    for (const view of ["matches", "review", "all", "archived"] as const)
      expect(matches(job({ stage: "drafted" }), view, detail)).toBe(false);
  });

  it("rejects inapplicable details rather than bypassing the main view", () => {
    const salary = job({ salaryMin: null, salaryMax: null });
    expect(matches(salary, "matches", "fit-review")).toBe(false);
    expect(matches(salary, "all", "fit-review")).toBe(false);
    expect(matches(salary, "review", "excluded")).toBe(false);
    expect(matches(salary, "matches", "location-review")).toBe(false);
    expect(matches(salary, "matches", "excluded")).toBe(false);
    expect(matches(salary, "applications" as OpportunityView)).toBe(false);
  });
});
