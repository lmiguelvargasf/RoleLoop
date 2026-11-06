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
  headline: "Engineer",
  email: "",
  portfolio: "",
  summary: "Engineer",
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
it("keeps only source quotations, unconfirmed until reviewed", () => {
  const result = extracted();
  result.entries.push({ ...result.entries[0], text: "Invented claim" });
  const parsed = validateExtraction(
    result,
    "Alex Engineer Studio 2022 Built TypeScript services.",
  );
  expect(parsed.profile.evidence).toHaveLength(1);
  expect(parsed.profile.evidence[0].verified).toBe(false);
  expect(parsed.warnings.join(" ")).toContain("could not be traced");
  expect(() => validateExtraction(result, "Unrelated source")).toThrow(
    "No career details",
  );
});
it("rejects unsupported, corrupt and oversized documents before AI", async () => {
  const prefs = demoWorkspace().preferences;
  await expect(
    extractResume("file.exe", Buffer.from("abc"), prefs),
  ).rejects.toThrow(".pdf or .docx");
  await expect(
    extractResume("cv.pdf", Buffer.alloc(2 * 1024 * 1024 + 1), prefs),
  ).rejects.toThrow("2 MB");
  await expect(
    extractResume("cv.pdf", Buffer.from("not a PDF"), prefs),
  ).rejects.toThrow("could not be opened");
  await expect(
    extractResume("cv.docx", Buffer.from("not Word"), prefs),
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
  const fetcher = vi
    .fn()
    .mockResolvedValue(
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
      demoWorkspace().preferences,
    ),
  ).toEqual({ value: "ok" });
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
    structuredAI(
      z.object({ value: z.string() }),
      "test",
      "Instructions",
      {},
      demoWorkspace().preferences,
    ),
  ).rejects.toThrow("could not finish");
});
it("requires existing evidence IDs and complete requirement coverage", () => {
  const workspace = demoWorkspace(),
    job = demoOpportunities()[0];
  const fit = {
    summary: "Fit",
    relevantEvidenceIds: [workspace.profile.evidence[0].id],
    learningGaps: [],
    matches: job.requirements.map((r) => ({
      requirementId: r.id,
      evidenceIds: [workspace.profile.evidence[0].id],
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
it("keeps learning outside demonstrated skills and matching", () => {
  const workspace = demoWorkspace(),
    job = demoOpportunities()[0];
  workspace.profile.learning = "Learning Vue in a personal project";
  job.requirements[0].skills = ["Vue"];
  const assessment = assessOpportunity(
    job,
    workspace.profile,
    workspace.preferences,
  );
  expect(assessment.matches[0].status).toBe("missing");
  const draft = createDraft(
    job,
    workspace.profile,
    workspace.preferences,
    assessment,
  );
  expect(draft.resume).toContain("CURRENTLY LEARNING\nLearning Vue");
  expect(
    draft.resume.split("SKILLS\n")[1].split("CURRENTLY LEARNING")[0],
  ).not.toContain("Vue");
});
