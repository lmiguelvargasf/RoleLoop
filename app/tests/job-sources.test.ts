import { describe, expect, it } from "vitest";
import {
  jobMatchesSource,
  jobSourceOptions,
  jobSourceProvider,
} from "../src/shared/job-sources.js";
import { opportunityMatchesView, type OpportunityView } from "../src/shared/opportunity-views.js";
import { assessOpportunity } from "../src/domain/rules.js";
import type { Opportunity, Source } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const [base] = demoOpportunities();
const source: Source = {
  id: "company-board", provider: "greenhouse", board: "acme", label: "Acme renamed", enabled: false,
};
const job = (patch: Partial<Opportunity>): Opportunity => ({ ...base, ...patch });

describe("job source filtering", () => {
  it("uses persisted provider provenance despite company names or changed source settings", () => {
    expect(jobSourceProvider(job({ sourceKey: "jobicy:123", source: "Acme", sourceId: source.id }), [source])).toBe("jobicy");
    expect(jobSourceProvider(job({ sourceKey: "weworkremotely:456", source: "Acme", sourceId: "removed" }), [])).toBe("weworkremotely");
    expect(jobSourceProvider(job({ sourceKey: "legacy:1", source: "Greenhouse", sourceId: "removed" }), [])).toBe("greenhouse");
    expect(jobSourceProvider(job({ sourceKey: "legacy:2", source: "Acme", sourceId: source.id }), [source])).toBe("greenhouse");
  });

  it("lists only represented providers once, including archived jobs and manual entries", () => {
    const opportunities = [
      job({ sourceKey: "jobicy:1", company: "One" }),
      job({ sourceKey: "jobicy:2", company: "Two" }),
      job({ sourceKey: "weworkremotely:3", stage: "archived" }),
      job({ sourceKey: "greenhouse:acme:4" }),
      job({ sourceKey: "manual:5", source: "Manual entry" }),
      { ...demoOpportunities()[3], sourceKey: "hackernews:6" },
    ];
    expect(jobSourceOptions(opportunities, [{ ...source, provider: "lever" }])).toEqual([
      { value: "all", label: "All sources" },
      { value: "greenhouse", label: "Greenhouse" },
      { value: "jobicy", label: "Jobicy" },
      { value: "manual", label: "Manual entry" },
      { value: "weworkremotely", label: "We Work Remotely" },
    ]);
  });

  it("keeps unrecognized legacy sources available under Other sources and All sources", () => {
    const unknown = job({ sourceKey: "old:1", source: "Legacy board", sourceId: "removed" });
    expect(jobMatchesSource(unknown, [], "other")).toBe(true);
    expect(jobMatchesSource(unknown, [], "all")).toBe(true);
    expect(jobMatchesSource(unknown, [], "jobicy")).toBe(false);
    expect(jobSourceOptions([], [source])).toEqual([{ value: "all", label: "All sources" }]);
  });

  it.each(["recommended", "all", "archived"] as const)(
    "combines source and %s view without changing saved jobs or source settings",
    (view: OpportunityView) => {
      const workspace = demoWorkspace();
      const jobs = [
        job({ id: "jobicy-active", sourceKey: "jobicy:1", stage: "review" }),
        job({ id: "wwr-active", sourceKey: "weworkremotely:2", stage: "review" }),
        job({ id: "jobicy-archived", sourceKey: "jobicy:3", stage: "archived" }),
        job({ id: "wwr-archived", sourceKey: "weworkremotely:4", stage: "archived" }),
      ].map((opportunity) => {
        const local = assessOpportunity(opportunity, workspace.profile, workspace.preferences);
        return {
          ...opportunity,
          assessment: assessOpportunity(opportunity, workspace.profile, workspace.preferences, new Date(), local.matches),
        };
      });
      const saved = structuredClone(jobs);
      const sources = [source];
      const selected = jobs.filter((opportunity) =>
        opportunityMatchesView(opportunity, workspace.preferences, view) &&
        jobMatchesSource(opportunity, sources, "jobicy"),
      );
      expect(selected.map((opportunity) => opportunity.id)).toEqual([
        view === "archived" ? "jobicy-archived" : "jobicy-active",
      ]);
      expect(jobs).toEqual(saved);
      expect(sources).toEqual([source]);
    },
  );
});
