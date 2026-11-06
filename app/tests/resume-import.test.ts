import { afterEach, expect, it, vi } from "vitest";
import {
  validateExtraction,
  extractResume,
  validateWordArchive,
} from "../src/server/resume-import.js";
import { structuredAI } from "../src/server/ai.js";
import { settings } from "../src/server/config.js";
import { validateFit } from "../src/server/fit.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { demoWorkspace, demoOpportunities } from "./fixtures.js";
import { z } from "zod";
const originalKey = settings.openaiKey;
afterEach(() => {
  vi.unstubAllGlobals();
  settings.openaiKey = originalKey;
});
const extracted = () => ({
  name: "Alex",
  portfolio: "",
  skills: ["TypeScript"],
  uncertainties: [],
  entries: [
    {
      text: "Built TypeScript services.",
      role: "Engineer",
      company: "Studio",
      period: "2022",
      skills: ["TypeScript"],
      category: "experience" as const,
    },
  ],
});
it("keeps only source quotations, available only when traced to the source", () => {
  const result = extracted();
  result.entries.push({ ...result.entries[0], text: "Invented claim" });
  const parsed = validateExtraction(
    result,
    "Alex Engineer Studio 2022 Built TypeScript services.",
  );
  expect(parsed.facts.evidence).toHaveLength(1);
  expect(parsed.facts.evidence[0].verified).toBe(true);
  expect(parsed.warnings.join(" ")).toContain("could not be traced");
  expect(() => validateExtraction(result, "Unrelated source")).toThrow(
    "No career details",
  );
});
it("rejects unsupported, corrupt and oversized documents before AI", async () => {
  await expect(extractResume("file.exe", Buffer.from("abc"))).rejects.toThrow(
    ".pdf or .docx",
  );
  await expect(
    extractResume("cv.pdf", Buffer.alloc(2 * 1024 * 1024 + 1)),
  ).rejects.toThrow("2 MB");
  await expect(
    extractResume("cv.pdf", Buffer.from("not a PDF")),
  ).rejects.toThrow("could not be opened");
  await expect(
    extractResume("cv.docx", Buffer.from("not Word")),
  ).rejects.toThrow("could not be opened");
});
it("rejects a Word ZIP bomb before decompression", () => {
  const buffer = Buffer.alloc(68);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt32LE(100_000_000, 24);
  buffer.writeUInt32LE(0x06054b50, 46);
  buffer.writeUInt16LE(1, 56);
  expect(() => validateWordArchive(buffer)).toThrow("too large");
});
it("uses strict structured hosted output with storage disabled", async () => {
  settings.openaiKey = "test-only";
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          { content: [{ type: "output_text", text: '{"value":"ok"}' }] },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await structuredAI(
      z.object({ value: z.string() }),
      "test",
      "Instructions",
      {},
    ),
  ).toEqual({ value: "ok" });
  expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    store: false,
    text: { format: { strict: true } },
  });
});
it("rejects incomplete AI responses", async () => {
  settings.openaiKey = "test-only";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "incomplete" })),
      ),
  );
  await expect(
    structuredAI(z.object({ value: z.string() }), "test", "Instructions", {}),
  ).rejects.toThrow("could not finish");
});
it("requires existing evidence IDs and complete requirement coverage", () => {
  const workspace = demoWorkspace(),
    job = demoOpportunities()[0];
  const fit = {
    summary: "Fit",
    relevantEvidenceIds: [workspace.profile.cache!.facts!.evidence[0].id],
    learningGaps: [],
    matches: job.requirements.map((r) => ({
      requirementId: r.id,
      evidenceIds: [workspace.profile.cache!.facts!.evidence[0].id],
      status: "partial" as const,
      explanation: "Transferable experience",
    })),
  };
  expect(validateFit(fit, job, workspace).matches).toHaveLength(
    job.requirements.length,
  );
  fit.matches[0].evidenceIds = ["invented"];
  expect(() => validateFit(fit, job, workspace)).toThrow(
    "unknown career facts",
  );
  fit.matches[0].evidenceIds = [];
  expect(() => validateFit(fit, job, workspace)).toThrow("no supporting");
});
it("ignores retired positioning and learning fields in matching and drafts", () => {
  const workspace = demoWorkspace(),
    job = demoOpportunities()[0];
  const legacy = {
    ...workspace.profile,
    headline: "Outdated headline",
    summary: "Outdated summary",
    learning: "Learning Vue in a personal project",
  };
  job.requirements[0].skills = ["Vue"];
  const assessment = assessOpportunity(
    job,
    workspace.profile,
    workspace.preferences,
  );
  expect(assessment.matches[0].status).toBe("missing");
  const draft = createDraft(job, legacy, workspace.preferences, assessment);
  expect(draft.resume).not.toContain("CURRENTLY LEARNING");
  expect(draft.resume).not.toContain("Outdated");
  expect(draft.resume).toContain(`Application: ${job.title}`);
  expect(draft.resume).toContain(
    workspace.profile.cache!.facts!.evidence[0].text,
  );
  expect(
    draft.resume.split("SKILLS\n")[1].split("CURRENTLY LEARNING")[0],
  ).not.toContain("Vue");
});

it("reports missing OpenAI configuration without attempting any fallback requests", async () => {
  settings.openaiKey = "";
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    structuredAI(z.object({ value: z.string() }), "test", "Instructions", {}),
  ).rejects.toMatchObject({ statusCode: 503 });
  expect(fetcher).not.toHaveBeenCalled();
});
it("discards retired provider preferences while preserving search settings", async () => {
  const { PreferencesSchema } = await import("../src/shared/types.js");
  const preferences = demoWorkspace().preferences;
  expect(
    PreferencesSchema.parse({
      ...preferences,
      modelMode: "ollama",
      ollamaModel: "old-model",
    }),
  ).toEqual(preferences);
});
it("keeps drafts from retired generators readable without changing their text", async () => {
  const { DraftSchema } = await import("../src/shared/types.js");
  const workspace = demoWorkspace(),
    job = demoOpportunities()[0];
  const draft = createDraft(
    job,
    workspace.profile,
    workspace.preferences,
    assessOpportunity(job, workspace.profile, workspace.preferences),
  );
  const loaded = DraftSchema.parse({ ...draft, generator: "retired-provider" });
  expect(loaded.generator).toBe("legacy");
  expect(loaded.resume).toBe(draft.resume);
  expect(loaded.contentHash).toBe(draft.contentHash);
});

it("strips retired profile fields while retaining supported experience", async () => {
  const { ProfileSchema } = await import("../src/shared/types.js");
  const profile = demoWorkspace().profile;
  expect(
    ProfileSchema.parse({
      ...profile,
      headline: "Old",
      summary: "Old",
      learning: "Old",
      skills: ["Unused"],
    }),
  ).toEqual(profile);
});

it("discards unsupported skills and metadata instead of promoting them into career facts", () => {
  const result = extracted();
  result.entries[0].skills.push("Kubernetes");
  result.entries[0].role = "Chief technology officer";
  result.entries[0].company = "Invented company";
  result.entries[0].period = "2010–2026";
  const { facts } = validateExtraction(
    result,
    "Alex Built TypeScript services.",
  );
  expect(facts).toMatchObject({
    name: "Alex",
    evidence: [{ skills: ["TypeScript"], role: "", company: "", period: "" }],
  });
});

it.each(["source", "extractor", "processing", "failed", "missing"])(
  "ignores %s cache mismatches in matching and generation",
  (caseName) => {
    const workspace = demoWorkspace(),
      job = demoOpportunities()[0];
    if (caseName === "source")
      workspace.profile.cache!.sourceId =
        "33333333-3333-4333-8333-333333333333";
    if (caseName === "extractor") workspace.profile.cache!.extractorVersion = 0;
    if (caseName === "processing")
      workspace.profile.cache!.status = "processing";
    if (caseName === "failed") workspace.profile.cache!.status = "failed";
    if (caseName === "missing") workspace.profile.cache = null;
    const assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    expect(
      assessment.matches.every((match) => match.status === "missing"),
    ).toBe(true);
    expect(() =>
      createDraft(job, workspace.profile, workspace.preferences, assessment),
    ).toThrow("finish processing");
  },
);

it("selects different source facts for different role requirements", () => {
  const workspace = demoWorkspace();
  const frontend = demoOpportunities()[0];
  frontend.title = "Frontend Engineer";
  frontend.description = "Build React interfaces";
  frontend.requirements = [
    {
      id: "react",
      text: "React",
      skills: ["React"],
      essential: true,
      hard: false,
    },
  ];
  const backend = {
    ...frontend,
    title: "Backend Engineer",
    company: "Service Co",
    description: "Build Node.js services",
    requirements: [{ ...frontend.requirements[0], skills: ["Node.js"] }],
  };
  const draft = (op: typeof frontend) =>
    createDraft(
      op,
      workspace.profile,
      workspace.preferences,
      assessOpportunity(op, workspace.profile, workspace.preferences),
    );
  expect(draft(frontend).evidenceIds).toEqual(["demo-e1"]);
  expect(draft(backend).evidenceIds).toEqual(["demo-e2"]);
  expect(draft(frontend).resume).not.toContain(
    workspace.profile.cache!.facts!.evidence[1].text,
  );
  expect(draft(backend).resume).not.toContain(
    workspace.profile.cache!.facts!.evidence[0].text,
  );
});

it("does not treat partial skill names as supported capabilities", () => {
  const result = extracted();
  result.entries[0].text = "Built JavaScript services and C++ tooling.";
  result.entries[0].skills = ["JavaScript", "Java", "C", "C++"];
  const { facts } = validateExtraction(
    result,
    `Alex ${result.entries[0].text}`,
  );
  expect(facts.evidence[0].skills).toEqual(["JavaScript", "C++"]);
});

it("reports an unreadable name instead of activating an unusable career cache", () => {
  expect(() =>
    validateExtraction(
      { ...extracted(), name: "Invented name" },
      "Alex Built TypeScript services.",
    ),
  ).toThrow("name could not be read");
});
