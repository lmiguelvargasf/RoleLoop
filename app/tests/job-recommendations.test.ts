import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_RULES_VERSION,
  assessOpportunity,
  orderOpportunities,
  preferencesFingerprint,
} from "../src/domain/rules.js";
import { recommendationForJob } from "../src/shared/job-recommendations.js";
import { AssessmentSchema, type Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const now = new Date("2026-11-07T12:00:00Z");
function setup(patch: Partial<Opportunity> = {}) {
  const workspace = demoWorkspace();
  const job = { ...demoOpportunities(now)[0], ...patch };
  const assess = () => {
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
      now,
    );
  };
  assess();
  return {
    job,
    workspace,
    assess,
    result: () => recommendationForJob(job, workspace.preferences),
  };
}

describe("practical job recommendations", () => {
  it("explains semantic fit with the concrete career summary", () => {
    const candidate = setup();
    candidate.job.assessment!.fitEvaluation!.method = "semantic";
    candidate.job.assessment!.fitSummary =
      "You have built production backends and led full-stack delivery. Confirm compensation before applying.";
    expect(candidate.result().reason).toBe(
      "You have built production backends and led full-stack delivery.",
    );
  });

  it("ranks strong unresolved-country fit over a weak eligible job", () => {
    const strong = setup({
      id: "strong",
      location: "Remote",
      description: "Build software.",
      remoteScope: "unknown",
    });
    const weak = setup({ id: "weak" });
    weak.job.requirements[0].skills = ["Rust"];
    weak.assess();
    expect(strong.result().question).toBe("Confirm hiring from Ecuador.");
    expect(strong.result().recommendable).toBe(true);
    expect(
      orderOpportunities(
        [weak.job, strong.job],
        strong.workspace.preferences,
        now,
      )[0].id,
    ).toBe("strong");
  });

  it("uses country uncertainty meaningfully and salary uncertainty lightly", () => {
    const confirmed = setup({ id: "confirmed" });
    const salary = setup({ id: "salary", salaryMin: null, salaryMax: null });
    const location = setup({
      id: "location",
      location: "Remote",
      description: "Build software.",
      remoteScope: "unknown",
    });
    expect(confirmed.result().rankScore - salary.result().rankScore).toBe(2);
    expect(confirmed.result().rankScore - location.result().rankScore).toBe(12);
    expect(salary.result().recommendable).toBe(true);
    expect(salary.result().question).toMatch(/Salary/);
  });

  it("shows a missing essential capability before an undisclosed salary", () => {
    const candidate = setup({ salaryMin: null, salaryMax: null });
    candidate.workspace.preferences.essentialMatch = 60;
    candidate.job.requirements.push({
      id: "aws",
      text: "Operate AWS infrastructure",
      skills: ["AWS"],
      essential: true,
      hard: false,
    });
    candidate.assess();
    expect(candidate.result().recommendable).toBe(true);
    expect(candidate.result().question).toBe(
      "Required experience not evidenced: Operate AWS infrastructure.",
    );
    candidate.job.location = "Remote";
    candidate.job.description = "Build software.";
    candidate.job.remoteScope = "unknown";
    candidate.assess();
    expect(candidate.result().question).toBe("Confirm hiring from Ecuador.");
  });

  it.each([
    {
      location: "Bangalore, India",
      remoteScope: "unknown" as const,
      description: "Remote role based in India.",
    },
    {
      location: "North America only",
      remoteScope: "unknown" as const,
      description:
        "Remote role. Candidates must be based in the United States or Canada.",
    },
    { salaryMin: 20000, salaryMax: 30000 },
  ])("retains hard exclusions despite perfect skills: %j", (patch) => {
    const candidate = setup(patch);
    expect(candidate.job.assessment!.essentialScore).toBe(100);
    expect(candidate.result().recommendable).toBe(false);
  });

  it("respects the explicit undisclosed-salary exclusion policy", () => {
    const candidate = setup({ salaryMin: null, salaryMax: null });
    candidate.workspace.preferences.missingSalary = "exclude";
    candidate.assess();
    expect(candidate.result().recommendable).toBe(false);
  });

  it("does not show zero when requirements could not be evaluated", () => {
    for (const requirements of [
      [],
      [
        {
          id: "scope",
          text: "Own product outcomes",
          skills: [],
          essential: true,
          hard: false,
        },
      ],
    ]) {
      const candidate = setup({ requirements });
      expect(candidate.result().score).toBeNull();
      expect(candidate.result().fitLabel).toBe(
        requirements.length ? "Needs AI evaluation" : "Requirements unavailable",
      );
      expect(candidate.result().recommendable).toBe(false);
    }
    const candidate = setup();
    candidate.job.assessment = null;
    expect(candidate.result().score).toBeNull();
  });

  it("counts unassessed requirements against the minimum without presenting a percentage", () => {
    const candidate = setup();
    candidate.job.requirements.push({
      id: "scope",
      text: "Own product outcomes",
      skills: [],
      essential: true,
      hard: false,
    });
    candidate.assess();
    expect(candidate.result().fitLabel).toBe("Needs AI evaluation");
    expect(candidate.result().score).toBeNull();
    expect(candidate.result().recommendable).toBe(false);
    candidate.workspace.preferences.essentialMatch = 60;
    expect(candidate.result().recommendable).toBe(true);
    expect(candidate.result().reason).toContain("TypeScript and React");
    expect(candidate.result().question).toContain(
      "uses skill tags",
    );
  });

  it("never presents skill-tag fallback as a completed experience assessment", () => {
    const candidate = setup();
    expect(candidate.job.assessment!.fitEvaluation).toMatchObject({
      method: "skills", status: "partial",
    });
    expect(candidate.job.assessment!.recommendation).toBe("review");
    expect(candidate.result().score).toBeNull();
    expect(candidate.result().fitLabel).toBe("Needs AI evaluation");
    expect(candidate.result().question).toContain("skill tags");
    // Legacy complete skill snapshots must not expose a misleading score.
    candidate.job.assessment!.fitEvaluation!.status = "complete";
    expect(candidate.result().score).toBeNull();
  });

  it("explains why a percentage is unavailable instead of labeling every case partial", () => {
    const excluded = setup({ location: "United States", remoteScope: "us" });
    expect(excluded.result().fitLabel).toBe("Excluded by criteria");
    expect(excluded.result().score).toBeNull();

    const failed = setup();
    failed.job.assessment!.fitEvaluation!.failureReason = "AI request timed out.";
    expect(failed.result().fitLabel).toBe("Evaluation failed");
    expect(failed.result().score).toBeNull();

    const truncated = setup({ descriptionTruncated: true });
    expect(truncated.result().fitLabel).toBe("Incomplete job description");
    const requirements = setup({ requirementsTruncated: true });
    expect(requirements.result().fitLabel).toBe("Incomplete requirements");
  });

  it("uses preferred qualifications to break required-fit ties before freshness", () => {
    const supported = setup({ id: "supported", publishedAt: "2026-10-01T12:00:00Z" });
    const unsupported = setup({ id: "unsupported" });
    unsupported.job.requirements.find((entry) => !entry.essential)!.skills = ["AWS"];
    unsupported.assess();
    expect(supported.result().rankScore).toBe(unsupported.result().rankScore);
    expect(orderOpportunities([unsupported.job, supported.job], supported.workspace.preferences, now)[0].id).toBe("supported");
    expect(supported.result().recommendable).toBe(unsupported.result().recommendable);
  });

  it("does not let half of the requirements satisfy a strict match minimum", () => {
    const candidate = setup();
    candidate.workspace.preferences.essentialMatch = 85;
    candidate.job.requirements.push(...["scope", "outcomes"].map((id) => ({
      id, text: `Own ${id}`, skills: [], essential: true, hard: false,
    })));
    candidate.assess();
    expect(candidate.job.assessment!.fitEvaluation!.assessedRequired).toBe(2);
    expect(candidate.job.assessment!.fitEvaluation!.totalRequired).toBe(4);
    expect(candidate.result().recommendable).toBe(false);
    expect(candidate.result().rankScore).toBe(50);
  });

  it("accepts complete semantic evaluation without skill tags", () => {
    const candidate = setup({
      requirements: [
        {
          id: "scope",
          text: "Build operational tools",
          skills: [],
          essential: true,
          hard: false,
        },
      ],
    });
    candidate.job.assessment = assessOpportunity(
      candidate.job,
      candidate.workspace.profile,
      candidate.workspace.preferences,
      now,
      [
        {
          requirementId: "scope",
          requirement: "Build operational tools",
          essential: true,
          status: "matched",
          evidenceIds: ["demo-e1"],
          explanation: "Built an internal operations application.",
        },
      ],
    );
    expect(candidate.result().score).toBe(100);
    expect(candidate.result().recommendable).toBe(true);
    expect(candidate.job.assessment.fitEvaluation?.method).toBe("semantic");
  });

  it("does not let common skills certify specialist or leadership experience", () => {
    for (const title of [
      "Embedded Linux Senior Software Engineer",
      "Principal Software Engineer",
    ]) {
      const candidate = setup({ title });
      expect(candidate.job.assessment!.essentialScore).toBe(100);
      expect(candidate.result().score).toBeNull();
      expect(candidate.result().recommendable).toBe(false);
      expect(candidate.result().reason).toContain("not established");
    }
  });

  it("checks essential specialty experience even under a generalist title", () => {
    const candidate = setup();
    candidate.job.requirements.push({
      id: "embedded",
      text: "Build embedded firmware and kernel drivers with TypeScript tooling",
      skills: ["TypeScript"],
      essential: true,
      hard: false,
    });
    candidate.assess();
    expect(candidate.job.assessment!.essentialScore).toBe(100);
    expect(candidate.result().recommendable).toBe(false);
    expect(candidate.result().score).toBeNull();
    expect(candidate.result().reason).toContain("embedded");
  });

  it("does not substitute common skills for an unconfirmed mandatory credential", () => {
    const candidate = setup();
    candidate.workspace.preferences.essentialMatch = 70;
    candidate.job.requirements.push({
      id: "license",
      text: "Must hold a professional engineering license and use TypeScript",
      skills: ["TypeScript"],
      essential: true,
      hard: true,
    });
    candidate.assess();
    expect(candidate.job.assessment!.essentialScore).toBe(83);
    expect(candidate.result().recommendable).toBe(false);
  });

  it.each([
    [
      "Must hold a professional engineering license",
      "Licensed professional engineer, license PE-12345.",
      "certification",
    ],
    [
      "A computer science degree is required",
      "Bachelor of Science degree in computer science.",
      "education",
    ],
    [
      "A computer science degree or equivalent professional experience",
      "Built and maintained software applications for an operations team.",
      "experience",
    ],
  ] as const)(
    "accepts semantically supported credentials or stated alternatives: %s",
    (text, evidenceText, category) => {
      const candidate = setup({
        requirements: [
          { id: "credential", text, skills: [], essential: true, hard: true },
        ],
      });
      candidate.workspace.profile.cache!.facts!.evidence.push({
        id: "credential-proof",
        text: evidenceText,
        skills: [],
        category,
        verified: true,
        role: "",
        company: "",
        period: "",
      });
      candidate.job.assessment = assessOpportunity(
        candidate.job,
        candidate.workspace.profile,
        candidate.workspace.preferences,
        now,
        [
          {
            requirementId: "credential",
            requirement: text,
            essential: true,
            status: "matched",
            evidenceIds: ["credential-proof"],
            explanation: "The cited verified CV evidence meets this condition.",
          },
        ],
      );
      expect(candidate.job.assessment.matches[0].status).toBe("matched");
      expect(candidate.result().recommendable).toBe(true);
      expect(candidate.result().question).toBeUndefined();
    },
  );

  it("rejects semantic credential claims backed only by unrelated skill evidence", () => {
    const text =
      "Must hold a professional engineering license and use TypeScript";
    const candidate = setup({
      requirements: [
        {
          id: "license",
          text,
          skills: ["TypeScript"],
          essential: true,
          hard: true,
        },
      ],
    });
    candidate.job.assessment = assessOpportunity(
      candidate.job,
      candidate.workspace.profile,
      candidate.workspace.preferences,
      now,
      [
        {
          requirementId: "license",
          requirement: text,
          essential: true,
          status: "matched",
          evidenceIds: ["demo-e1"],
          explanation: "The model overstated related skills as a license.",
        },
      ],
    );
    expect(candidate.job.assessment.matches[0].status).toBe("partial");
    expect(candidate.result().recommendable).toBe(false);
  });

  it("does not confuse software licenses or API authorization with personal credentials", () => {
    const candidate = setup({
      requirements: [
        {
          id: "software",
          text: "Implement API authorization and manage open-source licenses using TypeScript",
          skills: ["TypeScript"],
          essential: true,
          hard: true,
        },
      ],
    });
    expect(candidate.job.assessment!.matches[0].status).toBe("matched");
    expect(candidate.result().recommendable).toBe(true);
  });

  it("retains tenure questions when the required experience otherwise fits", () => {
    const candidate = setup();
    candidate.workspace.preferences.essentialMatch = 70;
    candidate.job.requirements.push({
      id: "years",
      text: "At least 5 years of TypeScript experience",
      skills: ["TypeScript"],
      essential: true,
      hard: true,
    });
    candidate.assess();
    expect(candidate.result().recommendable).toBe(true);
    expect(candidate.result().question).toContain("5 years");
  });

  it("requires applied specialty evidence", () => {
    const candidate = setup({
      title: "Embedded Linux Senior Software Engineer",
    });
    candidate.workspace.profile.cache!.facts!.evidence.push({
      id: "embedded",
      text: "Developed embedded firmware and kernel drivers.",
      skills: ["Linux"],
      category: "skills",
      verified: true,
      role: "",
      company: "",
      period: "",
    });
    candidate.assess();
    expect(candidate.result().recommendable).toBe(false);
    candidate.workspace.profile.cache!.facts!.evidence.at(-1)!.category =
      "experience";
    candidate.assess();
    expect(candidate.result().recommendable).toBe(true);
  });

  it("lets a semantic assessment establish transferable leadership scope", () => {
    const candidate = setup({
      title: "Principal Software Engineer",
      requirements: [
        {
          id: "leadership",
          text: "Lead delivery of technical architecture",
          skills: [],
          essential: true,
          hard: false,
        },
      ],
    });
    candidate.job.assessment = assessOpportunity(
      candidate.job,
      candidate.workspace.profile,
      candidate.workspace.preferences,
      now,
      [
        {
          requirementId: "leadership",
          requirement: "Lead delivery of technical architecture",
          essential: true,
          status: "matched",
          evidenceIds: ["demo-e2"],
          explanation:
            "The verified work demonstrates the requested technical ownership.",
        },
      ],
    );
    expect(candidate.job.assessment.fitEvaluation?.concerns).toEqual([]);
    expect(candidate.result().recommendable).toBe(true);
  });

  it("does not let a rejected semantic match establish leadership scope", () => {
    const candidate = setup({
      title: "Principal Software Engineer",
      requirements: [{
        id: "leadership",
        text: "Lead architecture with a required professional certification",
        skills: ["React"], essential: true, hard: true,
      }],
    });
    candidate.job.assessment = assessOpportunity(
      candidate.job, candidate.workspace.profile, candidate.workspace.preferences, now,
      [{
        requirementId: "leadership",
        requirement: candidate.job.requirements[0].text,
        essential: true, status: "matched", evidenceIds: ["demo-e1"],
        explanation: "An overstated match against unrelated application experience.",
      }],
    );
    expect(candidate.job.assessment.matches[0].status).toBe("partial");
    expect(candidate.job.assessment.fitEvaluation!.concerns).toContain(
      "The role's leadership scope is not established in your CV.",
    );
  });

  it("keeps unrelated and explicitly lower-seniority roles out", () => {
    expect(setup({ title: "Civil Engineer" }).result().recommendable).toBe(
      false,
    );
    const candidate = setup({ title: "Junior Software Engineer" });
    candidate.workspace.preferences.roles = ["Senior Software Engineer"];
    candidate.assess();
    expect(candidate.result().recommendable).toBe(false);
    expect(candidate.result().reason).toContain("seniority");
  });

  it("uses freshness and industry only to break practical-fit ties", () => {
    const strong = setup({ id: "strong", publishedAt: "2026-07-01T12:00:00Z" });
    const weak = setup({
      id: "weak",
      description: "Developer tools. Fully remote worldwide.",
    });
    weak.job.requirements[0].skills = ["Rust"];
    weak.assess();
    expect(
      orderOpportunities(
        [weak.job, strong.job],
        strong.workspace.preferences,
        now,
      )[0].id,
    ).toBe("strong");
    const fresh = setup({ id: "fresh" });
    expect(
      orderOpportunities(
        [strong.job, fresh.job],
        strong.workspace.preferences,
        now,
      )[0].id,
    ).toBe("fresh");
  });

  it("does not fill a shortlist with unsupported jobs at a relaxed minimum", () => {
    const candidate = setup();
    candidate.workspace.preferences.essentialMatch = 0;
    candidate.job.requirements.forEach((req) => {
      req.skills = ["Rust"];
    });
    candidate.assess();
    expect(candidate.result().recommendable).toBe(false);
  });

  it("stamps current metadata and accepts legacy snapshots", () => {
    const candidate = setup();
    expect(candidate.job.assessment!.preferencesFingerprint).toBe(
      preferencesFingerprint(candidate.workspace.preferences),
    );
    expect(candidate.job.assessment!.rulesVersion).toBe(
      ASSESSMENT_RULES_VERSION,
    );
    const {
      fitEvaluation,
      preferencesFingerprint: _fingerprint,
      ...legacy
    } = candidate.job.assessment!;
    expect(AssessmentSchema.parse(legacy).fitEvaluation).toBeUndefined();
  });
});
