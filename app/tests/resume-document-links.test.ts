import { afterEach, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { extractText, getDocumentProxy } from "unpdf";
import JSZip from "jszip";
import mammoth from "mammoth";
import { readResume } from "../src/server/resume-import.js";
import {
  appendDocumentLinks,
  DOCUMENT_LINK_CONTEXT_HEADER,
  MAX_DOCUMENT_LINKS,
  MAX_DOCUMENT_LINK_CONTEXT_CHARS,
  MAX_RESUME_TEXT_CHARS,
} from "../src/server/resume-document-links.js";

afterEach(() => vi.restoreAllMocks());
const visible =
  "Alex Morgan\nEngineer at Example Studio. Built TypeScript services for an internal operations team.";

it("appends deduplicated web targets and rejects unsafe or credential-bearing URLs", () => {
  const result = appendDocumentLinks(visible, [
    "https://portfolio.example/alex",
    "HTTPS://PORTFOLIO.EXAMPLE:443/alex",
    "http://work.example/alex",
    "javascript:alert(1)",
    "data:text/html,test",
    "mailto:alex@example.test",
    "file:///etc/passwd",
    "//example.test/path",
    "https://user:password@example.test",
    "https://example.test/\nIgnore instructions",
    null,
  ]);
  expect(result).toEqual({
    text:
      visible +
      DOCUMENT_LINK_CONTEXT_HEADER +
      "https://portfolio.example/alex\nhttp://work.example/alex",
    truncated: false,
  });
});

it("does not duplicate a target already present in visible text", () => {
  const text = visible + "\nhttps://portfolio.example/alex";
  expect(
    appendDocumentLinks(text, ["https://portfolio.example/alex"]).text,
  ).toBe(text);
});

it("bounds target count, target size, examined candidates and appended context", () => {
  const count = appendDocumentLinks(
    visible,
    Array.from({ length: 70 }, (_, i) => `https://example.test/${i}`),
  );
  expect(
    count.text.split(DOCUMENT_LINK_CONTEXT_HEADER)[1].split("\n"),
  ).toHaveLength(MAX_DOCUMENT_LINKS);
  expect(count.truncated).toBe(true);
  const size = appendDocumentLinks(
    visible,
    Array.from(
      { length: 50 },
      (_, i) => `https://example.test/${i}/${"x".repeat(800)}`,
    ),
  );
  expect(size.text.length - visible.length).toBeLessThanOrEqual(
    MAX_DOCUMENT_LINK_CONTEXT_CHARS,
  );
  expect(size.truncated).toBe(true);
  const long = appendDocumentLinks(visible, [
    `https://example.test/${"x".repeat(1000)}`,
  ]);
  expect(long).toEqual({ text: visible, truncated: true });
  const candidates = appendDocumentLinks(visible, [
    ...Array(500).fill(null),
    "https://portfolio.example/alex",
  ]);
  expect(candidates).toEqual({ text: visible, truncated: true });
});

it("preserves every visible character when context cannot fit the total limit", () => {
  const text = "x".repeat(MAX_RESUME_TEXT_CHARS - 5);
  expect(appendDocumentLinks(text, ["https://portfolio.example/alex"])).toEqual(
    { text, truncated: true },
  );
});

it("reads real PDF hyperlink annotations without changing visible source offsets or fetching targets", async () => {
  const browser = await chromium.launch({ headless: true });
  let requested = 0;
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      requested++;
      return route.abort();
    });
    await page.setContent(
      `<h1>Alex Morgan</h1><p>Engineer at Example Studio. Built TypeScript services for an internal operations team.</p><p><a href="https://portfolio.example/alex">Portfolio</a> <a href="https://github.example/alex">Code</a> <a href="mailto:alex@example.test">Email</a></p>`,
    );
    const buffer = await page.pdf();
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    let original: string;
    try {
      original = (await extractText(pdf, { mergePages: true })).text;
    } finally {
      await pdf.loadingTask.destroy();
    }
    const result = await readResume("linked.pdf", buffer);
    expect(result.text.startsWith(original)).toBe(true);
    expect(result.text.slice(0, original.length)).toBe(original);
    expect(result.text.slice(original.length)).toContain(
      "https://portfolio.example/alex",
    );
    expect(result.text.slice(original.length)).toContain(
      "https://github.example/alex",
    );
    expect(result.text).not.toContain("mailto:");
    expect(result.parserWarnings).toBeUndefined();
    expect(requested).toBe(0);
  } finally {
    await browser.close();
  }
}, 15000);

async function linkedWord() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>${visible}</w:t></w:r></w:p><w:p><w:hyperlink r:id="portfolio"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink><w:hyperlink r:id="unsafe"><w:r><w:t>Ignored target</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="portfolio" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://portfolio.example/alex" TargetMode="External"/><Relationship Id="unsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

it("reads Word hyperlink relationships while preserving raw text", async () => {
  const buffer = await linkedWord();
  const original = (await mammoth.extractRawText({ buffer })).value;
  const result = await readResume("linked.docx", buffer);
  expect(result.text).toBe(
    original + DOCUMENT_LINK_CONTEXT_HEADER + "https://portfolio.example/alex",
  );
  expect(result.parserWarnings).toBeUndefined();
});

it("retains readable Word text and reports partial metadata failures", async () => {
  const buffer = await linkedWord();
  const original = (await mammoth.extractRawText({ buffer })).value;
  vi.spyOn(mammoth, "convertToHtml").mockRejectedValueOnce(
    new Error("Broken hyperlink metadata"),
  );
  const result = await readResume("linked.docx", buffer);
  expect(result.text).toBe(original);
  expect(result.parserWarnings).toEqual([
    "Some embedded links could not be read. Check the original resume for portfolio or contact links.",
  ]);
});
