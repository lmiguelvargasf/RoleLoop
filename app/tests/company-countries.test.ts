import { describe, expect, it } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import { PreferencesSchema } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const now = new Date("2026-11-05T17:00:00Z");

describe.each(["job", "startup"] as const)("%s company countries", (kind) => {
  function assess(companyCountry: string, targets = "Netherlands, Germany, USA") {
    const { profile, preferences } = demoWorkspace();
    const op = demoOpportunities(now).find((item) => item.kind === kind)!;
    return assessOpportunity(
      { ...op, companyCountry },
      profile,
      PreferencesSchema.parse({ ...preferences, companyCountry: targets }),
      now,
    );
  }

  it.each(["Netherlands", "Germany", "United States", "NL", " germany "])(
    "accepts %s from any position in the target list, including aliases",
    (country) => {
      expect(assess(country).blockers).toEqual([]);
    },
  );

  it("excludes countries outside the list and explains the alternatives", () => {
    expect(assess("Canada").blockers).toEqual([
      "Company country (Canada) does not match Netherlands or Germany or USA.",
    ]);
  });

  it.each(["Unknown", "", "Not specified"])(
    "keeps unverified headquarters (%s) for review",
    (country) => {
      const result = assess(country);
      expect(result.blockers).toEqual([]);
      expect(result.unknowns).toContain("Company headquarters country is not verified.");
    },
  );

  it.each(["", "   ", ", ; \n"])(
    "does not filter headquarters when the list is empty (%j)",
    (targets) => {
      for (const country of ["Canada", "Unknown"]) {
        const result = assess(country, targets);
        expect(result.blockers).toEqual([]);
        expect(result.unknowns).not.toContain("Company headquarters country is not verified.");
      }
    },
  );

  it("retains single-country preferences", () => {
    expect(assess("United States", "USA").blockers).toEqual([]);
    expect(assess("Canada", "USA").blockers).toEqual([
      "Company country (Canada) does not match USA.",
    ]);
  });

  it("tolerates repeated countries and separators", () => {
    expect(assess("Germany", " Netherlands, , NL; Germany\nUSA, ").blockers).toEqual([]);
  });
});

it("keeps working-country restrictions separate from company targets", () => {
  const { profile, preferences } = demoWorkspace();
  const job = {
    ...demoOpportunities(now)[0],
    companyCountry: "Netherlands",
    location: "Remote, Netherlands",
    remoteScope: "unknown" as const,
    description: "Remote work. Applicants must be based in the Netherlands.",
  };
  const result = assessOpportunity(job, profile, {
    ...preferences,
    companyCountry: "Netherlands, Germany",
  }, now);
  expect(result.geography?.status).toBe("excluded");
  expect(result.blockers.length).toBeGreaterThan(0);
  expect(result.blockers.join(" ")).not.toContain("Company country");
});
