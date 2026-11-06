import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { load } from "cheerio";
import {
  OpportunitySchema,
  type Opportunity,
  type Preferences,
  type Requirement,
  type Source,
} from "../shared/types.js";
import { dateWindow } from "./rules.js";

const LIMIT = 2 * 1024 * 1024;
const IMPORT_LIMIT = 32 * 1024 * 1024;
export function isPublicAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(value) === 6) {
    const first = parseInt(value.split(":")[0] || "0", 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !value.startsWith("2001:db8:") &&
      !value.startsWith("2001:0:") &&
      !value.startsWith("2001::") &&
      !value.startsWith("2002:") &&
      !value.includes(".")
    );
  }
  return false;
}
export async function validatePublicUrl(
  input: string,
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a complete public website URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error(
      "Research only accepts public HTTP(S) websites on standard ports.",
    );
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    (!host.includes(".") && !isIP(host)) ||
    /\.(localhost|local|internal|invalid|test|onion)$/.test(host)
  )
    throw new Error(
      "Local and private network addresses cannot be researched.",
    );
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error(
      "This hostname resolves to a private or reserved network address.",
    );
  const selected = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { url, address: selected.address, family: selected.family };
}
/** Pin the validated DNS result to the connection, including after every redirect. */
export async function safeFetchText(
  input: string,
  redirects = 0,
): Promise<{ text: string; url: string }> {
  if (redirects > 3) throw new Error("The website redirected too many times.");
  const { url, address, family } = await validatePublicUrl(input);
  const response = await new Promise<{
    text: string;
    location?: string;
    status: number;
  }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "RoleLoop/0.1 (local public company research)",
          Accept: "text/html,application/xhtml+xml,text/plain",
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ text: "", location: res.headers.location, status });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Website returned HTTP ${status}.`));
          return;
        }
        if (
          res.headers["content-type"] &&
          !/text\/|application\/(?:xhtml\+xml|json)/i.test(
            res.headers["content-type"],
          )
        ) {
          res.resume();
          reject(new Error("This URL does not return a readable website."));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > LIMIT) {
            req.destroy(new Error("Website exceeds the 2 MB research limit."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ text: Buffer.concat(chunks).toString("utf8"), status }),
        );
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("Website research timed out.")),
      12000,
    );
    req.on("error", reject);
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
  if (response.location)
    return safeFetchText(
      new URL(response.location, url).toString(),
      redirects + 1,
    );
  return { text: response.text, url: url.toString() };
}
export function plainText(html: string): string {
  const $ = load(html);
  $("script,style,noscript,nav,footer,header").remove();
  $("li,p,div,section,br,h1,h2,h3,h4").append("\n");
  return $.text()
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}
const skills: Record<string, RegExp> = {
  TypeScript: /\btypescript\b/i,
  JavaScript: /\bjavascript\b/i,
  React: /\breact(?:\.js)?\b/i,
  "Node.js": /\bnode(?:\.js|js)?\b/i,
  PostgreSQL: /\bpostgres(?:ql)?\b/i,
  Python: /\bpython\b/i,
  AWS: /\baws\b|amazon web services/i,
  Docker: /\bdocker\b/i,
  Kubernetes: /\bkubernetes\b/i,
  Go: /\bgolang\b|\bGo programming\b/,
  Rust: /\brust\b/i,
  SQL: /\bsql\b/i,
  Testing: /\b(?:automated|unit|integration) tests?\b|\btesting\b/i,
};
export function extractRequirements(description: string): Requirement[] {
  const lines = description
    .split(/[\n•]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: Requirement[] = [];
  const seen = new Set<string>();
  let section: "essential" | "preferred" | "unknown" = "unknown";
  for (const raw of lines) {
    if (
      /^(?:what you bring|requirements|qualifications|required|what we're looking for)/i.test(
        raw,
      )
    )
      section = "essential";
    else if (/^(?:nice to have|preferred|bonus)/i.test(raw))
      section = "preferred";
    else if (/^(?:benefits|what we offer|about us|compensation)/i.test(raw))
      section = "unknown";
    const mentioned = Object.entries(skills)
      .filter(([, re]) => re.test(raw))
      .map(([name]) => name);
    const explicitlyRequired = /\b(?:must|required|essential|minimum)\b/i.test(
      raw,
    );
    if (
      (!explicitlyRequired && section === "unknown") ||
      /^(?:requirements|qualifications|required|nice to have|preferred|bonus)\s*:?$/i.test(
        raw,
      )
    )
      continue;
    const preferred =
      /\b(?:nice to have|preferred|bonus)\b/i.test(raw) ||
      section === "preferred";
    const text = raw.slice(0, 700);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({
      id: "req-" + createHash("sha256").update(text).digest("hex").slice(0, 12),
      text,
      skills: mentioned,
      essential: !preferred,
      hard: /\b(?:must|mandatory|minimum)\b/i.test(raw),
    });
    if (out.length >= 30) break;
  }
  return out;
}
export function remoteScope(text: string): Opportunity["remoteScope"] {
  if (
    /\bhybrid\s+(?:role|position|work|schedule|working|office)|\b(?:role|position|work|schedule|working)\s+(?:is\s+)?hybrid\b|\bon[- ]?site\s+(?:role|position|work|office)|\b(?:work|working)\s+on[- ]?site\b/i.test(
      text,
    ) &&
    !/\bfully remote\b/i.test(text)
  )
    return "onsite";
  if (
    /remote.{0,35}(?:worldwide|globally|anywhere)|(?:worldwide|global).{0,25}remote/i.test(
      text,
    )
  )
    return "worldwide";
  if (/\blatam\b|latin america/i.test(text) && /remote/i.test(text))
    return "latam";
  if (
    /remote.{0,30}(?:united states|us only|usa only)|\bus[- ]only\b/i.test(text)
  )
    return "us";
  return "unknown";
}
function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
async function json(url: string): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(
      `Source returned HTTP ${res.status}. Check the board ID and try again.`,
    );
  if (Number(res.headers.get("content-length")) > IMPORT_LIMIT)
    throw new Error("Source exceeds the 32 MB import limit.");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Source returned an empty response.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMPORT_LIMIT)
        throw new Error("Source exceeds the 32 MB import limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function base(
  source: Source,
  id: string | number,
  data: Record<string, unknown>,
): Opportunity {
  return OpportunitySchema.parse({
    id: randomUUID(),
    kind: "job",
    company: source.label,
    companyCountry: source.countrySource ? source.companyCountry : undefined,
    companyCountrySource: source.countrySource,
    source: source.provider,
    sourceId: source.id,
    sourceKey: `${source.provider}:${source.board}:${id}`,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data,
    ...(typeof data.description === "string" && data.description.length > 50000
      ? {
          description: data.description.slice(0, 50000),
          descriptionTruncated: true,
        }
      : {}),
  });
}
export async function discover(
  source: Source,
  prefs: Preferences,
): Promise<Opportunity[]> {
  if (
    source.provider !== "hackernews" &&
    source.provider !== "jobicy" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(source.board)
  )
    throw new Error(
      "Use the public job-board identifier, such as acme, rather than a full URL.",
    );
  if (source.provider === "jobicy") return discoverJobicy(source);
  const board = encodeURIComponent(source.board);
  if (source.provider === "ashby") {
    const data = await json(
      `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
    );
    return (data.jobs ?? [])
      .filter((j: any) => j.isListed !== false)
      .map((j: any) => {
        const desc = j.descriptionPlain ?? plainText(j.descriptionHtml ?? "");
        const components = j.compensation?.summaryComponents ?? [];
        const pay = components.find(
          (p: any) => p.compensationType === "Salary",
        );
        const workplace = j.workplaceType;
        return base(source, j.id ?? j.jobUrl, {
          title: j.title ?? "Untitled role",
          description: desc,
          url: j.jobUrl ?? j.applyUrl ?? "",
          location: j.location ?? "Unknown",
          remoteScope:
            workplace && workplace !== "Remote"
              ? "onsite"
              : remoteScope(`Remote ${j.location ?? ""}\n${desc}`),
          publishedAt: iso(j.publishedAt),
          salaryMin: number(pay?.minValue),
          salaryMax: number(pay?.maxValue),
          salaryCurrency: pay?.currencyCode ?? "USD",
          salaryPeriod:
            pay?.interval === "1 YEAR"
              ? "year"
              : pay?.interval === "1 MONTH"
                ? "month"
                : pay?.interval === "1 HOUR"
                  ? "hour"
                  : "unknown",
          requirements: extractRequirements(desc),
          notes:
            "Ashby publishedAt is the last publication date. Company headquarters and hiring countries require verification.",
        });
      });
  }
  if (source.provider === "greenhouse") {
    const data = await json(
      `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
    );
    return (data.jobs ?? []).map((j: any) => {
      const desc = plainText(j.content ?? "");
      return base(source, j.id, {
        company: j.company_name ?? source.label,
        title: j.title ?? "Untitled role",
        description: desc,
        url: j.absolute_url ?? "",
        location: j.location?.name ?? "Unknown",
        remoteScope: remoteScope(`${j.location?.name ?? ""}\n${desc}`),
        publishedAt: iso(j.first_published),
        requirements: extractRequirements(desc),
        notes:
          "An update timestamp is not treated as the original posting date. Salary and hiring eligibility may require checking the individual posting.",
      });
    });
  }
  if (source.provider === "lever") {
    const data: any[] = [];
    for (let skip = 0; skip < 1000; skip += 100) {
      const page = await json(
        `https://api.lever.co/v0/postings/${board}?mode=json&limit=100&skip=${skip}`,
      );
      if (!Array.isArray(page))
        throw new Error("Lever returned an invalid jobs feed.");
      data.push(...page);
      if (page.length < 100) break;
    }
    return data.map((j: any) => {
      const desc = [
        j.descriptionPlain ?? plainText(j.description ?? ""),
        ...(j.lists ?? []).map(
          (l: any) => `${l.text}\n${plainText(l.content ?? "")}`,
        ),
        j.additionalPlain ?? "",
      ].join("\n");
      const pay = j.salaryRange;
      return base(source, j.id, {
        title: j.text ?? "Untitled role",
        description: desc,
        url: j.hostedUrl ?? j.applyUrl ?? "",
        location: j.categories?.location ?? "Unknown",
        remoteScope:
          j.workplaceType === "on-site" || j.workplaceType === "hybrid"
            ? "onsite"
            : remoteScope(`${j.categories?.location ?? ""}\n${desc}`),
        publishedAt: iso(j.createdAt),
        salaryMin: number(pay?.min),
        salaryMax: number(pay?.max),
        salaryCurrency: pay?.currency ?? "USD",
        salaryPeriod: /year|annual/i.test(pay?.interval ?? "")
          ? "year"
          : /month/i.test(pay?.interval ?? "")
            ? "month"
            : /hour/i.test(pay?.interval ?? "")
              ? "hour"
              : "unknown",
        requirements: extractRequirements(desc),
        notes:
          "The public posting may omit application questions and hiring-country restrictions.",
      });
    });
  }
  const window = dateWindow(prefs);
  const cutoff =
    Math.floor(new Date(window.start + "T00:00:00Z").getTime() / 1000) - 86400;
  const query = source.board.trim();
  const data = await json(
    `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=25&numericFilters=created_at_i%3E${cutoff}${query ? "&query=" + encodeURIComponent(query) : ""}`,
  );
  return (data.hits ?? [])
    .filter((h: any) => typeof h.url === "string" && /^https?:\/\//.test(h.url))
    .map((h: any) => {
      let host = "Startup lead";
      try {
        host = new URL(h.url).hostname.replace(/^www\./, "");
      } catch {}
      const title = String(h.title ?? "Startup lead").replace(
        /^Show HN:\s*/i,
        "",
      );
      return base(source, h.objectID, {
        kind: "startup",
        company: host,
        title,
        description:
          `Startup research lead from a Show HN post: ${title}.\n${plainText(h.story_text ?? "")}`.slice(
            0,
            50000,
          ),
        url: h.url,
        companyUrl: h.url,
        companyCountry: "Unknown",
        remoteScope: "unknown",
        publishedAt: iso(h.created_at),
        signals: [`Show HN product announcement: ${title}`],
        notes: `Source: https://news.ycombinator.com/item?id=${h.objectID}. A public product announcement does not establish US headquarters, traction, hiring, or founder identity.`,
      });
    });
}
export async function research(op: Opportunity): Promise<Partial<Opportunity>> {
  if (op.isDemo)
    return {
      notes: [
        op.notes,
        "Demo research uses the existing fictional description; no website request was made.",
      ]
        .filter(Boolean)
        .join("\n"),
      updatedAt: new Date().toISOString(),
    };
  const result = await safeFetchText(op.companyUrl || op.url);
  const $ = load(result.text);
  const summary =
    $('meta[name="description"]').attr("content") ??
    $('meta[property="og:description"]').attr("content") ??
    "";
  const visible = plainText(result.text).slice(0, 14000);
  const contact = $('a[href^="mailto:"]')
    .map((_, a) => $(a).attr("href") ?? "")
    .get()
    .map((h) => h.slice(7).split("?")[0])
    .find((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const description = [summary, visible]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 18000);
  const patch: Partial<Opportunity> = {
    description,
    updatedAt: new Date().toISOString(),
    notes: [
      op.notes,
      `Public website inspected at ${new Date().toISOString()}: ${result.url}. Website content is unverified source material; research does not prove traction or hiring eligibility.`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
  if (op.kind === "job") patch.requirements = extractRequirements(description);
  // A published generic mailbox is a contact lead, not proof that the address belongs to a founder.
  if (contact && !op.contactEmail) {
    patch.contactEmail = contact;
    patch.contactSource = result.url;
    patch.notes +=
      " A public email was found; confirm the intended recipient and role.";
  }
  return patch;
}

async function discoverJobicy(source: Source): Promise<Opportunity[]> {
  const jobs = new Map<string, Opportunity>();
  const cursors = new Set<string>();
  let cursor = "";
  // Bound one synchronization to 1,000 recent listings; never infer closure from absence.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ count: "100" });
    if (cursor) params.set("cursor", cursor);
    const data = await json(`https://jobicy.com/api/jobs?${params}`);
    if (data.success === false || !Array.isArray(data.jobs))
      throw new Error("Jobicy returned an invalid jobs feed.");
    for (const j of data.jobs) {
      if (
        !j.id ||
        typeof j.url !== "string" ||
        !j.url.startsWith("https://jobicy.com/")
      )
        continue;
      const desc = plainText(String(j.jobDescription ?? j.jobExcerpt ?? ""));
      const geo = String(j.jobGeo ?? "Unknown");
      const scope = /^(anywhere|worldwide)$/i.test(geo)
        ? "worldwide"
        : /^(usa|united states|us)$/i.test(geo)
          ? "us"
          : /^(latam|latin america)$/i.test(geo)
            ? "latam"
            : "unknown";
      jobs.set(
        String(j.id),
        base(source, j.id, {
          company: j.companyName ?? "Unknown",
          companyCountry: "Unknown",
          sourceKey: `jobicy:${j.id}`,
          title: j.jobTitle ?? "Untitled role",
          url: j.url,
          location: geo,
          remoteScope: scope,
          description: desc,
          publishedAt: iso(j.pubDate),
          salaryMin: number(j.salaryMin),
          salaryMax: number(j.salaryMax),
          salaryCurrency: j.salaryCurrency ?? "USD",
          salaryPeriod: /year|annual/i.test(j.salaryPeriod ?? "")
            ? "year"
            : /month/i.test(j.salaryPeriod ?? "")
              ? "month"
              : /hour/i.test(j.salaryPeriod ?? "")
                ? "hour"
                : "unknown",
          requirements: extractRequirements(desc),
          notes:
            "Source: Jobicy (https://jobicy.com). Recent seven-day feed; company country and hiring eligibility need verification. Open the Jobicy listing to apply. Absence from this feed does not establish closure.",
        }),
      );
    }
    if (
      typeof data.nextCursor !== "string" ||
      !data.nextCursor ||
      cursors.has(data.nextCursor)
    )
      break;
    cursor = data.nextCursor;
    cursors.add(cursor);
  }
  return [...jobs.values()];
}
