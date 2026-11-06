import { expect, it } from "vitest";
import { validateIndexedExtraction } from "../src/server/resume-import.js";
import {
  indexResumeText,
  MAX_SOURCE_LINE_CHARS,
  sourceLineRange,
} from "../src/server/resume-source-lines.js";

const indexed = () => ({
  name: "Alex",
  portfolio: "",
  uncertainties: [],
  entries: [
    {
      startLine: 2,
      endLine: 4,
      role: "Engineer",
      company: "Studio",
      period: "2022",
      category: "experience" as const,
      statements: [{ startLine: 3, endLine: 4, skills: ["TypeScript"] }],
    },
  ],
});
const source =
  "Alex\r\n\r\nEngineer · Studio · 2022\r\n  Built TypeScript services\r\n  for internal teams.\r\n";

it("indexes nonempty lines as original text slices with stable offsets", () => {
  const lines = indexResumeText(source);
  expect(lines.map((line) => line.id)).toEqual([1, 2, 3, 4]);
  expect(lines[2].text).toBe("Built TypeScript services");
  for (const line of lines)
    expect(source.slice(line.start, line.end)).toBe(line.text);
  const range = sourceLineRange(lines, 3, 4)!;
  expect(source.slice(range.start, range.end)).toBe(
    "Built TypeScript services\r\n  for internal teams.",
  );
});

it("bounds long physical lines without dropping words or splitting surrogate pairs", () => {
  const text = `Alex\n${"Built TypeScript services. ".repeat(80)}\n${"🚀".repeat(500)}`;
  const lines = indexResumeText(text);
  expect(lines.every((line) => line.text.length <= MAX_SOURCE_LINE_CHARS)).toBe(
    true,
  );
  expect(
    lines
      .map((line) => line.text)
      .join("")
      .replace(/\s/g, ""),
  ).toBe(text.replace(/\s/g, ""));
  for (const line of lines) {
    expect(new TextDecoder().decode(new TextEncoder().encode(line.text))).toBe(
      line.text,
    );
    expect(text.slice(line.start, line.end)).toBe(line.text);
  }
});

it.each([
  [0, 1],
  [1, 999],
  [3, 2],
  [1.5, 2],
  [1, Infinity],
])("rejects invalid source range %s–%s", (start, end) => {
  expect(sourceLineRange(indexResumeText(source), start, end)).toBeNull();
});

it("restores wrapped statements and their source passage locally", () => {
  const { facts } = validateIndexedExtraction(indexed(), source);
  expect(facts.evidence[0].text).toBe(
    "Built TypeScript services\r\n  for internal teams.",
  );
  expect(facts.sections[0].sourceText).toBe(
    source.slice(source.indexOf("Engineer"), source.lastIndexOf("\r\n")),
  );
  const span = facts.evidence[0].source!;
  expect(source.slice(span.start, span.end)).toBe(facts.evidence[0].text);
  expect(facts.sections[0].evidenceIds).toEqual([facts.evidence[0].id]);
});

it("preserves distinct original positions for identical text in different records", () => {
  const text =
    "Alex\nEngineer Studio 2022\nBuilt TypeScript services.\nEngineer Studio 2024\nBuilt TypeScript services.";
  const result = indexed();
  result.entries = [
    {
      ...result.entries[0],
      startLine: 2,
      endLine: 3,
      statements: [{ startLine: 3, endLine: 3, skills: ["TypeScript"] }],
    },
    {
      ...result.entries[0],
      startLine: 4,
      endLine: 5,
      period: "2024",
      statements: [{ startLine: 5, endLine: 5, skills: ["TypeScript"] }],
    },
  ];
  const { facts } = validateIndexedExtraction(result, text);
  expect(facts.sections).toHaveLength(2);
  expect(facts.evidence).toHaveLength(2);
  expect(facts.evidence[0].text).toBe(facts.evidence[1].text);
  expect(facts.evidence[0].source!.start).toBe(text.indexOf("Built"));
  expect(facts.evidence[1].source!.start).toBe(text.lastIndexOf("Built"));
});

it("omits foreign and invalid statement ranges without borrowing metadata", () => {
  const text = source + "Director Elsewhere 2025\nLed 40 people.";
  const result = indexed();
  result.entries[0].role = "Director";
  result.entries[0].statements.push(
    { startLine: 6, endLine: 6, skills: [] },
    { startLine: 3, endLine: 900, skills: [] },
  );
  const { facts, warnings } = validateIndexedExtraction(result, text);
  expect(facts.evidence).toHaveLength(1);
  expect(facts.evidence[0].role).toBe("");
  expect(warnings.join(" ")).toContain("own entry");
});

it("rejects a result with no valid record ranges", () => {
  const result = indexed();
  result.entries[0].endLine = 999;
  expect(() => validateIndexedExtraction(result, source)).toThrow(
    "No career details",
  );
});

it("rejects oversized reconstructed statements instead of truncating original facts", () => {
  const text = `Alex\nEngineer Studio 2022\nBuilt TypeScript services.\n${"Another supported statement. ".repeat(100)}`;
  const lines = indexResumeText(text);
  const result = indexed();
  result.entries[0].endLine = lines.length;
  result.entries[0].statements = [
    { startLine: 3, endLine: 3, skills: ["TypeScript"] },
    { startLine: 4, endLine: lines.length, skills: [] },
  ];
  const { facts, warnings } = validateIndexedExtraction(result, text);
  expect(facts.evidence).toHaveLength(1);
  expect(warnings.join(" ")).toContain("too long");
});

it("allows embedded targets as portfolio context but never as career evidence", async () => {
  const { appendDocumentLinks } =
    await import("../src/server/resume-document-links.js");
  const text = appendDocumentLinks(source, [
    "https://portfolio.example/alex",
  ]).text;
  const linkLine = indexResumeText(text).at(-1)!.id;
  const result = indexed();
  result.portfolio = "https://portfolio.example/alex";
  result.entries.push({
    ...result.entries[0],
    startLine: linkLine,
    endLine: linkLine,
    role: "",
    company: "",
    period: "",
    statements: [{ startLine: linkLine, endLine: linkLine, skills: [] }],
  });
  const { facts, warnings } = validateIndexedExtraction(result, text);
  expect(facts.portfolio).toBe(result.portfolio);
  expect(facts.evidence).toHaveLength(1);
  expect(facts.sections).toHaveLength(1);
  expect(warnings.join(" ")).toContain("omitted");
});
