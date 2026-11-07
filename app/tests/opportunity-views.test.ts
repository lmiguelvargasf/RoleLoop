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

const matches = (opportunity: Opportunity, view: OpportunityView) =>
  opportunityMatchesView(opportunity, preferences, view);

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
  });

  it("combines location and other open questions in Needs review", () => {
    const location = job({
      location: "Remote",
      description: "Build software for global customers.",
      remoteScope: "unknown",
    });
    const salary = job({ salaryMin: null, salaryMax: null });
    expect(matches(location, "review")).toBe(true);
    expect(matches(salary, "review")).toBe(true);
    expect(matches(location, "matches")).toBe(false);
    expect(matches(salary, "matches")).toBe(true);
    expect(matches(job(), "review")).toBe(false);
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

  it("keeps excluded and uncertain roles accessible in All saved", () => {
    const excluded = job({ salaryMin: 20000, salaryMax: 30000 });
    const location = job({
      location: "Remote",
      description: "Build software for global customers.",
      remoteScope: "unknown",
    });
    expect(matches(excluded, "matches")).toBe(false);
    expect(matches(excluded, "all")).toBe(true);
    expect(matches(location, "all")).toBe(true);
    expect(matches(job(), "all")).toBe(true);
  });

  it("keeps archived records accessible only in Archived", () => {
    const archived = job({ stage: "archived" });
    for (const view of ["matches", "review", "all"] as const) {
      expect(matches(archived, view)).toBe(false);
    }
    expect(matches(archived, "archived")).toBe(true);
    expect(matches(job(), "archived")).toBe(false);
  });

  it("does not expose job-specific views for startup entries", () => {
    const startup = { ...demoOpportunities()[3], stage: "drafted" as const };
    expect(matches(startup, "all")).toBe(true);
    for (const view of ["matches", "review"] as const)
      expect(matches(startup, view)).toBe(false);
  });

  it.each(["applications", "drafted", "location-review", "unexpected", ""])(
    "rejects unknown or obsolete view %s instead of exposing all roles",
    (view) => {
      expect(matches(job(), view as OpportunityView)).toBe(false);
      expect(matches(job({ stage: "archived" }), view as OpportunityView)).toBe(
        false,
      );
    },
  );
});
