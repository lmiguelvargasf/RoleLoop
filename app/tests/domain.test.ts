import { describe, expect, it } from "vitest";
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
import { PreferencesSchema } from "../src/shared/types.js";

const now = new Date("2026-11-05T17:00:00Z");
function setup() {
  const { profile, preferences } = demoWorkspace();
  return { profile, preferences, job: demoOpportunities(now)[0] };
}
describe("date windows", () => {
  it("includes today and uses the configured local day near UTC midnight", () => {
    const { preferences } = setup();
    expect(
      dateWindow(
        { ...preferences, lookback: 0 },
        new Date("2026-11-06T02:00:00Z"),
      ),
    ).toEqual({ start: "2026-11-05", end: "2026-11-05" });
    expect(
      localDay(new Date("2026-11-06T02:00:00Z"), preferences.timezone),
    ).toBe("2026-11-05");
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
    expect(a.recommendation).toBe("ready");
    expect(a.reasons.join(" ")).toContain("lower freshness");
  });
  it("records an invalid timezone without crashing the assessment", () => {
    const { profile, preferences, job } = setup();
    expect(
      assessOpportunity(
        job,
        profile,
        { ...preferences, timezone: "Invalid/Zone" },
        now,
      ).unknowns.join(" "),
    ).toContain("Invalid timezone");
  });
});
describe("evidence and eligibility", () => {
  it("matches the ready example using only verified evidence", () => {
    const { profile, preferences, job } = setup();
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.score).toBe(100);
    expect(result.recommendation).toBe("ready");
    profile.evidence.forEach((e) => (e.verified = false));
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
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.recommendation).toBe("review");
    expect(result.unknowns).toHaveLength(2);
  });
  it("flags a missing essential even when a low overall threshold allows it", () => {
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
      { ...preferences, minimumMatch: 30 },
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
    expect(result.matches[0].status).toBe("missing");
    expect(result.unknowns.join(" ")).toContain("independently");
  });
  it("marks absent structured requirements as not evaluated", () => {
    const { profile, preferences, job } = setup();
    job.requirements = [];
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.score).toBe(0);
    expect(result.unknowns.join(" ")).toContain("not evaluated");
  });
  it("treats startup relevance separately from job requirements", () => {
    const { profile, preferences } = setup();
    const startup = demoOpportunities(now)[3];
    const result = assessOpportunity(startup, profile, preferences, now);
    expect(result.reasons.join(" ")).toContain("not a job requirements score");
    expect(result.unknowns.join(" ")).toContain("exploratory startup lead");
    expect(result.unknowns.join(" ")).not.toContain(
      "Essential evidence coverage",
    );
  });
  it("uses selected industry phrases as transparent startup relevance signals", () => {
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
    expect(matching.score).toBe(unrelated.score + 20);
    expect(matching.reasons.join(" ")).toContain(
      "not verified company classification",
    );
    expect(unrelated.unknowns.join(" ")).toContain("selected industries");
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
    expect(a.reasons.join(" ")).toContain("No selected industry keyword");
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
          ).recommendation,
        ).toBe("ready");
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
      assessOpportunity(job, profile, preferences, now).recommendation,
    ).toBe("ready");
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
    profile.evidence.push({
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
    expect(draft.resume).toContain(profile.evidence[0].text);
    expect(draft.evidenceIds).not.toContain("fabricated");
    expect(draft.generator).toBe("templates");
    expect(draft.warnings.join(" ")).toContain("Sample data");
  });
  it("invalidates fingerprints when candidate facts or target facts change", () => {
    const { profile, job } = setup();
    const p = profileFingerprint(profile),
      o = opportunityFingerprint(job);
    profile.name = "Changed";
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
    profile.evidence = [];
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
