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
    "Full-Stack Engineer, Part-Time AI Code Evaluation - Remote (United States)",
    "Part-time, under 20 hours a week, you choose when; fully remote, United States",
    "Remote worldwide. This role is fully remote (United States).",
  ])("honors compact remote hiring locations in employer text: %s", (text) => {
    const result = assess(text, "Ecuador", "Remote worldwide");
    expect(result.status).toBe("excluded");
    expect(result.blockers.join(" ")).toContain("United States");
    expect(assess(text, "United States", "Remote worldwide").blockers).toEqual([]);
  });

  it.each([
    "Remote (United States or LATAM)",
    "Fully remote, United States and Latin America",
    "Remote (United States, Brazil or Ecuador)",
  ])("preserves the complete compact country-region union: %s", (text) => {
    expect(assess(text).status).toBe("eligible");
    expect(assess(text).blockers).toEqual([]);
  });

  it.each([
    "Remote worldwide. Our team is remote (United States).",
    "Remote worldwide. Work remotely (United States hours).",
    "Remote worldwide. We are not remote (United States only).",
  ])("does not turn compact incidental or negated text into a hiring limit: %s", (text) => {
    expect(assess(text).blockers).toEqual([]);
  });

  it("does not narrow separately stated remote alternatives to the first country", () => {
    const result = assess("Remote (United States) or remote (LATAM)");
    expect(result.status).toBe("review");
    expect(result.blockers).toEqual([]);
  });

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
    "Remote worldwide. United States or LATAM only.",
    "Remote worldwide. Only candidates based in LATAM or the United States.",
  ])(
    "accepts a complete country-region union including Ecuador: %s",
    (text) => {
      const result = assess(text);
      expect(result.status).toBe("eligible");
      expect(result.blockers).toEqual([]);
    },
  );

  it.each([
    "Remote worldwide. Only candidates based in Brazil, CA or Ecuador.",
    "Remote worldwide. This role is open to candidates in the US and CA.",
    "Remote worldwide. Only candidates based in the US and APAC.",
  ])(
    "keeps unresolved codes and variable region lists for review: %s",
    (text) => {
      const result = assess(text);
      expect(result.status).toBe("review");
      expect(result.blockers).toEqual([]);
      expect(result.unknowns.join(" ")).toContain(
        "complete hiring-location list",
      );
    },
  );

  it.each(["North America", "Europe"])(
    "excludes Ecuador from an explicit US-and-Europe hiring list despite a %s source location",
    (location) => {
      const text =
        "We are a remote-first company. This role is open to candidates based in the US and Europe. You can work from anywhere within these regions.";
      expect(assess(text, "Ecuador", location).status).toBe("excluded");
      expect(assess(text, "Ecuador", location).blockers).toContain(
        "This role's stated hiring countries and regions do not include Ecuador.",
      );
      expect(assess(text, "United States", location).blockers).toEqual([]);
      expect(assess(text, "Germany", location).blockers).toEqual([]);
    },
  );

  it("understands a region before a country in the same explicit hiring list", () => {
    const text =
      "Remote worldwide. This role is open to candidates based in Europe or the United States.";
    expect(assess(text).status).toBe("excluded");
    expect(assess(text, "Germany").blockers).toEqual([]);
    expect(assess(text, "United States").blockers).toEqual([]);
  });

  it("does not let an incidental team mention hide an explicit residence requirement", () => {
    expect(
      assess(
        "Remote worldwide. You must be based in Brazil to join our team.",
      ).blockers.join(" "),
    ).toContain("Brazil");
  });
});

describe("country-first application shortlist", () => {
  it.each([
    "Bangalore",
    "Bengaluru, Karnataka",
    "Remote — Bangalore, India",
    "Remote — India",
    "Mumbai",
    "Remote — Tokyo",
    "Shanghai",
    "Manila",
    "Remote — Singapore",
    "Remote — Asia",
    "Remote — APAC",
    "Remote — EMEA",
  ])("excludes %s when working from Ecuador", (location) => {
    const result = assess(
      "Build software for our global customers.",
      "Ecuador",
      location,
    );
    expect(result.status).toBe("excluded");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it.each([
    ["Remote — Ecuador", "Build software."],
    ["Remote — Quito", "Build software."],
    ["Remote — LATAM", "Build software."],
    ["Remote — Americas", "Build software."],
    ["Remote · worldwide", "Build software."],
    ["Remote", "This is a fully remote worldwide role."],
    ["Remote", "Work remotely from anywhere in the world."],
  ])("accepts affirmative coverage: %s / %s", (location, description) => {
    expect(assess(description, "Ecuador", location).status).toBe("eligible");
  });

  it.each([
    ["Remote", "We are a global company. Build software."],
    ["Remote", "Join our global remote team."],
    ["Remote", "We serve customers worldwide."],
    ["Remote", "We have offices in Bangalore and Singapore."],
    ["Remote — Unmapped City", "We are fully remote worldwide."],
    ["Remote", "Hiring locations will be confirmed during interviews."],
  ])(
    "keeps unproven eligibility out of the shortlist: %s / %s",
    (location, description) => {
      expect(assess(description, "Ecuador", location).status).toBe("review");
    },
  );

  it("compares cities to the selected country instead of banning India", () => {
    expect(
      assess("Build software.", "India", "Remote — Bengaluru").status,
    ).toBe("eligible");
    expect(assess("Build software.", "Japan", "Remote — Tokyo").status).toBe(
      "eligible",
    );
    expect(assess("Build software.", "Germany", "Remote — Europe").status).toBe(
      "eligible",
    );
    expect(assess("Build software.", "India", "Remote — Ecuador").status).toBe(
      "excluded",
    );
  });

  it.each([
    "Remote worldwide. Candidates must be based in Bangalore.",
    "Remote worldwide. This role is based in Bengaluru.",
    "Remote worldwide. Only candidates in India may apply.",
    "Remote worldwide. Candidates must be based in APAC.",
    "Remote worldwide. Asia only.",
    "Remote worldwide. Work remotely from Asia Pacific only.",
    "Remote worldwide except Ecuador.",
  ])(
    "honors narrow restrictions over worldwide language: %s",
    (description) => {
      expect(assess(description).status).toBe("excluded");
    },
  );

  it("does not treat office cities or sales markets as hiring restrictions", () => {
    const description =
      "Fully remote worldwide. Our offices are in Bangalore. We serve customers in India and Asia.";
    expect(assess(description).status).toBe("eligible");
  });

  it("keeps contradictory explicit locations for review", () => {
    expect(assess("Remote worldwide. India only. Ecuador only.").status).toBe(
      "review",
    );
    expect(
      assess("Remote Latin America", "Ecuador", "Remote — India").status,
    ).toBe("review");
  });

  it("does not use a stale worldwide flag as affirmative eligibility", () => {
    expect(
      assessGeography(
        {
          location: "Remote",
          description: "We serve a global market.",
          remoteScope: "worldwide",
        },
        "Ecuador",
      ).status,
    ).toBe("review");
  });
});

describe("geography edge cases and stale classifications", () => {
  it.each([
    "Worldwide (Remote)",
    "Anywhere — Remote",
    "Remote — South America",
  ])(
    "accepts explicit location coverage in either word order: %s",
    (location) => {
      expect(assess("Build software.", "Ecuador", location).status).toBe(
        "eligible",
      );
    },
  );
  it("recognizes remotely as affirmative work mode", () => {
    expect(
      assess("Work remotely worldwide.", "Ecuador", "Worldwide").status,
    ).toBe("eligible");
  });
  it.each([
    "Remote anywhere in India.",
    "Work from anywhere within India.",
    "Remote from anywhere in Asia.",
  ])("does not promote country-limited anywhere wording: %s", (description) => {
    expect(assess(description).status).toBe("excluded");
  });
  it.each([
    "This role is remote worldwide.",
    "Fully remote. Candidates may work from Ecuador.",
  ])(
    "reviews specific permission conflicting with a foreign location: %s",
    (description) => {
      expect(assess(description, "Ecuador", "Bangalore").status).toBe("review");
    },
  );
  it.each(["Israel", "United Arab Emirates", "Kazakhstan"])(
    "does not assume %s is in an unspecified APAC hiring footprint",
    (country) => {
      expect(assess("Build software.", country, "Remote APAC").status).toBe(
        "review",
      );
    },
  );
  it.each([
    "Fully remote worldwide. This is a hybrid role in Bangalore.",
    "Fully remote worldwide. You must attend the office twice a week.",
  ])(
    "rechecks compulsory office presence on old records: %s",
    (description) => {
      expect(
        assessGeography(
          {
            location: "Remote worldwide",
            description,
            remoteScope: "worldwide",
          },
          "Ecuador",
        ).status,
      ).toBe("excluded");
    },
  );
});

describe("working hours versus country eligibility", () => {
  it.each([
    "Remote worldwide. Candidates must work in US time zones.",
    "Remote worldwide. Candidates must overlap US business hours.",
    "Remote worldwide. Required working hours are 9am to 5pm Pacific time.",
  ])(
    "keeps eligible countries visible while reviewing the schedule: %s",
    (description) => {
      const result = assess(description);
      expect(result.status).toBe("eligible");
      expect(result.blockers).toEqual([]);
      expect(result.unknowns).toContain(
        "Required working hours or time-zone overlap need confirmation.",
      );
    },
  );
  it("still reviews unresolved work authorization", () => {
    expect(
      assess("Remote worldwide. Work authorization is required.").status,
    ).toBe("review");
  });
});

describe("unrecognized location assertions cannot inherit worldwide eligibility", () => {
  it.each([
    "Applicants should be based in Bangalore.",
    "Residency in India is required.",
    "Location requirement: Bangalore.",
    "We can only consider applicants living in India.",
    "Candidates must be based in an unlisted city.",
    "This role requires Indian citizenship.",
  ])("requests review for unresolved hiring evidence: %s", (description) => {
    expect(assess(description, "Ecuador", "Remote worldwide").status).toBe(
      "review",
    );
  });
  it.each([
    "You will be based in Bangalore.",
    "This position is based out of Bangalore.",
    "This is a remote position for India residents.",
  ])("excludes concrete incompatible residency: %s", (description) => {
    expect(assess(description, "Ecuador", "Remote worldwide").status).toBe(
      "excluded",
    );
  });
  it.each([
    "Remote - Global",
    "Anywhere in the world",
    "Remote - Anywhere in the World",
  ])("accepts explicit global location labels: %s", (location) => {
    expect(assess("This is a remote role.", "Ecuador", location).status).toBe(
      "eligible",
    );
  });
});

describe("shared work-mode interpretation", () => {
  it.each([
    "On-site work is not required.",
    "Our other teams have hybrid work schedules.",
    "Candidates can work remotely worldwide or use a hybrid work schedule.",
  ])(
    "preserves worldwide remote eligibility for optional or unrelated attendance: %s",
    (description) => {
      expect(
        assessGeography(
          {
            location: "Remote worldwide",
            description,
            remoteScope: "worldwide",
          },
          "Ecuador",
        ).status,
      ).toBe("eligible");
    },
  );
  it("still excludes mandatory office attendance alongside optional wording", () => {
    const description =
      "Candidates can work remotely or use a hybrid work schedule, but must attend our office three days per week.";
    expect(
      assessGeography(
        { location: "Remote worldwide", description, remoteScope: "worldwide" },
        "Ecuador",
      ).status,
    ).toBe("excluded");
  });
  it.each([
    "This role is open to Indian nationals only.",
    "Supported countries: see our hiring policy.",
    "Candidates must work US hours. Applicants should be based in Bangalore.",
  ])("reviews unresolved legal and location constraints: %s", (description) => {
    expect(assess(description, "Ecuador", "Remote worldwide").status).toBe(
      "review",
    );
  });
});
