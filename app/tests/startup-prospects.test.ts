import { describe, expect, it } from "vitest";
import { outreachProgressFor } from "../src/shared/outreach-board.js";
import {
  startupMatchesQuery,
  startupMatchesSource,
  startupMatchesView,
  startupSourceLabels,
  startupSourceOptions,
  type StartupView,
} from "../src/shared/startup-prospects.js";
import type { Opportunity } from "../src/shared/types.js";
import { demoOpportunities } from "./fixtures.js";

const base = demoOpportunities().find((op) => op.kind === "startup")!;
const startup = (patch: Partial<Opportunity> = {}): Opportunity => ({
  ...base,
  source: "hackernews",
  ...patch,
});

describe("startup prospect views", () => {
  it("keeps active companies to explore until they enter outreach", () => {
    const untracked = startup({ stage: "review" });
    const tracked = startup({ outreach: outreachProgressFor(base, "saved") });
    const closed = startup({ outreach: outreachProgressFor(base, "closed") });
    expect(startupMatchesView(untracked, "explore")).toBe(true);
    for (const opportunity of [tracked, closed]) {
      expect(startupMatchesView(opportunity, "explore")).toBe(false);
      expect(startupMatchesView(opportunity, "all")).toBe(true);
    }
  });

  it("separates archives and rejects jobs or obsolete views", () => {
    const archived = startup({ stage: "archived" });
    expect(startupMatchesView(archived, "archived")).toBe(true);
    expect(startupMatchesView(archived, "explore")).toBe(false);
    expect(startupMatchesView(archived, "all")).toBe(false);
    expect(startupMatchesView(startup(), "archived")).toBe(false);
    for (const view of ["explore", "all", "archived"] as const)
      expect(startupMatchesView({ ...archived, kind: "job" }, view)).toBe(
        false,
      );
    expect(startupMatchesView(startup(), "review" as StartupView)).toBe(false);
  });
});

describe("startup source filtering", () => {
  const merged = startup({
    discoverySignals: [
      {
        source: "Seedcamp",
        sourceKey: "seedcamp:one",
        title: "Seedcamp portfolio company",
        url: "https://seedcamp.com/our-companies/",
        publishedAt: null,
      },
      {
        source: "Show HN",
        sourceKey: "hackernews:one",
        title: "Show HN launch",
        url: "https://news.ycombinator.com/item?id=1",
        publishedAt: null,
      },
    ],
  });

  it("finds a merged company through every source without duplicating it", () => {
    const saved = structuredClone(merged);
    expect(startupMatchesSource(merged, "seedcamp")).toBe(true);
    expect(startupMatchesSource(merged, "hackernews")).toBe(true);
    expect(startupMatchesSource(merged, "all")).toBe(true);
    expect(startupMatchesSource(merged, "manual")).toBe(false);
    expect(startupSourceLabels(merged)).toEqual(["Seedcamp", "Show HN"]);
    expect(merged).toEqual(saved);
  });

  it("retains original provenance and old records without discovery signals", () => {
    const partial = { ...merged, source: "founder_directory" };
    expect(startupMatchesSource(partial, "founder_directory")).toBe(true);
    expect(
      startupMatchesSource(startup({ discoverySignals: [] }), "hackernews"),
    ).toBe(true);
    expect(
      startupSourceOptions([
        merged,
        startup({ source: "Hacker News" }),
        startup({ source: "Manual entry", stage: "archived" }),
        startup({ source: "founder_directory" }),
        { ...base, kind: "job", source: "lever" },
      ]),
    ).toEqual([
      { value: "all", label: "All sources" },
      { value: "manual", label: "Added previously" },
      { value: "founder_directory", label: "Founder Directory" },
      { value: "seedcamp", label: "Seedcamp" },
      { value: "hackernews", label: "Show HN" },
    ]);
    expect(startupSourceOptions([])).toEqual([
      { value: "all", label: "All sources" },
    ]);
  });
});

describe("startup prospect search", () => {
  const company = startup({
    company: "Clearwater",
    title: "Analytics for logistics teams",
    description: "Fleet planning software",
    location: "London",
    companyCountry: "United Kingdom",
    signals: ["B2B software"],
    requirements: [
      {
        id: "typescript",
        text: "Build integrations",
        skills: ["TypeScript"],
        essential: false,
        hard: false,
      },
    ],
  });

  it("ignores case and surrounding whitespace and searches useful company context", () => {
    for (const query of [
      "  CLEARwater  ",
      "logistics",
      "fleet",
      "london",
      "kingdom",
      "B2B",
      "typescript",
      "clearwater london",
      " ",
    ])
      expect(startupMatchesQuery(company, query)).toBe(true);
    expect(startupMatchesQuery(company, "unrelated company")).toBe(false);
  });
});
