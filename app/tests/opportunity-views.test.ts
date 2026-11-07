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
  it("preserves hard hiring restrictions in Recommended", () => {
    const eligible = job({ stage: "drafted" });
    const restricted = job({
      stage: "drafted",
      location: "Remote India",
      description: "Candidates must be based in India. Fully remote role.",
    });
    expect(matches(eligible, "recommended")).toBe(true);
    expect(matches(restricted, "recommended")).toBe(false);
    expect(matches(restricted, "all")).toBe(true);
  });

  it("combines promising jobs with location or salary questions in Recommended", () => {
    const location = job({
      location: "Remote",
      description: "Build software.",
      remoteScope: "unknown",
    });
    const salary = job({ salaryMin: null, salaryMax: null });
    expect(matches(location, "recommended")).toBe(true);
    expect(matches(salary, "recommended")).toBe(true);
    expect(matches(job(), "recommended")).toBe(true);
  });

  it("keeps unrelated and unevaluated jobs in All saved", () => {
    const unrelated = job({ title: "Civil Engineer" });
    const unevaluated = { ...job(), assessment: null };
    for (const opportunity of [unrelated, unevaluated]) {
      expect(matches(opportunity, "recommended")).toBe(false);
      expect(matches(opportunity, "all")).toBe(true);
    }
  });

  it("leaves tracked jobs on Applications and in All saved", () => {
    const tracked = job();
    tracked.application = {
      status: "saved",
      appliedAt: null,
      nextAction: "",
      followUpOn: null,
      notes: "",
    };
    expect(matches(tracked, "recommended")).toBe(false);
    expect(matches(tracked, "all")).toBe(true);
  });

  it("keeps excluded and uncertain roles accessible in All saved", () => {
    const excluded = job({ salaryMin: 20000, salaryMax: 30000 });
    const location = job({
      location: "Remote",
      description: "Build software for global customers.",
      remoteScope: "unknown",
    });
    expect(matches(excluded, "recommended")).toBe(false);
    expect(matches(excluded, "all")).toBe(true);
    expect(matches(location, "all")).toBe(true);
    expect(matches(job(), "all")).toBe(true);
  });

  it("keeps archived records accessible only in Archived", () => {
    const archived = job({ stage: "archived" });
    for (const view of ["recommended", "all"] as const) {
      expect(matches(archived, view)).toBe(false);
    }
    expect(matches(archived, "archived")).toBe(true);
    expect(matches(job(), "archived")).toBe(false);
  });

  it("does not expose job-specific views for startup entries", () => {
    const startup = { ...demoOpportunities()[3], stage: "drafted" as const };
    expect(matches(startup, "all")).toBe(true);
    for (const view of ["recommended"] as const)
      expect(matches(startup, view)).toBe(false);
  });

  it.each([
    "matches",
    "review",
    "applications",
    "drafted",
    "location-review",
    "unexpected",
    "",
  ])(
    "rejects unknown or obsolete view %s instead of exposing all roles",
    (view) => {
      expect(matches(job(), view as OpportunityView)).toBe(false);
      expect(matches(job({ stage: "archived" }), view as OpportunityView)).toBe(
        false,
      );
    },
  );
});
