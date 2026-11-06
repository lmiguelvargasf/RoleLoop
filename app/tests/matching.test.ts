import { describe, expect, it } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { validateFit } from "../src/server/fit.js";
import { PreferencesSchema } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const now = new Date("2026-11-05T17:00:00Z");
function setup() {
  return { ...demoWorkspace(), job: demoOpportunities(now)[0] };
}

describe("required qualifications as the matching minimum", () => {
  it("keeps a job ready when required qualifications match but preferred skills do not", () => {
    const { job, profile, preferences } = setup();
    job.requirements[2].skills = ["AWS"];
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.essentialScore).toBe(100);
    expect(result.score).toBe(80);
    expect(result.recommendation).toBe("ready");
  });

  it("uses preferred skills for priority without changing readiness", () => {
    const { job, profile, preferences } = setup();
    const supported = assessOpportunity(job, profile, preferences, now);
    job.requirements[2].skills = ["AWS"];
    const unsupported = assessOpportunity(job, profile, preferences, now);
    expect(supported.score).toBeGreaterThan(unsupported.score);
    expect(supported.recommendation).toBe(unsupported.recommendation);
  });

  it("lets the user allow gaps while keeping mandatory requirements under review", () => {
    const { job, profile, preferences } = setup();
    job.requirements.push({
      id: "aws",
      text: "AWS infrastructure",
      skills: ["AWS"],
      essential: true,
      hard: false,
    });
    const relaxed = { ...preferences, essentialMatch: 60 };
    expect(assessOpportunity(job, profile, preferences, now).recommendation)
      .toBe("review");
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("ready");
    job.requirements.at(-1)!.hard = true;
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("review");
  });

  it("does not require confirmation of optional credentials to mark a job ready", () => {
    const { job, profile, preferences } = setup();
    job.requirements[2] = {
      id: "optional-degree",
      text: "Computer science degree preferred",
      skills: [],
      essential: false,
      hard: false,
    };
    const result = assessOpportunity(job, profile, preferences, now);
    expect(result.recommendation).toBe("ready");
    expect(result.matches[2].status).toBe("missing");
    job.requirements[2].essential = true;
    expect(assessOpportunity(job, profile, preferences, now).recommendation)
      .toBe("review");
  });

  it("does not let a relaxed minimum override hiring restrictions or missing evidence", () => {
    const { job, profile, preferences } = setup();
    const relaxed = { ...preferences, essentialMatch: 0 };
    job.remoteScope = "us";
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("excluded");
    job.remoteScope = "worldwide";
    profile.cache!.facts!.evidence.forEach((evidence) => { evidence.verified = false; });
    expect(assessOpportunity(job, profile, relaxed, now).recommendation)
      .toBe("review");
  });

  it("requires review when required qualifications could not be identified", () => {
    const { job, profile, preferences } = setup();
    job.requirements.forEach((requirement) => { requirement.essential = false; });
    expect(assessOpportunity(job, profile, preferences, now).recommendation)
      .toBe("review");
  });

  it("preserves the saved required minimum and discards the old overlapping minimum", () => {
    const { preferences } = setup();
    const migrated = PreferencesSchema.parse({ ...preferences, minimumMatch: 100 });
    expect(migrated.essentialMatch).toBe(preferences.essentialMatch);
    expect(migrated).not.toHaveProperty("minimumMatch");
  });
});

describe("listed claims and demonstrated experience", () => {
  it("keeps skill-list matches partial and mandatory conditions under review", () => {
    const { job, profile, preferences } = setup();
    profile.cache!.facts!.evidence.forEach((entry) => { entry.category = "skills"; });
    job.requirements[0].hard = true;
    const result = assessOpportunity(job, profile, { ...preferences, essentialMatch: 0 }, now);
    expect(result.matches[0].status).toBe("partial");
    expect(result.matches[0].explanation).toContain("no supporting example");
    expect(result.essentialScore).toBe(50);
    expect(result.recommendation).toBe("review");
    expect(result.unknowns.join(" ")).toContain("Mandatory requirement not confirmed");
  });

  it("requires applied evidence for every skill before reporting a full deterministic match", () => {
    const { job, profile, preferences } = setup();
    const first = profile.cache!.facts!.evidence[0];
    first.skills = ["TypeScript"];
    profile.cache!.facts!.evidence.push({
      ...first,
      id: "listed-react",
      text: "Skills: React",
      skills: ["React"],
      category: "skills",
    });
    expect(assessOpportunity(job, profile, preferences, now).matches[0].status).toBe("partial");
    const semantic = job.requirements.map((requirement) => ({
      requirementId: requirement.id,
      requirement: requirement.text,
      essential: requirement.essential,
      status: "matched" as const,
      evidenceIds: [first.id, "listed-react"],
      explanation: "Model overstates the listed React claim.",
    }));
    expect(assessOpportunity(job, profile, preferences, now, semantic).matches[0].status).toBe("partial");
    expect(validateFit({
      summary: "Related background", relevantEvidenceIds: [], learningGaps: [], matches: semantic,
    }, job, { ...demoWorkspace(), profile }).matches[0].status).toBe("partial");
    first.skills.push("React");
    expect(assessOpportunity(job, profile, preferences, now).matches[0].status).toBe("matched");
  });

  it("caps AI matches backed only by skill or language lists", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities(now)[0];
    workspace.profile.cache!.facts!.evidence[0].category = "language";
    const result = validateFit({
      summary: "Related background",
      relevantEvidenceIds: ["demo-e1"],
      learningGaps: [],
      matches: job.requirements.map((requirement) => ({
        requirementId: requirement.id,
        status: "matched",
        evidenceIds: ["demo-e1"],
        explanation: "A model mistakenly treated a list as applied experience.",
      })),
    }, job, workspace);
    expect(result.matches.every((match) => match.status === "partial")).toBe(true);
    const assessment = assessOpportunity(job, workspace.profile, workspace.preferences, now, result.matches);
    expect(assessment.matches.every((match) => match.status === "partial")).toBe(true);
  });

  it("does not present listed skills as startup contribution evidence or work history", () => {
    const { profile, preferences, job } = setup();
    profile.cache!.facts!.evidence = [{
      id: "listed-skills",
      text: "Skills: TypeScript, React, PostgreSQL",
      skills: ["TypeScript", "React", "PostgreSQL"],
      verified: true,
      category: "skills",
      role: "", company: "", period: "",
    }];
    const startup = demoOpportunities(now)[3];
    expect(assessOpportunity(startup, profile, preferences, now).score).toBe(0);
    const draft = createDraft(job, profile, preferences, assessOpportunity(job, profile, preferences, now));
    expect(draft.resume).toContain("LISTED SKILLS\n- Skills: TypeScript, React, PostgreSQL");
    expect(draft.resume).not.toContain("CAREER HIGHLIGHTS");
    expect(draft.resume).not.toContain("Relevant experience");
    expect(draft.body).toContain("Listed in my CV:");
    expect(draft.coverLetter).not.toContain("My experience");
  });

  it("renders grouped quotations together and preserves qualification headings", () => {
    const { profile, preferences, job } = setup();
    const evidence = profile.cache!.facts!.evidence;
    evidence[0].category = "experience";
    evidence[1] = { ...evidence[1], category: "experience", role: evidence[0].role, company: evidence[0].company, period: evidence[0].period };
    evidence[2].category = "education";
    profile.cache!.facts!.sections = [{
      id: "career-role", category: "experience", role: evidence[0].role,
      company: evidence[0].company, period: evidence[0].period,
      sourceText: evidence.slice(0, 2).map((entry) => entry.text).join("\n"),
      evidenceIds: [evidence[0].id, evidence[1].id],
    }];
    const assessment = assessOpportunity(job, profile, preferences, now);
    assessment.relevantEvidenceIds = evidence.map((entry) => entry.id);
    const draft = createDraft(job, profile, preferences, assessment);
    expect(draft.resume).toContain("EXPERIENCE\n");
    expect(draft.resume).toContain("EDUCATION\n");
    expect(draft.resume.split("Example Studio (fictional)")).toHaveLength(2);
    const role = draft.resume.split("EXPERIENCE\n")[1].split("\n\nEDUCATION")[0];
    expect(role).toContain(`- ${evidence[0].text}`);
    expect(role).toContain(`- ${evidence[1].text}`);
  });
});

