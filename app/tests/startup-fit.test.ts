import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessOpportunity,
  orderOpportunities,
  STARTUP_CONTRIBUTION_UNCONFIRMED,
} from "../src/domain/rules.js";
import { structuredAI } from "../src/server/ai.js";
import {
  assessWithAI,
  STARTUP_FIT_INSTRUCTIONS,
  validateFit,
} from "../src/server/fit.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/ai.js", () => ({ structuredAI: vi.fn() }));

const contribution = {
  summary:
    "Your work building internal TypeScript interfaces could transfer to the product's collaboration tools. Confirm whether the team needs interface engineering before outreach.",
  relevantEvidenceIds: ["demo-e1"],
  learningGaps: [],
  matches: [],
};

beforeEach(() => {
  vi.mocked(structuredAI).mockReset();
});

describe("startup contribution evidence", () => {
  it("ranks a relevant undated directory company ahead of unrelated fresh launches while preserving exclusions", () => {
    const workspace = demoWorkspace();
    workspace.preferences.dateMode = "strict";
    const directory = {
      ...demoOpportunities()[3],
      id: "directory",
      source: "seedcamp",
      publishedAt: null,
      description: "TypeScript and React developer tools.",
    };
    const launch = {
      ...demoOpportunities()[3],
      id: "launch",
      source: "hackernews",
      publishedAt: new Date().toISOString(),
      description: "Appointment scheduling for food service teams.",
    };
    const excluded = {
      ...directory,
      id: "excluded",
      publishedAt: "2000-01-01T00:00:00Z",
    };
    for (const op of [directory, launch, excluded])
      op.assessment = assessOpportunity(op, workspace.profile, workspace.preferences);
    expect(excluded.assessment!.recommendation).toBe("excluded");
    expect(orderOpportunities([launch, excluded, directory], workspace.preferences).map((op) => op.id)).toEqual([
      "directory", "launch", "excluded",
    ]);
    expect(directory.publishedAt).toBeNull();
  });

  it("uses bounded, aliased skill terms for research hints with traceable CV examples", () => {
    const workspace = demoWorkspace();
    const op = demoOpportunities()[3];
    op.description = "A Node.js workflow product with PostgreSQL storage.";
    const assessment = assessOpportunity(
      op,
      workspace.profile,
      workspace.preferences,
    );
    expect(assessment.startupFit).toEqual({
      method: "signals",
      status: "unconfirmed",
    });
    expect(assessment.relevantEvidenceIds).toEqual(["demo-e2"]);
    expect(assessment.fitSummary).toContain("Node.js");
    expect(assessment.fitSummary).toContain(
      "Confirm how that experience relates",
    );
    expect(assessment.unknowns).toContain(STARTUP_CONTRIBUTION_UNCONFIRMED);
    expect(assessment.score).toBe(40);
  });

  it("does not treat words containing skill names or credentials as applied experience", () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.facts!.evidence = [
      {
        ...workspace.profile.cache!.facts!.evidence[0],
        skills: ["C", "Go", "React"],
        category: "experience",
      },
      {
        ...workspace.profile.cache!.facts!.evidence[1],
        skills: ["PostgreSQL"],
        category: "education",
      },
    ];
    const op = {
      ...demoOpportunities()[3],
      description:
        "A Google product that tracks customer reactions in PostgreSQL.",
    };
    const assessment = assessOpportunity(
      op,
      workspace.profile,
      workspace.preferences,
    );
    expect(assessment.score).toBe(0);
    expect(assessment.relevantEvidenceIds).toEqual([]);
    expect(assessment.startupFit).toEqual({
      method: "none",
      status: "unconfirmed",
    });
    expect(assessment.fitSummary).toContain("not established");
  });

  it("evaluates product contributions independently of target job titles and preserves policy questions", async () => {
    const workspace = demoWorkspace();
    const op = {
      ...demoOpportunities()[3],
      title: "Orbit collaboration platform",
      companyCountry: "Unknown",
    };
    vi.mocked(structuredAI).mockResolvedValue(contribution);
    const result = await assessWithAI(op, workspace, "test-user");
    expect(structuredAI).toHaveBeenCalledOnce();
    const [schema, , instructions, payload] =
      vi.mocked(structuredAI).mock.calls[0];
    expect(instructions).toBe(STARTUP_FIT_INSTRUCTIONS);
    expect(instructions).toContain(
      "company description is not a job specification",
    );
    expect(payload).toMatchObject({
      opportunity: { title: op.title, signals: op.signals, requirements: [] },
    });
    expect(
      schema.safeParse({
        ...contribution,
        matches: [{ requirementId: "invented" }],
      }).success,
    ).toBe(false);
    expect(result.startupFit).toEqual({
      method: "semantic",
      status: "potential",
    });
    expect(result.fitSummary).toBe(contribution.summary);
    expect(result.relevantEvidenceIds).toEqual(["demo-e1"]);
    expect(result.unknowns).not.toContain(STARTUP_CONTRIBUTION_UNCONFIRMED);
    expect(result.unknowns).toContain(
      "Company headquarters country is not verified.",
    );
    expect(result.recommendation).toBe("review");
  });

  it("excludes skills lists and education from generated and accepted contribution citations", async () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.facts!.evidence.push(
      {
        ...workspace.profile.cache!.facts!.evidence[0],
        id: "listed",
        category: "skills",
      },
      {
        ...workspace.profile.cache!.facts!.evidence[0],
        id: "degree",
        category: "education",
      },
    );
    const op = demoOpportunities()[3];
    vi.mocked(structuredAI).mockResolvedValue(contribution);
    await assessWithAI(op, workspace, "test-user");
    const [schema, , , payload] = vi.mocked(structuredAI).mock.calls[0];
    expect(
      (payload as { evidence: Array<{ id: string }> }).evidence.map(
        (entry) => entry.id,
      ),
    ).not.toContain("listed");
    expect(
      (payload as { evidence: Array<{ id: string }> }).evidence.map(
        (entry) => entry.id,
      ),
    ).not.toContain("degree");
    expect(
      schema.safeParse({ ...contribution, relevantEvidenceIds: ["listed"] })
        .success,
    ).toBe(false);
    expect(() =>
      validateFit(
        { ...contribution, relevantEvidenceIds: ["degree"] },
        op,
        workspace,
      ),
    ).toThrow("unknown career facts");
  });

  it("does not display an unsupported positive contribution when the AI cites no CV example", async () => {
    vi.mocked(structuredAI).mockResolvedValue({
      ...contribution,
      relevantEvidenceIds: [],
      summary: "You are a perfect match.",
    });
    const result = await assessWithAI(
      demoOpportunities()[3],
      demoWorkspace(),
      "test-user",
    );
    expect(result.startupFit).toEqual({
      method: "semantic",
      status: "unconfirmed",
    });
    expect(result.fitSummary).toContain("not established");
    expect(result.fitSummary).not.toContain("perfect");
    expect(result.relevantEvidenceIds).toEqual([]);
    expect(result.unknowns).toContain(STARTUP_CONTRIBUTION_UNCONFIRMED);
    expect(result.recommendation).toBe("review");
  });

  it("keeps source-backed hints and an actionable failure when contribution analysis is unavailable", async () => {
    vi.mocked(structuredAI).mockRejectedValue(
      Object.assign(new Error("Reconnect ChatGPT under Account."), {
        code: "chatgpt_disconnected",
      }),
    );
    const result = await assessWithAI(
      demoOpportunities()[3],
      demoWorkspace(),
      "test-user",
    );
    expect(result.startupFit).toMatchObject({
      method: "signals",
      status: "unconfirmed",
      failureReason: "Reconnect ChatGPT under Account.",
    });
    expect(result.fitSummary).toContain("Confirm how that experience relates");
    expect(result.relevantEvidenceIds!.length).toBeGreaterThan(0);
    expect(result.recommendation).toBe("review");
  });

  it("does not request contribution inference from a CV containing only listed skills", async () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.facts!.evidence =
      workspace.profile.cache!.facts!.evidence.map((entry) => ({
        ...entry,
        category: "skills",
      }));
    const result = await assessWithAI(
      demoOpportunities()[3],
      workspace,
      "test-user",
    );
    expect(structuredAI).not.toHaveBeenCalled();
    expect(result.startupFit).toEqual({
      method: "none",
      status: "unconfirmed",
    });
    expect(result.fitSummary).toContain("skills list alone");
    expect(result.relevantEvidenceIds).toEqual([]);
  });
});
