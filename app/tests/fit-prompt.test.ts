import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { structuredAI } from "../src/server/ai.js";
import {
  assessWithAI,
  FIT_PROMPT_VERSION,
  JOB_FIT_INSTRUCTIONS,
  STARTUP_FIT_INSTRUCTIONS,
  validateFit,
} from "../src/server/fit.js";
import type { Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/ai.js", () => ({ structuredAI: vi.fn() }));

function fitFor(job: Opportunity) {
  return {
    summary:
      "Relevant interface and service delivery; review the specific team responsibilities.",
    relevantEvidenceIds: ["demo-e1", "demo-e2"],
    learningGaps: [],
    matches: job.requirements.map((requirement, index) => ({
      requirementId: requirement.id,
      status: "matched" as const,
      evidenceIds: [index === 0 ? "demo-e1" : "demo-e2"],
      explanation: "The cited work demonstrates the requested capability.",
    })),
  };
}

beforeEach(() => {
  vi.mocked(structuredAI).mockReset();
});

describe("practical job-fit instructions and context", () => {
  it("supplies working-country and authoritative eligibility context with only verified facts", async () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    workspace.profile.cache!.facts!.evidence.push({
      ...workspace.profile.cache!.facts!.evidence[0],
      id: "unverified-claim",
      verified: false,
    });
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));

    const result = await assessWithAI(job, workspace, "test-user");

    expect(FIT_PROMPT_VERSION).toBe(5);
    expect(structuredAI).toHaveBeenCalledOnce();
    const call = vi.mocked(structuredAI).mock.calls[0];
    expect(call[2]).toBe(JOB_FIT_INSTRUCTIONS);
    expect(call[3]).toMatchObject({
      workingCountry: "Ecuador",
      targetRoles: workspace.preferences.roles,
      deterministicAssessment: {
        geography: { status: "eligible" },
        blockers: [],
      },
      opportunity: {
        title: job.title,
        location: job.location,
        remoteScope: job.remoteScope,
        description: job.description,
        requirements: job.requirements,
      },
    });
    const payload = call[3] as { evidence: Array<{ id: string }> };
    expect(payload.evidence.map((entry) => entry.id)).not.toContain(
      "unverified-claim",
    );
    expect(result.fitSummary).toBe(fitFor(job).summary);
  });

  it("constrains generated IDs and match count to the current job and resume", async () => {
    const job = demoOpportunities()[0];
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));
    await assessWithAI(job, demoWorkspace(), "test-user");
    const schema = vi.mocked(structuredAI).mock.calls[0][0];
    expect(schema.safeParse(fitFor(job)).success).toBe(true);
    for (const change of [
      { requirementId: "invented-requirement" },
      { evidenceIds: ["invented-evidence"] },
    ]) {
      const fit = fitFor(job);
      Object.assign(fit.matches[0], change);
      expect(schema.safeParse(fit).success).toBe(false);
    }
    expect(schema.safeParse({ ...fitFor(job), matches: [] }).success).toBe(false);
    expect(schema.safeParse({
      ...fitFor(job), relevantEvidenceIds: ["invented-evidence"],
    }).success).toBe(false);
  });

  it("keeps large-import schemas bounded while retaining runtime evidence validation", async () => {
    const job = demoOpportunities()[0];
    const workspace = demoWorkspace();
    const evidence = workspace.profile.cache!.facts!.evidence;
    evidence.push(...Array.from({ length: 450 }, (_, index) => ({
      ...evidence[0], id: `additional-fact-${index}`,
    })));
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));
    await assessWithAI(job, workspace, "test-user");
    const schema = vi.mocked(structuredAI).mock.calls[0][0];
    const serialized = JSON.stringify(z.toJSONSchema(schema));
    expect(serialized).not.toContain("additional-fact-449");
    expect(schema.safeParse(fitFor(job)).success).toBe(true);
    expect(() => validateFit({ ...fitFor(job), relevantEvidenceIds: ["invented"] }, job, workspace))
      .toThrow("unknown career facts");
  });

  it("passes source limits and policy uncertainty without a preliminary skill-based verdict", async () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.warnings = ["One career statement could not be traced and was omitted."];
    const job = demoOpportunities()[0];
    job.descriptionTruncated = true;
    job.requirementsTruncated = true;
    job.salaryMin = job.salaryMax = null;
    job.requirements[0].hard = true;
    job.requirements[0].skills = ["Rust"];
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));

    await assessWithAI(job, workspace, "test-user");

    const payload = vi.mocked(structuredAI).mock.calls[0][3] as {
      deterministicAssessment: { unknowns: string[]; recommendation?: string };
      opportunity: { descriptionTruncated: boolean; requirementsTruncated: boolean };
      resumeExtractionNotes: string[];
      evidence: Array<{ verified?: boolean; source?: unknown }>;
    };
    expect(payload.deterministicAssessment).not.toHaveProperty("recommendation");
    expect(payload.deterministicAssessment.unknowns).toContain("Salary is undisclosed.");
    expect(payload.deterministicAssessment.unknowns.join(" ")).not.toMatch(
      /Mandatory requirement|Verified experience covers|experience has only been partially evaluated/,
    );
    expect(payload.opportunity.descriptionTruncated).toBe(true);
    expect(payload.opportunity.requirementsTruncated).toBe(true);
    expect(payload.resumeExtractionNotes).toEqual(workspace.profile.cache!.warnings);
    expect(payload.evidence.every((entry) => !Object.hasOwn(entry, "verified") && !Object.hasOwn(entry, "source"))).toBe(true);
  });

  it.each([
    { description: "Remote worldwide. This role is India-only." },
    { salaryMin: 1000, salaryMax: 2000 },
  ])(
    "does not pay for fit analysis when a deterministic blocker exists: %j",
    async (patch) => {
      const result = await assessWithAI(
        { ...demoOpportunities()[0], ...patch },
        demoWorkspace(),
        "test-user",
      );
      expect(result.recommendation).toBe("excluded");
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(structuredAI).not.toHaveBeenCalled();
    },
  );

  it("evaluates career fit with unknown hiring geography while preserving review", async () => {
    const job: Opportunity = {
      ...demoOpportunities()[0],
      location: "Remote",
      description: "Build a TypeScript product for our global customers.",
      remoteScope: "unknown",
    };
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));
    const result = await assessWithAI(job, demoWorkspace(), "test-user");
    expect(result.recommendation).toBe("review");
    expect(result.geography?.status).toBe("review");
    expect(result.fitEvaluation).toMatchObject({
      method: "semantic",
      status: "complete",
    });
    expect(result.unknowns.length).toBeGreaterThan(0);
    expect(result.essentialScore).toBe(100);
    expect(result.fitSummary).toBe(fitFor(job).summary);
    expect(structuredAI).toHaveBeenCalledOnce();
    expect(vi.mocked(structuredAI).mock.calls[0][3]).toMatchObject({
      deterministicAssessment: { geography: { status: "review" } },
    });
    expect(JOB_FIT_INSTRUCTIONS).toContain("independently of that uncertainty");
  });

  it("does not pay for obviously unrelated roles", async () => {
    const job = { ...demoOpportunities()[0], title: "Senior Accountant" };
    await assessWithAI(job, demoWorkspace(), "test-user");
    expect(structuredAI).not.toHaveBeenCalled();
  });

  it("does not fabricate a completed comparison when requirements were not parsed", async () => {
    const job = { ...demoOpportunities()[0], requirements: [] };
    const result = await assessWithAI(job, demoWorkspace(), "test-user");
    expect(structuredAI).not.toHaveBeenCalled();
    expect(result.recommendation).toBe("review");
    expect(result.fitSummary).toBeUndefined();
    expect(result.unknowns.join(" ")).toMatch(/No structured requirements/);
    expect(result.fitEvaluation).toMatchObject({
      method: "none",
      status: "not_evaluated",
    });
  });

  it("requires verified career evidence for comparison", async () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.facts!.evidence.forEach(
      (entry) => (entry.verified = false),
    );
    const result = await assessWithAI(
      demoOpportunities()[0],
      workspace,
      "test-user",
    );
    expect(structuredAI).not.toHaveBeenCalled();
    expect(result.fitSummary).toBeUndefined();
  });

  it("cannot clear a salary unknown even when the model reports perfect capability matches", async () => {
    const job = {
      ...demoOpportunities()[0],
      salaryMin: null,
      salaryMax: null,
    };
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));
    const result = await assessWithAI(job, demoWorkspace(), "test-user");
    expect(structuredAI).toHaveBeenCalledOnce();
    expect(result.recommendation).toBe("review");
    expect(result.unknowns).toContain("Salary is undisclosed.");
    expect(result.essentialScore).toBe(100);
  });

  it("does not allow claimed AI matches to confirm mandatory tenure", async () => {
    const job = demoOpportunities()[0];
    job.requirements[0] = {
      ...job.requirements[0],
      text: "Must have 10 years of TypeScript and React experience",
      hard: true,
    };
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));
    const result = await assessWithAI(job, demoWorkspace(), "test-user");
    expect(structuredAI).toHaveBeenCalledOnce();
    expect(result.matches[0].status).toBe("partial");
    expect(result.recommendation).toBe("review");
    expect(result.unknowns.join(" ")).toContain(
      "Confirm this stated condition independently",
    );
  });

  it("uses a separate exploratory prompt for startup leads", async () => {
    const job = demoOpportunities()[3];
    vi.mocked(structuredAI).mockResolvedValue(fitFor(job));
    await assessWithAI(job, demoWorkspace(), "test-user");
    expect(vi.mocked(structuredAI).mock.calls[0][2]).toBe(
      STARTUP_FIT_INSTRUCTIONS,
    );
    expect(STARTUP_FIT_INSTRUCTIONS).toContain(
      "without implying there is an advertised vacancy",
    );
  });

  it("falls back to review when the AI output is unusable", async () => {
    const job = demoOpportunities()[0];
    vi.mocked(structuredAI).mockResolvedValue({ ...fitFor(job), summary: " " });
    const result = await assessWithAI(job, demoWorkspace(), "test-user");
    expect(result.recommendation).toBe("review");
    expect(result.fitSummary).toBeUndefined();
    expect(result.unknowns.join(" ")).toContain("AI fit is unavailable");
    expect(result.fitEvaluation?.failureReason).toContain("AI fit is unavailable");
  });

  it("retains an actionable account failure for discovery reporting", async () => {
    vi.mocked(structuredAI).mockRejectedValue(Object.assign(
      new Error("Reconnect ChatGPT under Account to continue."),
      { code: "chatgpt_disconnected" },
    ));
    const result = await assessWithAI(demoOpportunities()[0], demoWorkspace(), "test-user");
    expect(result.fitEvaluation?.failureReason).toBe("Reconnect ChatGPT under Account to continue.");
    expect(result.recommendation).toBe("review");
  });
});

describe("fit response evidence validation", () => {
  it("keeps requirement order stable and rejects duplicate or omitted comparisons", () => {
    const job = demoOpportunities()[0];
    const fit = fitFor(job);
    fit.matches.reverse();
    expect(validateFit(fit, job, demoWorkspace()).matches.map((match) => match.requirementId))
      .toEqual(job.requirements.map((requirement) => requirement.id));
    expect(() => validateFit({ ...fit, matches: [fit.matches[0], fit.matches[0], fit.matches[2]] }, job, demoWorkspace()))
      .toThrow("unknown career facts or requirements");
    expect(() => validateFit({ ...fit, matches: fit.matches.slice(1) }, job, demoWorkspace()))
      .toThrow("incomplete");
  });

  it("rejects blank resume facts just as the model input does", () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.facts!.evidence[0].text = "  ";
    expect(() => validateFit(fitFor(demoOpportunities()[0]), demoOpportunities()[0], workspace))
      .toThrow("unknown career facts");
  });

  it("accepts concise evidence with a limitation while rejecting long generated essays", () => {
    const job = demoOpportunities()[0];
    const fit = {
      ...fitFor(job),
      summary:
        "Your TypeScript delivery supports this role. Confirm the team's required ownership scope before applying.",
      learningGaps: ["Provide an example of owning a service through production."],
      matches: fitFor(job).matches.map((match) => ({
        ...match,
        status: "partial" as const,
        explanation:
          "Your cited TypeScript work supports implementation; full production ownership is not established.",
      })),
    };
    const result = validateFit(fit, job, demoWorkspace());
    expect(result.matches[0]).toMatchObject({
      status: "partial",
      evidenceIds: fit.matches[0].evidenceIds,
      explanation: fit.matches[0].explanation,
    });
    expect(result.learningGaps).toEqual(fit.learningGaps);
    expect(() =>
      validateFit(
        { ...fit, summary: "Repeated analysis. ".repeat(100) },
        job,
        demoWorkspace(),
      ),
    ).toThrow();
    expect(() =>
      validateFit(
        {
          ...fit,
          matches: fit.matches.map((match) => ({
            ...match,
            explanation: "Repeated supporting analysis. ".repeat(100),
          })),
        },
        job,
        demoWorkspace(),
      ),
    ).toThrow();
  });

  it("rejects empty explanations rather than keeping unexplained match claims", () => {
    const job = demoOpportunities()[0];
    const fit = fitFor(job);
    fit.matches[0].explanation = "  ";
    expect(() => validateFit(fit, job, demoWorkspace())).toThrow();
  });

  it("rejects conflicting missing-with-support claims", () => {
    const job = demoOpportunities()[0];
    const fit = {
      ...fitFor(job),
      matches: fitFor(job).matches.map((match) => ({
        ...match,
        status: "missing" as const,
      })),
    };
    expect(() => validateFit(fit, job, demoWorkspace())).toThrow(
      "supporting facts for a missing match",
    );
  });

  it("rejects unsupported evidence IDs in the application shortlist", () => {
    const job = demoOpportunities()[0];
    expect(() =>
      validateFit(
        { ...fitFor(job), relevantEvidenceIds: ["invented"] },
        job,
        demoWorkspace(),
      ),
    ).toThrow("unknown career facts");
  });
});
