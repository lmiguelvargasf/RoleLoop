import { afterEach, describe, expect, it, vi } from "vitest";
import { discover, freshFeedRecords } from "../src/domain/connectors.js";
import { himalayasJobs, himalayasJobStatus, himalayasQueries } from "../src/domain/himalayas.js";
import { normalizeSource, sourceKind } from "../src/shared/discovery.js";
import { jobEngagement } from "../src/shared/job-engagement.js";
import type { Source } from "../src/shared/types.js";
import { demoWorkspace } from "./fixtures.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const source: Source = { id: "himalayas", provider: "himalayas", label: "Himalayas", board: "", enabled: true };
const prefs = { ...demoWorkspace().preferences, roles: ["Software Engineer"] };
const now = Date.parse("2026-11-07T12:00:00Z");
const job = (id = "role", extra: Record<string, unknown> = {}) => ({
  guid: `https://himalayas.app/companies/acme/jobs/${id}`,
  title: "Senior Software Engineer", companyName: "Acme",
  description: "<h2>Requirements</h2><ul><li>Build React and TypeScript applications.</li></ul>",
  applicationLink: `https://careers.acme.com/custom-ats/${id}?ref=himalayas`,
  locationRestrictions: ["Ecuador"], timezoneRestrictions: [-6, -5, -4],
  minSalary: 110000, maxSalary: 140000, currency: "USD", salaryPeriod: "annual",
  pubDate: now / 1000 - 86400, expiryDate: now / 1000 + 86400,
  ...extra,
});
const response = (jobs: unknown[]) => new Response(JSON.stringify({ jobs }));
const cache = () => {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (data.get(key) as T | undefined) ?? null,
    set: async (key: string, value: unknown) => { data.set(key, value); },
  };
};

describe("direct Himalayas job discovery", () => {
  it("imports supported and unsupported ATS links unchanged with attribution and source dates", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const fetch = vi.fn().mockResolvedValue(response([
      job("custom"), job("ashby", { applicationLink: "https://jobs.ashbyhq.com/acme/abc?utm_source=himalayas" }),
    ]));
    vi.stubGlobal("fetch", fetch);
    const jobs = await discover(source, prefs, { apiKey: "test-only-key" });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      company: "Acme", companyCountry: "Unknown", url: job("custom").applicationLink,
      sourceAttributionUrl: job("custom").guid, sourceKey: `himalayas:${job("custom").guid}`,
      publishedAt: null, sourceUpdatedAt: "2026-11-06T12:00:00.000Z", sourceExpiresAt: "2026-11-08T12:00:00.000Z",
      sourceTimezoneRestrictions: [-6, -5, -4], salaryMin: 110000, salaryCurrency: "USD", salaryPeriod: "year",
    });
    expect(jobs[0].location).toContain("Ecuador");
    expect(jobs[0].description).not.toContain("Candidates must be located in these time zones");
    expect(jobs[0].requirements.every((requirement) => !requirement.text.includes("UTC"))).toBe(true);
    expect(jobs[0].requirements.length).toBeGreaterThan(0);
    expect(jobs[1].url).toBe("https://jobs.ashbyhq.com/acme/abc?utm_source=himalayas");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).searchParams.get("country")).toBe("Ecuador");
    expect(new URL(url).searchParams.get("q")).toBe("Software Engineer");
    expect(init).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer test-only-key" } });
  });

  it("keeps missing currency, period, dates and country coverage unknown", async () => {
    vi.useFakeTimers().setSystemTime(now);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([job("unknown", {
      currency: null, salaryPeriod: null, pubDate: null, expiryDate: null,
      locationRestrictions: undefined, timezoneRestrictions: undefined,
    })])));
    const [op] = await discover(source, prefs);
    expect(op).toMatchObject({ salaryCurrency: "Unknown", salaryPeriod: "unknown", publishedAt: null, remoteScope: "unknown" });
    expect(op.sourceUpdatedAt).toBeUndefined();
    expect(op.sourceExpiresAt).toBeUndefined();
    expect(op.sourceTimezoneRestrictions).toBeUndefined();
  });

  it.each([["Contractor", "contract"], ["Full Time", "full_time"]] as const)("preserves explicit %s metadata without inventing a qualification", async (employmentType, kind) => {
    vi.useFakeTimers().setSystemTime(now);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([job("engagement", { employmentType })])));
    const [op] = await discover(source, prefs);
    expect(op.description).toContain(`Employment type: ${employmentType}`);
    expect(jobEngagement(op).kind).toBe(kind);
    expect(op.requirements.every((requirement) => !requirement.text.includes("Employment type"))).toBe(true);
  });

  it("honors expiry both before import and after a cached result ages", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const fetch = vi.fn().mockResolvedValue(response([job("open"), job("closed", { expiryDate: now / 1000 })]));
    vi.stubGlobal("fetch", fetch);
    const shared = cache();
    const jobs = await discover(source, prefs, { cache: shared });
    expect(jobs).toHaveLength(1);
    vi.setSystemTime(now + 86400001);
    expect(freshFeedRecords(jobs, "new-workspace")).toEqual([]);
  });

  it("shares daily query caches without mixing countries, roles, IDs or credentials", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const fetch = vi.fn().mockImplementation(async () => response([job()]));
    vi.stubGlobal("fetch", fetch);
    const shared = cache();
    const first = await discover(source, prefs, { cache: shared, apiKey: "first" });
    const second = await discover({ ...source, id: "another-workspace" }, prefs, { cache: shared, apiKey: "second" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second[0].id).not.toBe(first[0].id);
    expect(second[0].sourceId).toBe("another-workspace");
    await discover(source, { ...prefs, country: "Canada" }, { cache: shared });
    await discover(source, { ...prefs, roles: ["Backend Engineer"] }, { cache: shared });
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.setSystemTime(now + 86400001);
    await discover(source, prefs, { cache: shared });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("backs off failures without replaying cached jobs as success and retries a replacement key", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(response([job()]));
    vi.stubGlobal("fetch", fetch);
    const shared = cache();
    await expect(himalayasJobs(prefs, "", { cache: shared, apiKey: "old" })).rejects.toThrow("HTTP 429");
    await expect(himalayasJobs(prefs, "", { cache: shared, apiKey: "old" })).rejects.toThrow("HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await himalayasJobs(prefs, "", { cache: shared, apiKey: "new" })).toHaveLength(1);
  });

  it("bounds requests to three rotating roles and two pages, deduplicating stable GUIDs", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const fetch = vi.fn().mockImplementation(async () => response(Array.from({ length: 20 }, (_, index) => job(`job-${index}`))));
    vi.stubGlobal("fetch", fetch);
    const multi = { ...prefs, roles: ["First", "Second", "Third", "Fourth", "Fifth"] };
    expect(himalayasQueries(multi, "", 3)).toEqual(["Fourth", "Fifth", "First"]);
    const jobs = await himalayasJobs(multi, "", { roleOffset: 3 });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(jobs).toHaveLength(20);
    expect(himalayasQueries(multi, "Node.js", 3)).toEqual(["Node.js"]);
  });

  it("rejects malformed feed envelopes and unsafe application links visibly", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" })))
      .mockResolvedValueOnce(response([job("invalid", { applicationLink: "javascript:alert(1)" })]));
    vi.stubGlobal("fetch", fetch);
    await expect(discover(source, prefs)).rejects.toThrow("invalid jobs feed");
    await expect(discover(source, prefs)).rejects.toThrow("invalid jobs feed");
  });

  it("normalizes a feed without turning its unknown employers into a US company board", () => {
    expect(sourceKind(source)).toBe("job_feed");
    expect(normalizeSource({ ...source, companyCountry: "United States", countrySource: "https://example.com" })).toMatchObject({ kind: "job_feed", companyCountry: undefined, countrySource: undefined });
  });

  it("checks explicit closure without treating 404 as closure and caches checks for ten minutes", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 410 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: job("open") })));
    vi.stubGlobal("fetch", fetch);
    const shared = cache();
    expect(await himalayasJobStatus(job("closed").guid, { cache: shared })).toMatchObject({ status: "closed", expiresAt: new Date(now).toISOString() });
    expect(await himalayasJobStatus(job("closed").guid, { cache: shared })).toMatchObject({ status: "closed" });
    expect(await himalayasJobStatus(job("missing").guid, { cache: shared })).toMatchObject({ status: "unknown" });
    expect(await himalayasJobStatus(job("open").guid, { cache: shared })).toMatchObject({ status: "open", expiresAt: "2026-11-08T12:00:00.000Z" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe("https://himalayas.app/jobs/api/companies/acme/jobs/closed");
    await expect(himalayasJobStatus("https://attacker.example/companies/acme/jobs/role")).rejects.toThrow("Invalid Himalayas job identity");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
