import { afterEach, describe, expect, it, vi } from "vitest";
import { discover, freshFeedRecords, research } from "../src/domain/connectors.js";
import { assessGeography } from "../src/domain/geography.js";
import { assessOpportunity } from "../src/domain/rules.js";
import type { Source } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const workspace = demoWorkspace();
const source = (provider: Source["provider"]): Source => ({
  id: provider, provider, label: "Acme", board: "acme", enabled: true,
});
const respond = (data: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data))));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("source data quality", () => {
  it("researches the job posting rather than the employer homepage and reports truncation", async () => {
    const op = { ...demoOpportunities()[0], isDemo: false, companyUrl: "https://acme.example/", url: "https://jobs.ashbyhq.com/acme/job" };
    const fetchText = vi.fn(async (url: string) => ({ url, text: `<h2>Requirements</h2><ul>${Array.from({ length: 31 }, (_, i) => `<li>Qualification ${i} with demonstrated experience</li>`).join("")}</ul><h2>About the company</h2>${"a".repeat(15000)}` }));
    const patch = await research(op, fetchText);
    expect(fetchText).toHaveBeenCalledWith(op.url);
    expect(patch.descriptionTruncated).toBe(true);
    expect(patch.requirementsTruncated).toBe(true);
    expect(patch.requirements).toHaveLength(30);
  });
  it.each(["ashby", "greenhouse"] as const)("rejects malformed %s responses instead of reporting no openings", async provider => {
    respond({ error: "temporarily unavailable" });
    await expect(discover(source(provider), workspace.preferences)).rejects.toThrow("invalid jobs feed");
  });
  it("retains Ashby secondary hiring countries without a US-only shortcut", async () => {
    respond({ jobs: [{ id: "a", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/a",
      location: "United States", workplaceType: "Remote", address: { postalAddress: { addressCountry: "USA" } },
      secondaryLocations: [{ location: "Quito", address: { addressCountry: "Ecuador" } }],
      descriptionPlain: "Requirements\nTypeScript experience",
    }] });
    const [job] = await discover(source("ashby"), workspace.preferences);
    expect(job.location).toContain("Quito; Ecuador");
    expect(assessGeography(job, "Ecuador").status).toBe("eligible");
    expect(assessGeography(job, "India").status).toBe("excluded");
  });
  it("retains Lever alternate hiring locations and separate salary text", async () => {
    respond([{ id: "a", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/a", workplaceType: "remote",
      categories: { location: "United States", allLocations: ["United States", "Ecuador"] },
      descriptionPlain: "Requirements\nTypeScript experience",
      salaryDescriptionPlain: "USD 120,000 - 140,000 per year",
    }]);
    const [job] = await discover(source("lever"), workspace.preferences);
    expect(job.location).toBe("Remote — United States; Ecuador");
    expect(assessGeography(job, "Ecuador").status).toBe("eligible");
    expect(job).toMatchObject({ salaryMin: 120000, salaryMax: 140000, salaryCurrency: "USD", salaryPeriod: "year" });
  });
  it.each(["ashby", "lever", "jobicy"] as const)("keeps missing %s salary currency unknown", async provider => {
    const common = { id: 1, title: "Engineer", text: "Engineer", jobTitle: "Engineer", salaryMin: 120000, salaryMax: 140000,
      url: "https://jobicy.com/jobs/1", compensation: { summaryComponents: [{ compensationType: "Salary", interval: "1 YEAR", minValue: 120000, maxValue: 140000 }] },
      salaryRange: { min: 120000, max: 140000, interval: "per-year-salary" }, salaryPeriod: "year",
    };
    respond(provider === "lever" ? [common] : { jobs: [common] });
    const [job] = await discover(source(provider), workspace.preferences);
    expect(job.salaryCurrency).toBe("Unknown");
    expect(assessOpportunity(job, workspace.profile, workspace.preferences).unknowns.join(" ")).toContain("no exchange rate");
  });
  it("preserves HTML heading boundaries so unrelated benefits do not become required skills", async () => {
    respond({ jobs: [{ id: 1, title: "Engineer", content: "<h2>Requirements</h2><ul><li>React experience</li></ul><h2>Our distinctive culture</h2><ul><li>Annual team trips</li></ul>" }] });
    const [job] = await discover(source("greenhouse"), workspace.preferences);
    expect(job.requirements.map(r => r.text)).toEqual(["React experience"]);
  });
});

const item = (patch: Partial<Record<string, string>> = {}) => {
  const fields = { title: "Acme: Software Engineer", link: "https://weworkremotely.com/remote-jobs/acme-engineer", region: "Anywhere in the World", country: "", state: "", pubDate: "Sat, 07 Nov 2026 12:00:00 +0000", expires_at: "Mon, 07 Dec 2026 12:00:00 +0000", description: "<h2>Requirements</h2><ul><li>React experience</li></ul>", ...patch };
  return "<item>" + Object.entries(fields).map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`).join("") + "</item>";
};
const feed = (...items: string[]) => `<rss version="2.0"><channel>${items.join("")}</channel></rss>`;
const respondXml = (xml: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(xml)));
const wwr = { ...source("weworkremotely"), board: "" };

describe("We Work Remotely public RSS", () => {
  it("imports attributed listings with dates, independent headquarters and stable identity", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T18:00:00Z"));
    respondXml(feed(item(), item()));
    const jobs = await discover(wwr, workspace.preferences);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Acme", title: "Software Engineer", companyCountry: "Unknown", remoteScope: "worldwide", publishedAt: "2026-11-07T12:00:00.000Z", sourceExpiresAt: "2026-12-07T12:00:00.000Z", url: "https://weworkremotely.com/remote-jobs/acme-engineer" });
    expect(jobs[0].notes).toContain("We Work Remotely (https://weworkremotely.com)");
    expect(jobs[0].requirements[0].text).toBe("React experience");
    expect((await discover(wwr, workspace.preferences))[0].sourceKey).toBe(jobs[0].sourceKey);
    vi.setSystemTime(new Date("2026-12-07T12:00:00Z"));
    expect(freshFeedRecords(jobs, "workspace-copy")).toEqual([]);
  });
  it("rejects expired and external listings and never treats a region as worldwide", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T18:00:00Z"));
    respondXml(feed(
      item({ link: "https://evil.example/remote-jobs/acme-engineer" }),
      item({ expires_at: "Sat, 07 Nov 2026 17:00:00 +0000" }),
      item({ region: "USA Only", pubDate: "invalid", expires_at: "" }),
    ));
    const [job] = await discover(wwr, workspace.preferences);
    expect(job.publishedAt).toBeNull();
    expect(assessGeography(job, "Ecuador").status).toBe("excluded");
    expect(job.companyCountry).toBe("Unknown");
  });
  it("reports HTML error pages as a source failure", async () => {
    respondXml("<html><h1>Unavailable</h1></html>");
    await expect(discover(wwr, workspace.preferences)).rejects.toThrow("invalid RSS feed");
  });
});
