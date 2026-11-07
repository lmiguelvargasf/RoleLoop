import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { load } from "cheerio";
import {
  matchesTargetRole,
  normalizeSource,
  sourceIdentity,
  sourceKind,
} from "../shared/discovery.js";
import type { Opportunity, Source, Workspace } from "../shared/types.js";
import { discover, isPublicAddress, safeFetchText } from "./connectors.js";
import { assessOpportunity } from "./rules.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const MAX_COMPANIES = 12;
const MAX_BOARDS = 5;
const MCP_URL = "https://mcp.himalayas.app/mcp";

type Cache = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
};
type Cached<T> =
  | { at: number; value: T }
  | { at: number; error: string; errorContext?: string };
type Employer = { name: string; slug: string; discoveredFrom: string };
type Board = { provider: "ashby" | "greenhouse" | "lever"; board: string };
type Careers = { website: string | null; board: Board | null };
const CAREERS_CONTEXT =
  /careers?|\bjobs\b|join[-_\s]*us|open[-_\s]*(?:roles|positions)|vacanc|apply|work[-_\s]*with[-_\s]*us/i;
export type EmployerDiscoveryResult = {
  boards: { source: Source; opportunities: Opportunity[] }[];
  companiesFound: number;
  boardsChecked: number;
  errors: string[];
};

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : "Company research failed.").slice(
    0,
    240,
  );

async function cached<T>(
  cache: Cache,
  key: string,
  ttl: number,
  read: () => Promise<T>,
  errorContext = "",
): Promise<T> {
  const saved = await cache.get<Cached<T>>(key);
  const age = saved ? Date.now() - saved.at : Infinity;
  if (saved && age >= 0) {
    if (
      "error" in saved &&
      age < HOUR &&
      (saved.errorContext ?? "") === errorContext
    )
      throw new Error(saved.error);
    if ("value" in saved && age < ttl) return saved.value;
  }
  try {
    const value = await read();
    await cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    await cache.set(key, {
      at: Date.now(),
      error: errorText(error),
      errorContext,
    });
    throw error;
  }
}

// Only fixed, public HTTPS API endpoints call this helper. Employer websites
// use safeFetchText, which validates and pins DNS, including every redirect.
async function apiText(
  url: string,
  body?: unknown,
  apiKey?: string,
): Promise<string> {
  const endpoint = new URL(url);
  const authenticated =
    apiKey &&
    !body &&
    endpoint.origin === "https://himalayas.app" &&
    !endpoint.username &&
    !endpoint.password &&
    (endpoint.pathname === "/jobs/api" ||
      endpoint.pathname.startsWith("/jobs/api/"));
  if (authenticated && /[^\x21-\x7e]/.test(apiKey))
    throw new Error(
      "Himalayas API key has an invalid format. Update the server configuration.",
    );
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: body ? "application/json, text/event-stream" : "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(authenticated ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Employer directory returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > RESPONSE_LIMIT)
    throw new Error("Employer directory response was too large.");
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("Employer directory returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT)
        throw new Error("Employer directory response was too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

function httpsUrl(value: string): URL {
  if (value.length > 2000) throw new Error("Company website URL is too long.");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    host === "localhost" ||
    (!host.includes(".") && !isIP(host)) ||
    /\.(localhost|local|internal|invalid|test|onion)$/.test(host) ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new Error("Company research requires a public HTTPS website.");
  return url;
}

/** Accept observed board URLs only, never a company-name-derived slug. */
export function employerBoardFromUrl(input: string): Board | null {
  try {
    const url = httpsUrl(input);
    const provider =
      url.hostname === "jobs.ashbyhq.com"
        ? "ashby"
        : url.hostname === "jobs.lever.co"
          ? "lever"
          : ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(
                url.hostname,
              )
            ? "greenhouse"
            : null;
    if (!provider) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    let board = decodeURIComponent(parts[0] ?? "");
    if (provider === "greenhouse" && board === "embed") {
      if (!/^\/embed\/job_(?:board(?:\/js)?|app)\/?$/.test(url.pathname))
        return null;
      board = url.searchParams.get("for") ?? "";
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(board)) return null;
    return { provider, board };
  } catch {
    return null;
  }
}

async function directoryEmployers(
  role: string,
  country: string,
  cache: Cache,
  prioritizePay: boolean,
  apiKey?: string,
): Promise<Employer[]> {
  const sort = prioritizePay ? "salaryDesc" : "recent";
  return cached(
    cache,
    `employers:query:v2:${hash(JSON.stringify([role.toLowerCase(), country.toLowerCase(), sort]))}`,
    DAY,
    async () => {
      const employers = new Map<string, Employer>();
      for (let page = 1; page <= 2; page++) {
        const params = new URLSearchParams({
          q: role,
          country,
          sort,
          page: String(page),
        });
        let data: unknown;
        try {
          data = JSON.parse(
            await apiText(
              `https://himalayas.app/jobs/api/search?${params}`,
              undefined,
              apiKey,
            ),
          );
        } catch (error) {
          if (error instanceof SyntaxError)
            throw new Error("Employer directory returned invalid JSON.");
          throw error;
        }
        if (
          !data ||
          typeof data !== "object" ||
          !("jobs" in data) ||
          !Array.isArray(data.jobs)
        )
          throw new Error("Employer directory returned an invalid jobs list.");
        for (const job of data.jobs) {
          if (
            !job ||
            typeof job.companyName !== "string" ||
            !job.companyName.trim() ||
            job.companyName.length > 200 ||
            typeof job.companySlug !== "string" ||
            !/^[a-z0-9][a-z0-9-]{0,99}$/.test(job.companySlug) ||
            typeof job.title !== "string" ||
            !matchesTargetRole(job.title, [role], job.companyName) ||
            (typeof job.expiryDate === "number" &&
              job.expiryDate * 1000 <= Date.now())
          )
            continue;
          employers.set(job.companySlug, {
            name: job.companyName.trim(),
            slug: job.companySlug,
            discoveredFrom: `https://himalayas.app/companies/${job.companySlug}`,
          });
        }
        if (data.jobs.length < 20) break;
      }
      // Retain employer identity/provenance only. No directory job content,
      // application links, salary claims, or workspace database IDs are cached.
      return [...employers.values()];
    },
    // Keep successful public metadata shared, but retry failures immediately
    // after a key is added or replaced. Never retain the credential itself.
    apiKey ? hash(apiKey) : "",
  );
}

async function companyWebsite(slug: string): Promise<string | null> {
  const raw = await apiText(MCP_URL, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_company_details",
      arguments: { company_slug: slug },
    },
  });
  let messages: any[];
  try {
    messages = raw.trim().startsWith("{")
      ? [JSON.parse(raw)]
      : raw
          .split(/\r?\n\r?\n/)
          .map((event) =>
            event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n"),
          )
          .filter(Boolean)
          .map((data) => JSON.parse(data));
  } catch {
    throw new Error("Company directory returned an invalid response.");
  }
  const result = messages.find((message) => message?.id === 1)?.result;
  if (result?.isError || !Array.isArray(result?.content))
    throw new Error("Company details could not be read from the directory.");
  const text = result.content
    .filter(
      (item: any) => item?.type === "text" && typeof item.text === "string",
    )
    .map((item: any) => item.text)
    .join("\n");
  // The official public tool currently returns Markdown, not structured data.
  // Match its explicit Website label; never infer a URL from the company name
  // or follow instructions in its company-authored description.
  const websites = [
    ...text.matchAll(/^\s*(?:🌐\s*)?\*\*Website:\*\*\s+(https?:\/\/\S+)\s*$/gm),
  ].map((match) => match[1]);
  if (!websites.length) return null;
  if (websites.length !== 1)
    throw new Error("Company directory returned ambiguous website links.");
  const website = httpsUrl(websites[0]);
  // These are directory referral parameters, not job application links.
  for (const key of [...website.searchParams.keys()])
    if (key.startsWith("utm_") || ["ref", "source"].includes(key))
      website.searchParams.delete(key);
  website.hash = "";
  return website.toString();
}

async function inspectCareers(website: string): Promise<Careers> {
  const direct = employerBoardFromUrl(website);
  if (direct) return { website, board: direct };
  const home = await safeFetchText(httpsUrl(website).toString());
  const homeUrl = httpsUrl(home.url);
  const redirected = employerBoardFromUrl(home.url);
  if (redirected) return { website: home.url, board: redirected };
  const boards = new Map<string, Board>();
  const collect = (html: string, base: string, careersPage = false) => {
    const $ = load(html);
    $("a[href], iframe[src], script[src]").each((_, element) => {
      const value = $(element).attr("href") ?? $(element).attr("src");
      if (!value) return;
      if (
        element.tagName === "a" &&
        !careersPage &&
        !CAREERS_CONTEXT.test(
          `${$(element).text()} ${$(element).attr("aria-label") ?? ""} ${$(element).attr("title") ?? ""}`,
        )
      )
        return;
      try {
        const board = employerBoardFromUrl(new URL(value, base).toString());
        if (board)
          boards.set(`${board.provider}:${board.board.toLowerCase()}`, board);
      } catch {}
    });
    return $;
  };
  const $ = collect(home.text, home.url);
  const companyHost = homeUrl.hostname.replace(/^www\./, "");
  const sameCompany = (url: URL) =>
    url.hostname === companyHost || url.hostname.endsWith(`.${companyHost}`);
  const links = new Map<string, number>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const link = httpsUrl(new URL(href, home.url).toString());
      const context = `${link.pathname} ${$(element).text()} ${$(element).attr("aria-label") ?? ""}`;
      if (!sameCompany(link) || !CAREERS_CONTEXT.test(context)) return;
      link.hash = "";
      if (
        link.origin === homeUrl.origin &&
        link.pathname === homeUrl.pathname &&
        link.search === homeUrl.search
      )
        return;
      links.set(
        link.toString(),
        /\/(careers?|jobs)\/?$/.test(link.pathname) ? 0 : 1,
      );
    } catch {}
  });
  const failures: string[] = [];
  if (!boards.size) {
    for (const [link] of [...links].sort((a, b) => a[1] - b[1]).slice(0, 2)) {
      try {
        const page = await safeFetchText(link);
        const board = employerBoardFromUrl(page.url);
        if (board)
          boards.set(`${board.provider}:${board.board.toLowerCase()}`, board);
        else if (sameCompany(httpsUrl(page.url)))
          collect(page.text, page.url, true);
      } catch (error) {
        failures.push(errorText(error));
      }
    }
  }
  if (boards.size > 1)
    throw new Error(
      "Multiple job boards found; choose the company’s careers link manually.",
    );
  if (!boards.size && failures.length) throw new Error(failures[0]);
  return { website: home.url, board: [...boards.values()][0] ?? null };
}

/** Discover employers broadly, then obtain every saved job independently
 * from the employer's public ATS board. No directory job is republished. */
export async function discoverEmployerBoards(
  workspace: Workspace,
  options: {
    cache: Cache;
    onProgress?: (message: string) => Promise<void>;
    excludeIdentities?: string[];
    himalayasApiKey?: string;
  },
): Promise<EmployerDiscoveryResult> {
  const result: EmployerDiscoveryResult = {
    boards: [],
    companiesFound: 0,
    boardsChecked: 0,
    errors: [],
  };
  const roles = [
    ...new Set(
      workspace.preferences.roles.map((role) => role.trim()).filter(Boolean),
    ),
  ].slice(0, 3);
  const country = workspace.preferences.country.trim();
  if (!roles.length || !country) {
    result.errors.push(
      "Set your target roles and working country before finding new companies.",
    );
    return result;
  }
  const capacity = Math.min(MAX_BOARDS, 50 - workspace.sources.length);
  if (capacity <= 0) {
    result.errors.push(
      "Your search already has 50 sources. Remove an unused source to find new companies.",
    );
    return result;
  }
  const excluded = new Set(
    options.excludeIdentities?.map((value) => value.toLowerCase()),
  );
  const companyNames = new Set<string>();
  const normalizeName = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  for (const source of workspace.sources) {
    if (sourceKind(source) !== "company_board") continue;
    try {
      excluded.add(sourceIdentity(source));
      companyNames.add(normalizeName(source.companyName || source.label));
    } catch {}
  }
  const candidates = new Map<string, Employer>();
  for (const role of roles) {
    await options.onProgress?.(
      `Finding companies hiring for ${role} from ${country}.`,
    );
    try {
      const employers = await directoryEmployers(
        role,
        country,
        options.cache,
        workspace.preferences.minimumSalary > 0,
        options.himalayasApiKey,
      );
      for (const employer of employers)
        if (!companyNames.has(normalizeName(employer.name)))
          candidates.set(employer.slug, employer);
    } catch (error) {
      result.errors.push(errorText(error));
    }
  }
  result.companiesFound = candidates.size;
  const pending = [...candidates.values()];
  const preferenceKey = hash(JSON.stringify(workspace.preferences));
  let next = 0;
  let checkedCompanies = 0;
  const worker = async () => {
    while (next < pending.length && result.boards.length < capacity) {
      const company = pending[next++];
      try {
        const careersKey = `employers:careers:v1:${company.slug}`;
        const saved = await options.cache.get<Cached<Careers>>(careersKey);
        const age = saved ? Date.now() - saved.at : Infinity;
        if (saved && age >= 0) {
          // Cached failures/unsupported boards do not consume this run's
          // research budget, so repeated runs reach additional employers.
          if ("error" in saved && age < HOUR) continue;
          if ("value" in saved && age < 7 * DAY) {
            if (!saved.value.board) continue;
            const identity = `${saved.value.board.provider}:${saved.value.board.board.toLowerCase()}`;
            if (excluded.has(identity)) continue;
            const unsuitable = await options.cache.get<{ at: number }>(
              `employers:unsuitable:v1:${hash(identity)}:${preferenceKey}`,
            );
            if (
              unsuitable &&
              Date.now() - unsuitable.at >= 0 &&
              Date.now() - unsuitable.at < DAY
            )
              continue;
            const failure = await options.cache.get<{ at: number }>(
              `employers:board-error:v1:${hash(identity)}`,
            );
            if (
              failure &&
              Date.now() - failure.at >= 0 &&
              Date.now() - failure.at < HOUR
            )
              continue;
          }
        }
        if (checkedCompanies >= MAX_COMPANIES) return;
        checkedCompanies++;
        await options.onProgress?.(`Checking ${company.name}’s careers page.`);
        const careers = await cached(
          options.cache,
          careersKey,
          7 * DAY,
          async () => {
            const website = await companyWebsite(company.slug);
            return website
              ? inspectCareers(website)
              : { website: null, board: null };
          },
        );
        if (!careers.board) continue;
        const identity = `${careers.board.provider}:${careers.board.board.toLowerCase()}`;
        if (excluded.has(identity)) continue;
        excluded.add(identity);
        const failureKey = `employers:board-error:v1:${hash(identity)}`;
        const failure = await options.cache.get<{ at: number; error: string }>(
          failureKey,
        );
        if (
          failure &&
          Date.now() - failure.at >= 0 &&
          Date.now() - failure.at < HOUR
        )
          throw new Error(failure.error);
        const source = {
          ...normalizeSource({
            id: `auto-${hash(identity)}`,
            label: company.name,
            companyName: company.name,
            companyCountry: "Unknown",
            ...careers.board,
            enabled: true,
          }),
          discoveredFrom: company.discoveredFrom,
          discoveredAt: new Date().toISOString(),
        };
        result.boardsChecked++;
        let opportunities: Opportunity[];
        try {
          // Do not cache jobs here: a known board must have a suitable opening
          // now, under the current preferences, before it is followed.
          opportunities = (await discover(source, workspace.preferences)).map(
            (op) => ({
              ...op,
              companyUrl: careers.website ?? op.companyUrl,
            }),
          );
          // Runtime cache payloads are NOT NULL. Expire the prior failure
          // explicitly instead of writing a null payload to clear it.
          await options.cache.set(failureKey, { at: 0, error: "" });
        } catch (error) {
          await options.cache.set(failureKey, {
            at: Date.now(),
            error: errorText(error),
          });
          throw error;
        }
        const relevant = opportunities.some(
          (op) =>
            matchesTargetRole(
              op.title,
              workspace.preferences.roles,
              op.company,
            ) &&
            assessOpportunity(op, workspace.profile, workspace.preferences)
              .blockers.length === 0,
        );
        if (relevant && result.boards.length < capacity)
          result.boards.push({ source, opportunities });
        if (!relevant)
          await options.cache.set(
            `employers:unsuitable:v1:${hash(identity)}:${preferenceKey}`,
            { at: Date.now() },
          );
      } catch (error) {
        result.errors.push(`${company.name}: ${errorText(error)}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(3, pending.length) }, worker),
  );
  result.errors = [...new Set(result.errors)];
  return result;
}
