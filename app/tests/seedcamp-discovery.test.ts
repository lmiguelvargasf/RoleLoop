import { describe, expect, it, vi } from "vitest";
import {
  discoverSeedcamp,
  parseSeedcampPortfolio,
  SEEDCAMP_PORTFOLIO_URL,
} from "../src/domain/seedcamp-discovery.js";
import type { Source } from "../src/shared/types.js";
import { demoWorkspace } from "./fixtures.js";

const source: Source = {
  id: "managed:seedcamp",
  provider: "seedcamp",
  label: "Seedcamp",
  board: "",
  enabled: true,
};
const preferences = demoWorkspace().preferences;
const now = new Date("2026-11-07T12:00:00.000Z");
const row = (
  name: string,
  website: string,
  description: string,
  sector = "ai",
  year = "2026",
) => `
  <div class="company__item mix ${sector}">
    <a class="company__item__link" href="${website}">Link to website</a>
    <span class="company__item__name">${name}</span>
    <h6 class="company__item__year">${year}</h6>
    <div class="company__item__description__content">${description}</div>
  </div>`;

describe("Seedcamp portfolio discovery", () => {
  it("preserves named companies and source attribution without inventing eligibility or a date", () => {
    const [op] = parseSeedcampPortfolio(
      row(
        "Acme &amp; Co",
        "https://acme.example/",
        "AI tools for operations",
        "ai enterprise",
      ),
      source,
      preferences,
      now,
    );
    expect(op.company).toBe("Acme & Co");
    expect(op.companyUrl).toBe("https://acme.example/");
    expect(op.url).toBe(SEEDCAMP_PORTFOLIO_URL);
    expect(op.sourceKey).toBe("seedcamp:acme.example");
    expect(op.kind).toBe("startup");
    expect(op.description).toContain("Seedcamp sectors: AI, Enterprise.");
    expect(op.publishedAt).toBeNull();
    expect(op.companyCountry).toBe("Unknown");
    expect(op.remoteScope).toBe("unknown");
    expect(op.salaryMin).toBeNull();
    expect(op.contactEmail).toBe("");
    expect(op.discoverySignals).toEqual([
      {
        source: "seedcamp",
        sourceKey: "seedcamp:acme.example",
        url: SEEDCAMP_PORTFOLIO_URL,
        title: "Seedcamp portfolio: Acme & Co · investment year 2026",
        publishedAt: null,
      },
    ]);
    expect(op.firstSeenAt).toBe(now.toISOString());
  });

  it("ranks preferred and top industries before investment-year recency and caps saved leads", () => {
    const html = [
      ...Array.from({ length: 30 }, (_, i) =>
        row(
          `Other ${i}`,
          `https://other${i}.example`,
          "Consumer product",
          "consumer",
        ),
      ),
      row(
        "Preferred",
        "https://preferred.example",
        "Developer tools",
        "developer-tools",
        "2024",
      ),
      row("Top", "https://top.example", "AI platform", "ai", "2023"),
    ].join("");
    const ops = parseSeedcampPortfolio(
      html,
      source,
      {
        ...preferences,
        industries: ["AI", "Developer tools"],
        topIndustries: ["AI"],
      },
      now,
    );
    expect(ops).toHaveLength(25);
    expect(ops.slice(0, 2).map((op) => op.company)).toEqual([
      "Top",
      "Preferred",
    ]);
    const any = parseSeedcampPortfolio(
      html,
      source,
      { ...preferences, industryPreference: "any" },
      now,
    );
    expect(any.some((op) => op.company === "Preferred")).toBe(false);
  });

  it("filters optional keywords locally without changing source identity", () => {
    const html =
      row("Acme", "https://acme.example", "AI developer tools") +
      row("Other", "https://other.example", "Consumer product");
    const [op] = parseSeedcampPortfolio(
      html,
      { ...source, board: "developer tools" },
      preferences,
      now,
    );
    const [same] = parseSeedcampPortfolio(
      html,
      { ...source, board: "Acme" },
      preferences,
      now,
    );
    expect(op.sourceKey).toBe(same.sourceKey);
    expect(
      parseSeedcampPortfolio(
        html,
        { ...source, board: "unmatched" },
        preferences,
        now,
      ),
    ).toEqual([]);
  });

  it("deduplicates company websites and skips links that do not identify a public company site", () => {
    const html =
      row("Acme", "http://www.acme.example/", "Company tools") +
      row(
        "Same company",
        "https://acme.example/?ref=portfolio",
        "Company tools",
      ) +
      row("Invalid", "javascript:alert(1)", "Company tools") +
      row(
        "Credential link",
        "https://user:pass@other.example",
        "Company tools",
      ) +
      row(
        "Shared platform",
        "https://github.com/acme/project",
        "Company tools",
      ) +
      row("Local", "http://127.0.0.1/", "Company tools") +
      row("Wrong port", "https://port.example:3000/", "Company tools");
    expect(
      parseSeedcampPortfolio(html, source, preferences, now).map(
        (op) => op.company,
      ),
    ).toEqual(["Acme"]);
  });

  it("does not manufacture precise dates from investment years or use the lookback as a directory cutoff", () => {
    const [op] = parseSeedcampPortfolio(
      row("Old", "https://old.example", "Business tools", "enterprise", "2014"),
      source,
      {
        ...preferences,
        lookback: 1,
        dateMode: "strict",
      },
      now,
    );
    expect(op.publishedAt).toBeNull();
    expect(op.signals[0]).toContain("investment year 2014");
    const [future] = parseSeedcampPortfolio(
      row(
        "Future",
        "https://future.example",
        "Business tools",
        "enterprise",
        "2999",
      ),
      source,
      preferences,
      now,
    );
    expect(future.signals[0]).not.toContain("2999");
  });

  it("fetches only the official portfolio once and does not visit company websites", async () => {
    const fetchText = vi.fn().mockResolvedValue({
      text: row("Acme", "https://acme.example", "Business tools"),
      url: SEEDCAMP_PORTFOLIO_URL,
    });
    const ops = await discoverSeedcamp(
      { ...source, board: "Acme" },
      preferences,
      fetchText,
    );
    expect(ops).toHaveLength(1);
    expect(fetchText).toHaveBeenCalledExactlyOnceWith(SEEDCAMP_PORTFOLIO_URL);
  });

  it("surfaces changed markup, failed requests and unexpected redirects instead of healthy empty results", async () => {
    expect(() =>
      parseSeedcampPortfolio(
        "<html>Temporarily unavailable</html>",
        source,
        preferences,
        now,
      ),
    ).toThrow("format changed");
    expect(() =>
      parseSeedcampPortfolio(
        '<div class="company__item"><span class="new-name-class">Acme</span></div>',
        source,
        preferences,
        now,
      ),
    ).toThrow("readable company records");
    await expect(
      discoverSeedcamp(
        source,
        preferences,
        vi.fn().mockRejectedValue(new Error("Website returned HTTP 503.")),
      ),
    ).rejects.toThrow("503");
    await expect(
      discoverSeedcamp(
        source,
        preferences,
        vi.fn().mockResolvedValue({
          text: row("Acme", "https://acme.example", "Business tools"),
          url: "https://other.example/our-companies/",
        }),
      ),
    ).rejects.toThrow("unexpected page");
  });
});
