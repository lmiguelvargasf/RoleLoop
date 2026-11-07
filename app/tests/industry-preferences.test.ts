import { describe, expect, it } from "vitest";
import { assessOpportunity, orderOpportunities } from "../src/domain/rules.js";
import {
  industryPriorityBoost,
  preferredIndustryMatches,
} from "../src/shared/industries.js";
import { PreferencesSchema, type Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const now = new Date("2026-11-05T17:00:00Z");

function opportunity(
  kind: "job" | "startup",
  id: string,
  description: string,
  score: number,
  recommendation = "ready" as "ready" | "review" | "excluded",
): Opportunity {
  const workspace = demoWorkspace();
  const source = demoOpportunities(now)[kind === "job" ? 0 : 3];
  return {
    ...source,
    id,
    title: kind === "job" ? source.title : "Engineering opportunity",
    description,
    assessment: {
      ...assessOpportunity(
        source,
        workspace.profile,
        workspace.preferences,
        now,
      ),
      score,
      essentialScore: score,
      recommendation,
    },
  };
}

describe("industry preference compatibility and signals", () => {
  it("keeps existing interests and defaults older saved preferences to prefer", () => {
    const { industryPreference, topIndustries, ...older } =
      demoWorkspace().preferences;
    const parsed = PreferencesSchema.parse(older);
    expect(parsed.industryPreference).toBe("prefer");
    expect(parsed.topIndustries).toEqual([]);
    expect(parsed.industries).toEqual(older.industries);
  });

  it("matches complete phrases and known terminology without substring false positives", () => {
    const op = opportunity(
      "job",
      "job",
      "We build developer-tools and financial technology for online retail.",
      90,
    );
    const preferences = {
      industries: ["Developer tools", "Fintech", "Ecommerce", "AI", "Fintech"],
      industryPreference: "prefer" as const,
    };
    expect(preferredIndustryMatches(op, preferences)).toEqual([
      "Developer tools",
      "Fintech",
      "Ecommerce",
    ]);
    expect(
      preferredIndustryMatches(op, {
        ...preferences,
        industryPreference: "any",
      }),
    ).toEqual([]);
    expect(preferences.industries).toHaveLength(5);
  });

  it("retains previously saved interest names and recognizes punctuation as word boundaries", () => {
    const op = opportunity(
      "startup",
      "custom",
      "Space technology for logistics.",
      80,
    );
    expect(
      preferredIndustryMatches(op, {
        industries: ["Space technology", "Space", "place"],
      }),
    ).toEqual(["Space technology", "Space"]);
  });
});

describe.each(["job", "startup"] as const)("%s industry priority", (kind) => {
  it("gives top priorities more weight without stacking overlapping interests", () => {
    const preferences = {
      ...demoWorkspace().preferences,
      industries: ["Climate", "Fintech", "AI"],
      topIndustries: ["Fintech"],
    };
    const top = opportunity(kind, "top", "Fintech and AI software", 80);
    const interested = opportunity(kind, "interested", "Climate software", 82);
    const outside = opportunity(kind, "outside", "Accounting software", 86);
    expect(industryPriorityBoost(top, preferences)).toBe(10);
    expect(industryPriorityBoost(interested, preferences)).toBe(5);
    expect(industryPriorityBoost(outside, preferences)).toBe(0);
    expect(
      orderOpportunities([interested, outside, top], preferences, now).map(
        (op) => op.id,
      ),
    ).toEqual(kind === "job" ? ["outside", "interested", "top"] : ["top", "interested", "outside"]);
    expect(
      orderOpportunities(
        [top, opportunity(kind, "emerging", "Quantum computing", 100)],
        preferences,
        now,
      ).map((op) => op.id),
    ).toEqual(["emerging", "top"]);
    expect(
      industryPriorityBoost(top, { ...preferences, industryPreference: "any" }),
    ).toBe(0);
    expect(industryPriorityBoost(top, { ...preferences, industries: [] })).toBe(
      0,
    );
  });

  it("raises a preferred interest while retaining every other opportunity", () => {
    const preferences = {
      ...demoWorkspace().preferences,
      industries: ["Climate"],
    };
    const outside = opportunity(
      kind,
      "outside",
      "Tools for accounting teams",
      84,
    );
    const preferred = opportunity(
      kind,
      "preferred",
      "Climate risk software",
      80,
    );
    const input = [outside, preferred];
    expect(
      orderOpportunities(input, preferences, now).map((op) => op.id),
    ).toEqual(kind === "job" ? ["outside", "preferred"] : ["preferred", "outside"]);
    expect(input.map((op) => op.id)).toEqual(["outside", "preferred"]);
    expect(preferred.assessment?.score).toBe(80);
  });

  it("lets a stronger general fit outrank a weaker preferred-industry fit", () => {
    const preferences = {
      ...demoWorkspace().preferences,
      industries: ["Climate"],
    };
    const input = [
      opportunity(kind, "preferred", "Climate software", 80),
      opportunity(kind, "emerging", "Emerging quantum logistics software", 100),
    ];
    expect(
      orderOpportunities(input, preferences, now).map((op) => op.id),
    ).toEqual(["emerging", "preferred"]);
  });

  it("uses ordinary fit ordering in any-industry mode without clearing selected interests", () => {
    const preferences = {
      ...demoWorkspace().preferences,
      industryPreference: "any" as const,
      industries: ["Climate"],
    };
    const input = [
      opportunity(kind, "preferred", "Climate risk software", 80),
      opportunity(kind, "outside", "Accounting tools", 95),
    ];
    expect(
      orderOpportunities(input, preferences, now).map((op) => op.id),
    ).toEqual(["outside", "preferred"]);
    expect(preferences.industries).toEqual(["Climate"]);
  });

  it("does not promote a preferred but excluded or unready opportunity over a ready one", () => {
    const preferences = {
      ...demoWorkspace().preferences,
      industries: ["Climate"],
    };
    const input = [
      opportunity(kind, "blocked", "Climate software", 100, "excluded"),
      opportunity(kind, "review", "Climate software", 100, "review"),
      opportunity(kind, "ready", "Accounting software", 80),
    ];
    expect(
      orderOpportunities(input, preferences, now).map((op) => op.id),
    ).toEqual(kind === "job" ? ["review", "ready", "blocked"] : ["ready", "review", "blocked"]);
  });

  it("never changes evidence scores or adds an industry exclusion", () => {
    const workspace = demoWorkspace();
    const op = {
      ...demoOpportunities(now)[kind === "job" ? 0 : 3],
      description:
        "Healthcare software. " +
        demoOpportunities(now)[kind === "job" ? 0 : 3].description,
    };
    const preferred = assessOpportunity(
      op,
      workspace.profile,
      { ...workspace.preferences, industries: ["Healthcare"] },
      now,
    );
    const outside = assessOpportunity(
      op,
      workspace.profile,
      { ...workspace.preferences, industries: ["Climate"] },
      now,
    );
    const any = assessOpportunity(
      op,
      workspace.profile,
      {
        ...workspace.preferences,
        industries: ["Healthcare"],
        industryPreference: "any",
      },
      now,
    );
    expect(preferred.score).toBe(outside.score);
    expect(any.score).toBe(preferred.score);
    expect(preferred.essentialScore).toBe(outside.essentialScore);
    expect(outside.blockers).toEqual(preferred.blockers);
    expect(outside.unknowns).toEqual(preferred.unknowns);
    expect(any.reasons.join(" ")).not.toContain("Preferred industry signal");
  });
});
