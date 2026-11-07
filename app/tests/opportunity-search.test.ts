import { describe, expect, it } from "vitest";
import { opportunityMatchesQuery } from "../src/shared/opportunity-search";
import { opportunityMatchesView } from "../src/shared/opportunity-views";
import { demoOpportunities, demoWorkspace } from "./fixtures";

describe("search saved jobs", () => {
  const job = demoOpportunities()[0];
  it("finds companies, role titles, skills and locations regardless of case or whitespace", () => {
    for (const query of [
      " NORTHSTAR ",
      "Full Stack",
      "typescript",
      "worldwide",
      "northstar react",
      "   ",
    ])
      expect(opportunityMatchesQuery(job, query)).toBe(true);
    expect(opportunityMatchesQuery(job, "northstar healthcare")).toBe(false);
  });
  it("retains the selected view when searching", () => {
    const archived = { ...job, stage: "archived" as const };
    const prefs = demoWorkspace().preferences;
    const matches = (view: "all" | "archived") =>
      opportunityMatchesView(archived, prefs, view) &&
      opportunityMatchesQuery(archived, "Northstar");
    expect(matches("all")).toBe(false);
    expect(matches("archived")).toBe(true);
  });
});
