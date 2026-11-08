import { createHash } from "node:crypto";
import { z } from "zod";
import type { Preferences } from "../shared/types.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const publicHttps = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
const finiteAmount = z.number().finite().nonnegative().nullable().optional();
const timestamp = z.number().finite().positive().optional().nullable();
const Job = z.object({
  guid: publicHttps.refine((value) => {
    const url = new URL(value);
    return (
      url.origin === "https://himalayas.app" &&
      /^\/companies\/[^/]+\/jobs\/[^/]+\/?$/.test(url.pathname)
    );
  }),
  title: z.string().trim().min(1),
  companyName: z.string().trim().min(1),
  description: z.string().min(1),
  applicationLink: publicHttps,
  employmentType: z.string().trim().max(100).optional().nullable(),
  locationRestrictions: z.array(z.string().trim().min(1)).optional(),
  timezoneRestrictions: z
    .array(z.number().finite().min(-12).max(14))
    .optional(),
  minSalary: finiteAmount,
  maxSalary: finiteAmount,
  salaryPeriod: z.string().optional().nullable(),
  currency: z.string().optional().nullable(),
  pubDate: timestamp,
  expiryDate: timestamp,
});
export type HimalayasJob = z.infer<typeof Job>;
type Cache = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
};
export type HimalayasOptions = {
  cache?: Cache;
  apiKey?: string;
  roleOffset?: number;
};
type Cached = {
  at: number;
  jobs?: HimalayasJob[];
  error?: string;
  credentialContext?: string;
};
const inFlight = new Map<string, Promise<HimalayasJob[]>>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export function himalayasQueries(
  prefs: Preferences,
  keyword = "",
  roleOffset = 0,
): string[] {
  if (keyword.trim()) return [keyword.trim()];
  const roles = [
    ...new Set(prefs.roles.map((role) => role.trim()).filter(Boolean)),
  ];
  if (!roles.length) return [""];
  return Array.from(
    { length: Math.min(3, roles.length) },
    (_, index) => roles[(roleOffset + index) % roles.length],
  );
}

async function fetchPage(
  url: string,
  apiKey?: string,
): Promise<HimalayasJob[]> {
  // The URL is assembled below from a fixed API origin. Never forward this key
  // to application links, company websites, or redirected destinations.
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok)
    throw new Error(`Himalayas returned HTTP ${response.status}.`);
  const data = await responseJson(response);
  const result = z.object({ jobs: z.array(Job).max(20) }).safeParse(data);
  if (!result.success)
    throw new Error(
      "Himalayas returned an invalid jobs feed. Retry or inspect the source format.",
    );
  return result.data.jobs;
}

async function responseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > RESPONSE_LIMIT)
    throw new Error("Himalayas response exceeds the 4 MB limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Himalayas returned an empty response.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT)
        throw new Error("Himalayas response exceeds the 4 MB limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Himalayas returned invalid JSON.");
  }
  return data;
}

export type HimalayasStatus = {
  status: "open" | "closed" | "unknown";
  checkedAt: string;
  expiresAt?: string;
};

/** A 410 is explicit closure; a 404 only means the API has no record at this path. */
export async function himalayasJobStatus(
  guid: string,
  options: HimalayasOptions = {},
): Promise<HimalayasStatus> {
  const valid = Job.shape.guid.safeParse(guid);
  if (!valid.success) throw new Error("Invalid Himalayas job identity.");
  const url = new URL(guid);
  url.pathname = `/jobs/api${url.pathname}`;
  url.search = "";
  url.hash = "";
  const key = `himalayas:status:v1:${hash(url.toString())}`;
  const credentialContext = hash(options.apiKey ?? "");
  const saved = await options.cache?.get<{
    at: number;
    result?: HimalayasStatus;
    error?: string;
    credentialContext?: string;
  }>(key);
  const age = saved ? Date.now() - saved.at : Infinity;
  if (saved && age >= 0) {
    if (saved.result && age < 10 * 60 * 1000) return saved.result;
    if (
      saved.error &&
      age < HOUR &&
      saved.credentialContext === credentialContext
    )
      throw new Error(saved.error);
  }
  try {
    const response = await fetch(url.toString(), {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/json",
        ...(options.apiKey
          ? { Authorization: `Bearer ${options.apiKey}` }
          : {}),
      },
    });
    const checkedAt = new Date().toISOString();
    let result: HimalayasStatus;
    if (response.status === 404) {
      await response.body?.cancel();
      result = { status: "unknown", checkedAt };
    } else if (response.status === 410) {
      // HTTP 410 establishes closure even if the optional body is malformed.
      await response.body?.cancel();
      result = { status: "closed", checkedAt, expiresAt: checkedAt };
    } else if (response.ok) {
      const parsed = z
        .object({ job: Job })
        .safeParse(await responseJson(response));
      if (!parsed.success)
        throw new Error("Himalayas returned an invalid job status.");
      const expiry = parsed.data.job.expiryDate;
      const expiresAt =
        expiry && Number.isFinite(new Date(expiry * 1000).getTime())
          ? new Date(expiry * 1000).toISOString()
          : undefined;
      result = {
        status: expiry && expiry * 1000 <= Date.now() ? "closed" : "open",
        checkedAt,
        ...(expiresAt ? { expiresAt } : {}),
      };
    } else
      throw new Error(
        `Himalayas status check returned HTTP ${response.status}.`,
      );
    await options.cache?.set(key, { at: Date.now(), result });
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Himalayas status check failed.";
    await options.cache?.set(key, {
      at: Date.now(),
      error: message,
      credentialContext,
    });
    throw error;
  }
}

async function page(
  url: string,
  options: HimalayasOptions,
): Promise<HimalayasJob[]> {
  const key = `himalayas:jobs:v1:${hash(url)}`;
  const credentialContext = hash(options.apiKey ?? "");
  const saved = await options.cache?.get<Cached>(key);
  const age = saved ? Date.now() - saved.at : Infinity;
  if (saved && age >= 0) {
    if (saved.jobs && age < DAY) return saved.jobs;
    if (
      saved.error &&
      age < HOUR &&
      saved.credentialContext === credentialContext
    )
      throw new Error(saved.error);
  }
  const flightKey = `${key}:${credentialContext}`;
  const running = inFlight.get(flightKey);
  if (running) return running;
  const pending = (async () => {
    try {
      // Persist the attempt before fetching so restarts respect error backoff.
      await options.cache?.set(key, {
        at: Date.now(),
        error:
          "Himalayas refresh is pending or was interrupted; retry after the hourly window.",
        credentialContext,
      });
      const jobs = await fetchPage(url, options.apiKey);
      await options.cache?.set(key, { at: Date.now(), jobs });
      return jobs;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Himalayas refresh failed.";
      await options.cache?.set(key, {
        at: Date.now(),
        error: message,
        credentialContext,
      });
      throw error;
    } finally {
      inFlight.delete(flightKey);
    }
  })();
  inFlight.set(flightKey, pending);
  return pending;
}

/** Three rotating role queries, two pages each; cache public results per query
 * for a day. Country searches include worldwide roles, independently of ATS. */
export async function himalayasJobs(
  prefs: Preferences,
  keyword = "",
  options: HimalayasOptions = {},
): Promise<HimalayasJob[]> {
  const jobs = new Map<string, HimalayasJob>();
  for (const query of himalayasQueries(prefs, keyword, options.roleOffset)) {
    for (let index = 1; index <= 2; index++) {
      const params = new URLSearchParams({
        country: prefs.country,
        sort: prefs.minimumSalary > 0 ? "salaryDesc" : "recent",
        page: String(index),
      });
      if (query) params.set("q", query);
      const results = await page(
        `https://himalayas.app/jobs/api/search?${params}`,
        options,
      );
      for (const job of results) jobs.set(job.guid, job);
      if (results.length < 20) break;
    }
  }
  return [...jobs.values()].filter(
    (job) => !job.expiryDate || job.expiryDate * 1000 > Date.now(),
  );
}
