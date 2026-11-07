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
const today = "2026-11-07";

function job(patch: Partial<Opportunity> = {}): Opportunity {
  const opportunity = { ...demoOpportunities()[0], ...patch };
  opportunity.assessment = assessOpportunity(
    opportunity,
    workspace.profile,
    preferences,
  );
  return opportunity;
}

function application(
  status: NonNullable<Opportunity["application"]>["status"],
  followUpOn: string | null = null,
): NonNullable<Opportunity["application"]> {
  return { status, followUpOn, appliedAt: null, notes: "", nextAction: "" };
}

const matches = (
  opportunity: Opportunity,
  view: OpportunityView,
  detail = "all",
) => opportunityMatchesView(opportunity, preferences, view, detail, today);

describe("simplified opportunity views", () => {
  it("preserves the selected-country gate when narrowing matches by draft stage", () => {
    const eligible = job({ stage: "drafted" });
    const restricted = job({
      stage: "drafted",
      location: "Remote India",
      description: "Candidates must be based in India. Fully remote role.",
    });
    expect(matches(eligible, "matches", "drafted")).toBe(true);
    expect(matches(restricted, "matches", "drafted")).toBe(false);
    expect(matches(restricted, "all", "drafted")).toBe(true);
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

  it.each(["applied", "interview", "offer", "rejected", "withdrawn"] as const)(
    "keeps %s applications available regardless of current matching eligibility",
    (status) => {
      const opportunity = job({
        location: "Remote India",
        description: "Candidates must be based in India. Fully remote role.",
        application: application(status),
      });
      expect(matches(opportunity, "applications")).toBe(true);
      expect(matches(opportunity, "applications", status)).toBe(true);
      expect(
        matches(
          opportunity,
          "applications",
          status === "applied" ? "offer" : "applied",
        ),
      ).toBe(false);
    },
  );

  it("requires an actual application for the Applications view", () => {
    expect(matches(job(), "applications")).toBe(false);
    expect(
      matches(
        job({ application: application("saved", today) }),
        "applications",
      ),
    ).toBe(false);
    expect(
      matches(
        job({ application: application("saved", today) }),
        "applications",
        "followups",
      ),
    ).toBe(false);
  });

  it("limits follow-ups to due, active applications", () => {
    expect(
      matches(
        job({ application: application("applied", today) }),
        "applications",
        "followups",
      ),
    ).toBe(true);
    expect(
      matches(
        job({ application: application("interview", "2026-11-06") }),
        "applications",
        "followups",
      ),
    ).toBe(true);
    expect(
      matches(
        job({ application: application("applied", "2026-11-08") }),
        "applications",
        "followups",
      ),
    ).toBe(false);
    for (const status of ["rejected", "withdrawn", "offer"] as const)
      expect(
        matches(
          job({ application: application(status, today) }),
          "applications",
          "followups",
        ),
      ).toBe(false);
  });

  it("keeps archived records accessible only in Archived, including due applications", () => {
    const archived = job({
      stage: "archived",
      application: application("applied", today),
    });
    for (const view of ["matches", "review", "applications", "all"] as const) {
      expect(matches(archived, view)).toBe(false);
      expect(matches(archived, view, "followups")).toBe(false);
    }
    expect(matches(archived, "archived")).toBe(true);
    expect(matches(archived, "archived", "applied")).toBe(false);
    expect(matches(job(), "archived")).toBe(false);
  });

  it("retains startup preparation views without exposing job-specific views", () => {
    const startup = { ...demoOpportunities()[3], stage: "drafted" as const };
    expect(matches(startup, "all")).toBe(true);
    expect(matches(startup, "all", "drafted")).toBe(true);
    expect(matches(startup, "all", "ready")).toBe(false);
    for (const view of ["matches", "review", "applications"] as const)
      expect(matches(startup, view)).toBe(false);
    expect(matches(startup, "all", "excluded")).toBe(false);
  });

  it("rejects irrelevant details rather than changing the main view silently", () => {
    const opportunity = job({ application: application("applied") });
    expect(matches(opportunity, "matches", "applied")).toBe(false);
    expect(matches(opportunity, "applications", "ready")).toBe(false);
    expect(matches(opportunity, "all", "unexpected")).toBe(false);
  });
});
