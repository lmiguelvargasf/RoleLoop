import { describe, expect, it } from "vitest";
import { remoteScope } from "../src/domain/connectors.js";
import {
  assessGeography,
  isLatam,
  normalizeCountry,
} from "../src/domain/geography.js";

function assess(description: string, country = "Ecuador", location = "Remote") {
  return assessGeography(
    {
      title: "Software Engineer",
      location,
      description,
      remoteScope: remoteScope(`${location}\n${description}`),
    },
    country,
  );
}

describe("geographic hiring eligibility", () => {
  it.each([
    ["Remote LATAM — Brazil only", "Brazil"],
    ["Remote worldwide. This role is US-only.", "United States"],
    [
      "Remote worldwide. Only candidates based in Brazil or Mexico",
      "Brazil, Mexico",
    ],
    ["Remote worldwide. Candidates must reside in Brazil.", "Brazil"],
    ["Remote worldwide. Candidates must be based in Brazil.", "Brazil"],
    ["Remote worldwide. We can only hire in Brazil.", "Brazil"],
    ["Remote worldwide. Work must be performed in Brazil.", "Brazil"],
    ["Remote worldwide. Must be located within Brazil.", "Brazil"],
    ["Remote worldwide. US applicants only.", "United States"],
    ["Remote worldwide. Hiring countries: Brazil, Mexico.", "Brazil, Mexico"],
    ["Remote worldwide. Only candidates based in BR or MX.", "Brazil, Mexico"],
    ["Remote worldwide. United States and Canada only.", "United States"],
    [
      "Remote worldwide. This role is Brazil-only, with salary of $100,000.",
      "Brazil",
    ],
    [
      "Remote worldwide. Only candidates in Brazil may apply, with salary of $100,000.",
      "Brazil",
    ],
  ])("country restrictions override broad labels: %s", (text, country) => {
    expect(assess(text).blockers.join(" ")).toContain(country);
  });

  it.each([
    "Remote LATAM except Ecuador",
    "Remote worldwide. We are not hiring in Ecuador.",
    "Remote worldwide. We cannot hire candidates based in Ecuador.",
    "Remote worldwide. Applicants from Ecuador are not eligible.",
    "Remote worldwide. Candidates must not be based in Ecuador.",
  ])("honors explicit exclusions: %s", (text) => {
    expect(assess(text).blockers.join(" ")).toContain(
      "explicitly excludes applicants working in Ecuador",
    );
  });

  it.each([
    "Remote LATAM",
    "Remote Latin America",
    "Remote worldwide",
    "Remote LATAM. Brazil or Ecuador only.",
    "Remote worldwide. Candidates must be based in Brazil or Ecuador.",
    "Remote worldwide. Hiring countries: Brazil, Ecuador.",
    "Remote worldwide. Only Brazil or Ecuador.",
    "Remote LATAM except Brazil",
    "Remote worldwide. Candidates based in Ecuador, Colombia, or Peru may apply.",
  ])("retains compatible openings: %s", (text) => {
    expect(assess(text).blockers).toEqual([]);
  });

  it.each([
    "Remote, not US-only",
    "Remote. There is no need to be based in the US.",
    "Remote. You do not need to be based in the US.",
    "Remote. We offer US-only benefits to employees based there.",
    "Remote. For US applicants only, the salary range is $100,000.",
    "Remote. We offer US-only salary disclosures.",
    "Remote. US-based company serving customers in Brazil.",
    "Remote. We serve clients in Brazil only.",
    "Remote. Our company has US-only operations.",
    "Remote. Candidates must work in US time zones.",
    "Remote. Candidates must overlap US hours.",
    "Remote worldwide. Join us to build the next product.",
  ])(
    "does not turn non-hiring prose into residence restrictions: %s",
    (text) => {
      expect(assess(text).blockers).toEqual([]);
    },
  );

  it.each([
    "Remote worldwide. Candidates must be based in LATAM.",
    "Remote worldwide. LATAM only.",
    "Remote worldwide. Candidates must be based in the Americas.",
    "Remote worldwide. Americas only.",
  ])("applies explicit regional requirements: %s", (text) => {
    expect(assess(text, "Germany").blockers.length).toBeGreaterThan(0);
    expect(assess(text).blockers).toEqual([]);
  });

  it("keeps contradictory country evidence for review", () => {
    const result = assess("Remote worldwide. Brazil only. Ecuador only.");
    expect(result.blockers).toEqual([]);
    expect(result.unknowns.join(" ")).toContain(
      "conflicting hiring-country restrictions",
    );
  });

  it.each([
    "Belize",
    "Guyana",
    "Suriname",
    "Jamaica",
    "Puerto Rico",
    "Canada",
    "Greenland",
  ])("includes %s in an Americas-wide opening", (country) => {
    expect(
      assess("Remote worldwide. Americas only.", country).blockers,
    ).toEqual([]);
  });

  it("keeps eligibility requiring citizenship or authorization unresolved", () => {
    const result = assess(
      "Remote worldwide. US citizens only. Work authorization is required.",
    );
    expect(result.blockers).toEqual([]);
    expect(result.unknowns.join(" ")).toContain("work authorization");
  });

  it("reviews a short country label that conflicts with explicit LATAM coverage", () => {
    const result = assess(
      "Remote Latin America",
      "Ecuador",
      "Remote, United States",
    );
    expect(result.blockers).toEqual([]);
    expect(result.unknowns.join(" ")).toContain(
      "listed country and broader remote scope",
    );
  });

  it("does not use a title's market name as candidate residence", () => {
    const result = assessGeography(
      {
        title: "Brazil Country Manager",
        location: "Remote worldwide",
        description: "Manage our customers in Brazil.",
        remoteScope: "worldwide",
      },
      "Ecuador",
    );
    expect(result.blockers).toEqual([]);
  });

  it("preserves persisted explicit scope when the text supplies no narrower evidence", () => {
    const job = {
      location: "Remote worldwide",
      description: "Build software.",
      remoteScope: "us" as const,
    };
    expect(assessGeography(job, "Ecuador").blockers).toContain(
      "This role is restricted to people working in the United States.",
    );
  });

  it("normalizes working-country aliases without interpreting ordinary prose as codes", () => {
    expect(normalizeCountry("EC")).toBe("ecuador");
    expect(normalizeCountry(" U.S.A. ")).toBe("united states");
    expect(normalizeCountry("Brasil")).toBe("brazil");
    expect(isLatam("EC")).toBe(true);
    expect(assess("Remote LATAM", "EC").blockers).toEqual([]);
    expect(assess("Remote LATAM", "LATAM").unknowns.join(" ")).toContain(
      "specific working country",
    );
    expect(assess("Remote worldwide", "").unknowns).toContain(
      "Your working country is missing.",
    );
  });

  it.each(["CA-only", "IN applicants only", "Georgia only"])(
    "reviews ambiguous state or country names: %s",
    (restriction) => {
      const result = assess(
        `Remote worldwide. This role is ${restriction}.`,
        "United States",
      );
      expect(result.blockers).toEqual([]);
      expect(result.unknowns.join(" ")).toContain(
        "restrictions need confirmation",
      );
    },
  );

  it("accepts ambiguous ISO codes when they are explicitly labelled countries", () => {
    const text = "Remote worldwide. Hiring countries: CA, CO.";
    expect(assess(text).blockers.join(" ")).toContain("Canada, Colombia");
    expect(assess(text, "Canada").blockers).toEqual([]);
  });

  it.each([
    "Remote worldwide. This role is open to candidates in the United States or LATAM.",
    "Remote worldwide. We hire in the United States and Latin America.",
    "Remote worldwide. Only candidates based in Brazil, CA or Ecuador.",
    "Remote worldwide. United States or LATAM only.",
  ])(
    "reviews a mixed list instead of treating a partial parse as exhaustive: %s",
    (text) => {
      const result = assess(text);
      expect(result.blockers).toEqual([]);
      expect(result.unknowns.join(" ")).toContain(
        "complete hiring-location list",
      );
    },
  );

  it("does not let an incidental team mention hide an explicit residence requirement", () => {
    expect(
      assess(
        "Remote worldwide. You must be based in Brazil to join our team.",
      ).blockers.join(" "),
    ).toContain("Brazil");
  });
});
