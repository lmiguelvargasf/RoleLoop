import { describe, expect, it, vi } from "vitest";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import {
  assessOpportunity,
  dateWindow,
  draftContentHash,
  localDay,
  opportunityFingerprint,
  preferencesFingerprint,
  profileFingerprint,
} from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { PreferencesSchema, ProfileSchema } from "../src/shared/types.js";

const now = new Date("2026-11-05T17:00:00Z");
function setup() {
  const { profile, preferences } = demoWorkspace();
  return { profile, preferences, job: demoOpportunities(now)[0] };
}
describe("date windows", () => {
  it("includes today and follows the computer's timezone near UTC midnight", () => {
    const { preferences } = setup();
    const nearMidnight = new Date("2026-11-06T02:00:00Z");
    try {
      vi.stubEnv("TZ", "America/Guayaquil");
      expect(dateWindow({ ...preferences, lookback: 0 }, nearMidnight)).toEqual(
        { start: "2026-11-05", end: "2026-11-05" },
      );
      expect(localDay(nearMidnight)).toBe("2026-11-05");
      vi.stubEnv("TZ", "UTC");
      expect(dateWindow({ ...preferences, lookback: 0 }, nearMidnight)).toEqual(
        { start: "2026-11-06", end: "2026-11-06" },
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("clamps a calendar-month subtraction to the last valid day", () => {
    const { preferences } = setup();
    expect(
      dateWindow(
        { ...preferences, lookback: 1, lookbackUnit: "months" },
        new Date("2026-03-31T17:00:00Z"),
      ),
    ).toEqual({ start: "2026-02-28", end: "2026-03-31" });
  });
  it("does not treat first discovery as original publication", () => {
    const { profile, preferences, job } = setup();
    job.publishedAt = null;
    const a = assessOpportunity(job, profile, preferences, now);
    expect(a.recommendation).toBe("review");
    expect(a.unknowns.join(" ")).toContain("Original posting date");
  });
  it("distinguishes strict exclusion from emphasis", () => {
    const { profile, preferences, job } = setup();
    job.publishedAt = "2025-01-01T17:00:00Z";
    expect(
      assessOpportunity(
        job,
        profile,
        { ...preferences, dateMode: "strict" },
        now,
      ).recommendation,
    ).toBe("excluded");
    const a = assessOpportunity(job, profile, preferences, now);
    expect(a.blockers).toEqual([]);
    expect(a.policyUnknowns).toEqual([]);
    expect(a.reasons.join(" ")).toContain("lower freshness");
  });
  it("discards legacy timezone settings when loading saved preferences", () => {
    const { preferences } = setup();
    expect(
      PreferencesSchema.parse({ ...preferences, timezone: "Invalid/Zone" }),
    ).toEqual(preferences);
  });
});
describe("evidence and eligibility", () => {
  it("excludes a source deadline at its expiry instant and fingerprints extensions", () => {
    const { profile, preferences, job } = setup();
    job.sourceExpiresAt = now.toISOString();
    const expired = assessOpportunity(job, profile, preferences, now);
    expect(expired.recommendation).toBe("excluded");
    expect(expired.blockers).toContain("The source's application deadline has passed.");
    const fingerprint = opportunityFingerprint(job);
    job.sourceExpiresAt = new Date(now.getTime() + 1000).toISOString();
    expect(opportunityFingerprint(job)).not.toBe(fingerprint);
    expect(assessOpportunity(job, profile, preferences, now).blockers).toEqual([]);
  });
  it("loads existing profiles without retaining duplicate location fields", () => {
    const { profile } = setup();
    expect(
      ProfileSchema.parse({
        ...profile,
        location: "Quito, Ecuador",
        country: "Ecuador",
      }),
    ).toEqual(profile);
  });
  it.each([
    ["us", "Ecuador", "United States", "excluded"],
    ["us", "United States", "Ecuador", "review"],
    ["latam", "Ecuador", "Canada", "review"],
    ["latam", "Canada", "Ecuador", "excluded"],
  ] as const)(
    "checks %s eligibility using preference %s despite legacy profile country %s",
    (remoteScope, country, legacyCountry, recommendation) => {
      const { profile, preferences, job } = setup();
      job.remoteScope = remoteScope;
      preferences.country = country;
      const legacyProfile = { ...profile, country: legacyCountry };
      const result = assessOpportunity(job, legacyProfile, preferences, now);
      expect(result.recommendation).toBe(recommendation);
      expect(result.unknowns.join(" ")).not.toContain("Profile country");
    },
  );
  it("requires a working country in preferences even if the old profile has one", () => {
    const { profile, preferences, job } = setup();
    preferences.country = "";
    const legacyProfile = { ...profile, country: "Ecuador" };
    const result = assessOpportunity(job, legacyProfile, preferences, now);
    expect(result.recommendation).toBe("review");
    expect(result.unknowns).toContain("Your working country is missing.");
  });
  it("keeps a skill-only comparison in review using only verified evidence", () => {
    const { profile, preferences, job } = setup();
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.score).toBe(100);
    expect(result.recommendation).toBe("review");
    expect(result.fitEvaluation?.status).toBe("partial");
    expect(result.policyUnknowns).toEqual([]);
    profile.cache!.facts!.evidence.forEach((e) => (e.verified = false));
    expect(assessOpportunity(job, profile, preferences, now).score).toBe(0);
  });
  it("does not let a high match override a US-only restriction", () => {
    const { profile, preferences, job } = setup();
    job.remoteScope = "us";
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.score).toBe(100);
    expect(result.recommendation).toBe("excluded");
    expect(result.blockers.join(" ")).toContain("United States");
  });
  it("keeps unknown headquarters and hiring eligibility unresolved", () => {
    const { profile, preferences, job } = setup();
    job.companyCountry = "Unknown";
    job.remoteScope = "unknown";
    job.location = "Remote";
    job.description = "Build software for our customers.";
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.recommendation).toBe("review");
    expect(result.geography?.status).toBe("review");
    expect(result.unknowns).toContain(
      "Company headquarters country is not verified.",
    );
    expect(result.unknowns.join(" ")).toContain(
      "does not confirm remote hiring",
    );
  });
  it("still flags mandatory requirements with a relaxed matching minimum", () => {
    const { profile, preferences, job } = setup();
    job.requirements.push({
      id: "security",
      text: "AWS experience",
      skills: ["AWS"],
      essential: true,
      hard: true,
    });
    const result = assessOpportunity(
      job,
      profile,
      { ...preferences, essentialMatch: 30 },
      now,
    );
    expect(result.recommendation).toBe("review");
    expect(result.unknowns.join(" ")).toContain("Mandatory requirement");
  });
  it("does not infer years of experience from matching skill labels", () => {
    const { profile, preferences, job } = setup();
    job.requirements = [
      {
        id: "tenure",
        text: "Minimum 8 years of React experience",
        skills: ["React"],
        essential: true,
        hard: true,
      },
    ];
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.matches[0].status).toBe("partial");
    expect(result.unknowns.join(" ")).toContain("independently");
  });
  it("marks absent structured requirements as not evaluated", () => {
    const { profile, preferences, job } = setup();
    job.requirements = [];
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.score).toBe(0);
    expect(result.fitEvaluation?.status).toBe("not_evaluated");
  });
  it("treats startup relevance separately from job requirements", () => {
    const { profile, preferences } = setup();
    const startup = demoOpportunities(now)[3];
    const result = assessOpportunity(startup, profile, preferences, now);
    expect(result.reasons.join(" ")).toContain("not a job requirements score");
    expect(result.unknowns.join(" ")).toContain("exploratory startup lead");
    expect(result.unknowns.join(" ")).not.toContain("your minimum is");
  });
  it("reports preferred industries without changing startup skill relevance or blocking other industries", () => {
    const { profile, preferences } = setup();
    const startup = demoOpportunities(now)[3];
    startup.description += " We build developer-tools.";
    const matching = assessOpportunity(
      startup,
      profile,
      { ...preferences, industries: ["Developer tools"] },
      now,
    );
    const unrelated = assessOpportunity(
      startup,
      profile,
      { ...preferences, industries: ["Healthcare"] },
      now,
    );
    expect(matching.score).toBe(unrelated.score);
    expect(matching.reasons.join(" ")).toContain(
      "not verified company classification",
    );
    expect(unrelated.unknowns.join(" ")).not.toContain("selected industries");
    expect(unrelated.blockers).toEqual(matching.blockers);
    expect(matching.recommendation).toBe("review");
  });
  it("does not infer an industry from a substring or change job coverage for industry preferences", () => {
    const { profile, preferences, job } = setup();
    const startup = demoOpportunities(now)[3];
    startup.description = "React software to facilitate remote teams";
    const a = assessOpportunity(
      startup,
      profile,
      { ...preferences, industries: ["AI"] },
      now,
    );
    expect(a.reasons.join(" ")).not.toContain("Preferred industry signal");
    expect(
      assessOpportunity(
        job,
        profile,
        { ...preferences, industries: ["Healthcare"] },
        now,
      ).score,
    ).toBe(
      assessOpportunity(job, profile, { ...preferences, industries: [] }, now)
        .score,
    );
  });
});
describe("salary policies", () => {
  it("defaults older saved preferences to no salary flexibility", () => {
    const { salaryFlexibility, ...older } = setup().preferences;
    expect(PreferencesSchema.parse(older).salaryFlexibility).toBe(false);
  });
  it.each(["overlap", "strict"] as const)(
    "keeps the 10%% allowance opt-in and review-only with the %s policy",
    (salaryPolicy) => {
      const { profile, preferences, job } = setup();
      const prefs = { ...preferences, minimumSalary: 108000, salaryPolicy };
      job.salaryMin = job.salaryMax = 100000;
      expect(assessOpportunity(job, profile, prefs, now).recommendation).toBe(
        "excluded",
      );
      const flexible = assessOpportunity(
        job,
        profile,
        { ...prefs, salaryFlexibility: true },
        now,
      );
      expect(flexible.recommendation).toBe("review");
      expect(flexible.unknowns.join(" ")).toContain(
        "Below your minimum; consider benefits",
      );
      expect(flexible.blockers).toEqual([]);
      expect(prefs.minimumSalary).toBe(108000);
    },
  );
  it.each(["overlap", "strict"] as const)(
    "includes the exact 10%% boundary and excludes a cent below it with %s",
    (salaryPolicy) => {
      const { profile, preferences, job } = setup();
      const prefs = {
        ...preferences,
        minimumSalary: 108000,
        salaryPolicy,
        salaryFlexibility: true,
      };
      for (const [salary, recommendation] of [
        [97199.99, "excluded"],
        [97200, "review"],
        [108000, "review"],
        [200000, "review"],
      ] as const) {
        job.salaryMin = job.salaryMax = salary;
        expect(assessOpportunity(job, profile, prefs, now).recommendation).toBe(
          recommendation,
        );
        if (salary >= prefs.minimumSalary)
          expect(assessOpportunity(job, profile, prefs, now).policyUnknowns).toEqual([]);
      }
    },
  );
  it("compares the selected end of the range when flexibility is enabled", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = 90000;
    job.salaryMax = 100000;
    const prefs = {
      ...preferences,
      minimumSalary: 108000,
      salaryFlexibility: true,
    };
    expect(assessOpportunity(job, profile, prefs, now).recommendation).toBe(
      "review",
    );
    expect(
      assessOpportunity(job, profile, { ...prefs, salaryPolicy: "strict" }, now)
        .recommendation,
    ).toBe("excluded");
    job.salaryMin = 100000;
    job.salaryMax = 120000;
    expect(
      assessOpportunity(job, profile, { ...prefs, salaryPolicy: "strict" }, now)
        .recommendation,
    ).toBe("review");
  });
  it.each(["overlap", "strict"] as const)(
    "applies flexibility to annualized monthly pay with %s",
    (salaryPolicy) => {
      const { profile, preferences, job } = setup();
      job.salaryMin = job.salaryMax = 8100;
      job.salaryPeriod = "month";
      const prefs = {
        ...preferences,
        minimumSalary: 108000,
        salaryPolicy,
        salaryFlexibility: true,
      };
      expect(assessOpportunity(job, profile, prefs, now).recommendation).toBe(
        "review",
      );
      job.salaryMin = job.salaryMax = 8099.99;
      expect(assessOpportunity(job, profile, prefs, now).recommendation).toBe(
        "excluded",
      );
    },
  );
  it("keeps undisclosed pay under the separate missing-salary policy", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = job.salaryMax = null;
    for (const [missingSalary, recommendation] of [
      ["review", "review"],
      ["exclude", "excluded"],
    ] as const) {
      const result = assessOpportunity(
        job,
        profile,
        { ...preferences, salaryFlexibility: true, missingSalary },
        now,
      );
      expect(result.recommendation).toBe(recommendation);
      expect(result.unknowns.join(" ")).not.toContain("10% salary flexibility");
    }
  });
  it("converts the removed missing-salary option to review and requires a pay check", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = job.salaryMax = null;
    const normalized = PreferencesSchema.parse({
      ...preferences,
      missingSalary: "include",
    });
    expect(normalized.missingSalary).toBe("review");
    const result = assessOpportunity(job, profile, normalized, now);
    expect(result.recommendation).toBe("review");
    expect(result.unknowns).toContain("Salary is undisclosed.");
  });
  it("does not let salary flexibility bypass other exclusion rules", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = job.salaryMax = 100000;
    job.remoteScope = "us";
    const result = assessOpportunity(
      job,
      profile,
      { ...preferences, minimumSalary: 108000, salaryFlexibility: true },
      now,
    );
    expect(result.recommendation).toBe("excluded");
    expect(result.blockers.join(" ")).toContain("United States");
  });
  it("accepts an unset target and preserves existing targets", () => {
    const { preferences } = setup();
    expect(PreferencesSchema.parse(preferences).targetSalary).toBe(120000);
    expect(
      PreferencesSchema.parse({ ...preferences, targetSalary: null })
        .targetSalary,
    ).toBeNull();
    const { targetSalary, ...minimumOnly } = preferences;
    expect(PreferencesSchema.parse(minimumOnly).targetSalary).toBeNull();
  });
  it.each([null, 120000])(
    "keeps higher-paying roles eligible with target %s",
    (targetSalary) => {
      const { profile, preferences, job } = setup();
      job.salaryMin = 180000;
      job.salaryMax = 250000;
      for (const salaryPolicy of ["overlap", "strict"] as const) {
        expect(
          assessOpportunity(
            job,
            profile,
            { ...preferences, targetSalary, salaryPolicy },
            now,
          ).policyUnknowns,
        ).toEqual([]);
      }
    },
  );
  it("routes overlapping salary to negotiation, rather than claiming the floor is guaranteed", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = 80000;
    job.salaryMax = 140000;
    expect(
      assessOpportunity(job, profile, preferences, now).unknowns.join(" "),
    ).toContain("negotiation");
    expect(
      assessOpportunity(
        job,
        profile,
        { ...preferences, salaryPolicy: "strict" },
        now,
      ).recommendation,
    ).toBe("excluded");
  });
  it("normalizes monthly USD but does not guess contracted hours or currency rates", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = 10000;
    job.salaryMax = 12000;
    job.salaryPeriod = "month";
    expect(
      assessOpportunity(job, profile, preferences, now).policyUnknowns,
    ).toEqual([]);
    job.salaryPeriod = "hour";
    expect(
      assessOpportunity(job, profile, preferences, now).unknowns.join(" "),
    ).toContain("contracted hours");
    job.salaryCurrency = "EUR";
    expect(
      assessOpportunity(job, profile, preferences, now).unknowns.join(" "),
    ).toContain("exchange rate");
  });
  it("honors missing-salary exclusion without inventing a range", () => {
    const { profile, preferences, job } = setup();
    job.salaryMin = job.salaryMax = null;
    expect(
      assessOpportunity(
        job,
        profile,
        { ...preferences, missingSalary: "exclude" },
        now,
      ).recommendation,
    ).toBe("excluded");
  });
});
describe("truthful drafts and change fingerprints", () => {
  it.each(["job", "startup"] as const)(
    "uses the preferences country for %s drafts despite legacy profile location fields",
    (kind) => {
      const { profile, preferences, job } = setup();
      job.kind = kind;
      preferences.country = "Canada";
      const legacyProfile = {
        ...profile,
        country: "Ecuador",
        location: "Quito, Ecuador",
      };
      const draft = createDraft(
        job,
        legacyProfile,
        preferences,
        assessOpportunity(job, legacyProfile, preferences, now),
      );
      expect(draft.resume).toContain("Canada · alex@example.com");
      expect(draft.body).toContain("based in Canada");
      expect(draft.resume + draft.body).not.toContain("Ecuador");
      if (kind === "job") {
        expect(
          draft.answers.find((a) => a.question === "Where are you based?")
            ?.answer,
        ).toBe("Canada");
      }
    },
  );
  it.each(["job", "startup"] as const)(
    "does not invent a location when the working country is blank for a %s draft",
    (kind) => {
      const { profile, preferences, job } = setup();
      job.kind = kind;
      preferences.country = "   ";
      const draft = createDraft(
        job,
        profile,
        preferences,
        assessOpportunity(job, profile, preferences, now),
      );
      expect(draft.body).not.toContain("based in");
      expect(draft.resume).toContain(
        "\nalex@example.com · https://example.com/alex",
      );
      expect(draft.warnings).toContain("Your working country is missing.");
      if (kind === "job") {
        expect(
          draft.answers.find((a) => a.question === "Where are you based?")
            ?.answer,
        ).toBe("To confirm.");
      }
    },
  );
  it.each([null, 120000, 0])(
    "uses target %s for salary answers without volunteering the minimum",
    (targetSalary) => {
      const { profile, preferences, job } = setup();
      preferences.targetSalary = targetSalary;
      if (targetSalary === 0) preferences.minimumSalary = 0;
      const draft = createDraft(
        job,
        profile,
        preferences,
        assessOpportunity(job, profile, preferences, now),
      );
      const answer = draft.answers.find((a) =>
        a.question.includes("salary expectations"),
      )?.answer;
      if (targetSalary === null) {
        expect(answer).toContain("open to discussing base compensation");
        expect(answer).not.toContain("90,000");
      } else {
        expect(answer).toContain(
          `My target is USD ${targetSalary.toLocaleString("en-US")}`,
        );
      }
    },
  );
  it("omits unverified experience and keeps supplied achievements exact", () => {
    const { profile, preferences, job } = setup();
    profile.cache!.facts!.evidence.push({
      id: "fabricated",
      text: "Increased revenue by 900 percent",
      skills: ["React"],
      verified: false,
      role: "",
      company: "",
      period: "",
    });
    const draft = createDraft(
      job,
      profile,
      preferences,
      assessOpportunity(job, profile, preferences, now),
    );
    expect(draft.resume).not.toContain("900 percent");
    expect(draft.resume).toContain(profile.cache!.facts!.evidence[0].text);
    expect(draft.evidenceIds).not.toContain("fabricated");
    expect(draft.generator).toBe("templates");
    expect(draft.warnings.join(" ")).toContain("Sample data");
  });
  it("invalidates fingerprints when candidate facts or target facts change", () => {
    const { profile, job } = setup();
    const p = profileFingerprint(profile),
      o = opportunityFingerprint(job);
    profile.cache!.facts!.name = "Changed";
    job.description += " A new condition.";
    expect(profileFingerprint(profile)).not.toBe(p);
    expect(opportunityFingerprint(job)).not.toBe(o);
  });
  it("binds the draft to preferences including pay and eligibility thresholds", () => {
    const { profile, preferences, job } = setup();
    const d = createDraft(
      job,
      profile,
      preferences,
      assessOpportunity(job, profile, preferences, now),
    );
    expect(d.preferencesFingerprint).toBe(preferencesFingerprint(preferences));
    preferences.minimumSalary += 10000;
    expect(preferencesFingerprint(preferences)).not.toBe(
      d.preferencesFingerprint,
    );
    const revised = preferencesFingerprint(preferences);
    preferences.essentialMatch -= 5;
    expect(preferencesFingerprint(preferences)).not.toBe(revised);
  });
  it("approval state does not change content hash but edited text does", () => {
    const { profile, preferences, job } = setup();
    const d = createDraft(
      job,
      profile,
      preferences,
      assessOpportunity(job, profile, preferences, now),
    );
    const h = draftContentHash(d);
    d.status = "approved";
    expect(draftContentHash(d)).toBe(h);
    d.body += " A changed sentence.";
    expect(draftContentHash(d)).not.toBe(h);
  });
  it("refuses drafting without verified evidence", () => {
    const { profile, preferences, job } = setup();
    profile.cache!.facts!.evidence = [];
    expect(() =>
      createDraft(
        job,
        profile,
        preferences,
        assessOpportunity(job, profile, preferences, now),
      ),
    ).toThrow("verified");
  });
});
