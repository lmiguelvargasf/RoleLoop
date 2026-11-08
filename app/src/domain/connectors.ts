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
import { requiresPhysicalPresence } from "./geography.js";
import { discoverSeedcamp } from "./seedcamp-discovery.js";
import { himalayasJobs, type HimalayasOptions } from "./himalayas.js";

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
export function plainText(html: string, markStructure = false): string {
  let text = html;
  for (let pass = 0; pass < 2; pass++) {
    const $ = load(text);
    $("script,style,noscript,nav,footer,header").remove();
    // Preserve list boundaries even when a connector stores plain text first.
    $("li").prepend("• ");
    if (markStructure) {
      $("h1,h2,h3,h4,h5,h6").prepend("## ");
      $("p").each((_, element) => {
        const paragraph = $(element);
        const children = paragraph.children();
        if (
          children.length === 1 &&
          children.is("strong,b") &&
          children.text().trim() === paragraph.text().trim()
        )
          paragraph.prepend("## ");
      });
    }
    $("li,p,div,section,br,h1,h2,h3,h4,h5,h6,tr").append("\n");
    text = $.text();
    // Some boards return HTML as an escaped string inside their HTML field.
    // Parse that known markup once more; never recursively decode arbitrary text.
    if (
      !/<\/?(?:p|div|span|li|ul|ol|br|h[1-6]|strong|em|section|article|table|tr|td|th|a|b|i|script|style)\b[^>]*>/i.test(
        text,
      )
    )
      break;
  }
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

type PublishedSalary = Pick<
  Opportunity,
  "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryPeriod"
>;

// Bump when saved jobs with missing compensation should be checked again.
export const SALARY_EXTRACTION_VERSION = 2;

/** Text is a fallback only. A dollar symbol alone does not identify a currency,
 * and neither the size of an amount nor a job location proves its pay period. */
export function publishedSalary(
  title: string,
  description: string,
): PublishedSalary | null {
  const payContext = /\b(?:salary|salaries|compensation|pay|wages?|rates?)\b/i;
  const explicitPayUnit =
    /[$€£]\s*\d[\d,.]*(?:\s*[-–—]\s*[$€£]?\s*\d[\d,.]*)?\s*\/\s*(?:hour|hr|month|mo|year|yr)\b/i;
  const variablePay =
    /\b(?:ote|on[- ]target|bonus|bonuses|commission|equity|stock|incentive)\b/i;
  const unrelated =
    /\b(?:revenue|donations?|fundrais\w*|funding|budget|reimburse\w*|allowance|stipend|expenses?|benefits?|insurance|401k|retirement|subscription|pricing|customer rate|client rate)\b/i;
  const candidates: PublishedSalary[] = [];
  const parse = (input: string, fromTitle = false) => {
    if (!fromTitle && !payContext.test(input) && !explicitPayUnit.test(input))
      return;
    const base = input.search(
      /\b(?:(?:annual|annually|yearly|monthly|hourly)\s+)?base\s+(?:salary|pay|compensation)\b/i,
    );
    if (variablePay.test(input) && base < 0) return;
    // An explicitly named base component may precede a separate bonus/OTE.
    let text = (base >= 0 ? input.slice(base) : input).split(
      /\bplus\b|\s\+\s|;|\b(?:and|with|including|includes)\s+(?=(?:an?\s+)?(?:bonus|commission|equity|stock|benefit|allowance|stipend|ote|on[- ]target))/i,
    )[0];
    if (!fromTitle) text = text.split(/,\s+(?=[a-z])/i)[0];
    if (variablePay.test(text) || unrelated.test(text)) return;
    const currencies = new Set(
      [...text.matchAll(/\b(?:USD|CAD|EUR|GBP)\b|US\$|CA\$|C\$|€|£/gi)].map(
        ([value]) =>
          /^(?:US\$|USD)$/i.test(value)
            ? "USD"
            : /^(?:CA\$|C\$|CAD)$/i.test(value)
              ? "CAD"
              : /^(?:€|EUR)$/i.test(value)
                ? "EUR"
                : "GBP",
      ),
    );
    if (currencies.size > 1 || (!currencies.size && !/\$/.test(text))) return;
    // Preserve a stated amount even when "$" could denote multiple currencies.
    const salaryCurrency = [...currencies][0] ?? "Unknown";
    const periods = new Set<PublishedSalary["salaryPeriod"]>();
    if (/\b(?:year|yearly|annual|annually|annum|yr)\b/i.test(text))
      periods.add("year");
    if (/\b(?:month|monthly|mo)\b/i.test(text)) periods.add("month");
    if (/\b(?:hour|hourly|hr)\b/i.test(text)) periods.add("hour");
    const salaryPeriod = periods.size === 1 ? [...periods][0] : "unknown";
    const amount = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
    const marker = "(?:(?:USD|CAD|EUR|GBP|US\\$|CA\\$|C\\$)\\s*)?[$€£]?\\s*";
    const money = new RegExp(
      `(?<![\\w.,])${marker}(?<min>${amount})\\s*(?<minUnit>k)?(?:\\s*(?:[-–—]|to)\\s*${marker}(?<max>${amount})\\s*(?<maxUnit>k)?)?(?!\\d|,\\d)`,
      "gi",
    );
    const amounts: PublishedSalary[] = [];
    for (const match of text.matchAll(money)) {
      const after = text.slice((match.index ?? 0) + match[0].length);
      if (
        !/(?:USD|CAD|EUR|GBP|\$|€|£)/i.test(match[0]) &&
        !/^\s*(?:(?:\/|per\s+)(?:year|yr|month|mo|hour|hr)\s*)?(?:USD|CAD|EUR|GBP)\b/i.test(
          after,
        )
      )
        continue;
      const groups = match.groups!;
      const scaleMin =
        groups.minUnit || (groups.maxUnit && Number(groups.min) < 1000)
          ? 1000
          : 1;
      const min = Number(groups.min.replaceAll(",", "")) * scaleMin;
      const max = groups.max
        ? Number(groups.max.replaceAll(",", "")) * (groups.maxUnit ? 1000 : 1)
        : min;
      if (
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        min <= 0 ||
        max < min
      )
        continue;
      const before = text.slice(0, match.index).slice(-45);
      amounts.push({
        salaryMin:
          !groups.max && /\b(?:up to|maximum|ceiling)\b/i.test(before)
            ? null
            : min,
        salaryMax:
          !groups.max &&
          /\b(?:starts? at|from|minimum|at least)\b/i.test(before)
            ? null
            : max,
        salaryCurrency,
        salaryPeriod,
      });
    }
    if (amounts.length === 1) candidates.push(amounts[0]);
  };
  parse(title, true);
  const lines = plainText(description)
    .split("\n")
    .flatMap((line) => line.split(/\s*\|\s*/))
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!payContext.test(line) && !explicitPayUnit.test(line)) continue;
    // Read a labelled pay widget whose amount occupies the next line, without
    // treating unrelated numbers elsewhere in a benefits section as salary.
    const complete =
      /\d/.test(line) && /\b(?:USD|CAD|EUR|GBP)\b|[$€£]/i.test(line);
    parse(complete ? line : lines.slice(index, index + 3).join(" "));
  }
  const unique = new Map(
    candidates.map((salary) => [JSON.stringify(salary), salary]),
  );
  return unique.size === 1 ? [...unique.values()][0] : null;
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
// Bump when saved, uncorrected job descriptions need their requirements reparsed.
export const REQUIREMENT_EXTRACTION_VERSION = 8;

type RequirementSection =
  | "essential"
  | "preferred"
  | "responsibilities"
  | "ignore"
  | "unknown";
const requirementHeadings: ReadonlyArray<
  readonly [RequirementSection, RegExp]
> = [
  [
    "preferred",
    /^(?:nice[- ]to[- ]haves?|(?:(?:strongly|highly) )?preferred(?: qualifications| skills| experience)?|bonus(?: points)?(?: if you)?|desirable(?: qualifications| skills)?|additional skills(?: that you might also bring)?|what (?:would|will) make you stand out|other things we value)$/i,
  ],
  [
    "essential",
    /^(?:requirements|qualifications|skills and experience|required(?: qualifications| skills| experience)?|(?:minimum|basic|essential) (?:qualifications|requirements)|must[- ]haves?|what you(?:(?:'ll| will))? bring|what (?:we're|we are) looking for(?: in you)?|(?:we're|we are) looking for(?: someone who)?|what you(?:'ll| will) need(?: to succeed)?|(?:the )?experience you(?:'ll| will) bring|who you are|who (?:this|the role) is for|about you|you(?: might be| are|'re) (?:a good|the right) fit if)$/i,
  ],
  [
    "responsibilities",
    /^(?:(?:key |your |job )?responsibilities|what you(?:'ll| will) (?:do|work on|be responsible for)|what your day will look like|what (?:our )?(?:interview )?engineers do|your (?:impact|mission)|in this role[ ,]+you(?:'ll| will)|the role)$/i,
  ],
  [
    "ignore",
    /^(?:(?:our |your )?(?:benefits|perks)(?: and (?:benefits|perks))?|what we offer(?: you)?|(?:our |the )?(?:tech(?:nology)?(?: stack)?|stack)|what to expect|learn how we (?:think|work)(?: and work)?|why (?:join|work (?:with|at)) .+|why this is worth your time|about us|about (?:the|this) (?:company|team)|about [A-Z][\w -]{1,60}|(?:compensation|salary)(?: and benefits)?|pay and details|equal (?:employment )?opportunity(?: employer)?|how to apply|(?:the |our )?(?:application|hiring|interview) process|privacy(?: notice| policy)?|accommodations|apply(?: now| for this job)?)$/i,
  ],
];

function requirementHeading(text: string) {
  const label = text
    .replace(/[’‘]/g, "'")
    .replace(/^(?:#+\s*|\*{1,2}|_{1,2})+|(?:\*{1,2}|_{1,2})+$/g, "")
    .replace(/[\s:!?–—-]+$/g, "")
    .trim();
  if (
    label.length < 240 &&
    /\b(?:a good|the right) fit if(?: you)?$/i.test(label)
  )
    return "essential";
  return requirementHeadings.find(([, pattern]) => pattern.test(label))?.[0];
}

function requirementBoilerplate(text: string) {
  return /\b(?:equal (?:employment )?opportunity employer|all qualified applicants|without regard to (?:race|religion|sex)|protected (?:by (?:applicable )?law|veteran|characteristic)|reasonable accommodations?|privacy (?:policy|notice)|personal (?:data|information).{0,50}(?:collect|process|retain)|consent to.{0,40}(?:data|contact)|recruitment (?:fraud|agency)|recruiting (?:fraud|agency)|unsolicited (?:resumes|applications))\b/i.test(
    text,
  );
}

const optionalQualification = (text: string) =>
  /\b(?:nice[- ]to[- ]have|preferred|bonus|a plus|optional|(?:is|would be) helpful|not (?:required|necessary|needed))\b/i.test(
    text,
  ) || /^no\b.+\b(?:required|needed|necessary)\b/i.test(text);

function explicitQualification(text: string) {
  // "Essential tools" and a product described as a "must buy" are marketing,
  // not candidate requirements. Unknown sections need a qualification signal.
  const withoutMarketing = text.replace(
    /\b(?:a\s+)?["'‘’“”]?must[- ](?:buy|see)["'‘’“”]?\b/gi,
    "",
  );
  return /\b(?:must|required|mandatory)\b|\b(?:essential|minimum)\s+(?:experience|qualifications?|skills?|requirements?|education|degree|knowledge|proficiency)\b|\bminimum\s+(?:of\s+)?\d+\s+years?\b|\b(?:experience|skills?|knowledge|proficiency|degree)\b.{0,60}\b(?:is|are)\s+essential\b/i.test(
    withoutMarketing,
  );
}

function requirementClauses(raw: string, section: RequirementSection) {
  const clauses = raw.split(/;\s*|(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
  // A preferred add-on must not turn the required part of one bullet optional.
  // Keep a following "This is preferred" attached to its antecedent, though.
  const mixed =
    clauses.some(optionalQualification) &&
    clauses.some((clause) => !optionalQualification(clause));
  const refersBack = clauses
    .slice(1)
    .some(
      (clause) =>
        optionalQualification(clause) &&
        /^(?:this|that|these|those|such|it|the above|all of (?:this|the above))\b/i.test(
          clause,
        ),
    );
  return section === "unknown" || (mixed && !refersBack) ? clauses : [raw];
}

export function extractRequirementDetails(
  description: string,
): Pick<Opportunity, "requirements" | "requirementsTruncated"> {
  // Sources can contain HTML, escaped HTML, Markdown or text. Normalize before
  // interpreting headings so legal footers never become one giant requirement.
  const lines = plainText(description, true)
    .replace(/([^\n])([•●])/g, "$1\n$2")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const qualifications: Requirement[] = [];
  const responsibilities: Requirement[] = [];
  const seen = new Set<string>();
  const listedSections = new Set<number>();
  const paragraphSections = new Map<string, number>();
  const shortened = new Set<string>();
  let sectionIndex = 0;
  let section: RequirementSection = "unknown";
  for (const line of lines) {
    const listed = /^(?:[-*–—•●]\s+|\d+[.)]\s+)/.test(line);
    let raw = line.replace(/^(?:#{1,6}\s+|[-*–—•●]\s+|\d+[.)]\s+)+/, "");
    const colon = raw.indexOf(":");
    const heading = requirementHeading(colon >= 0 ? raw.slice(0, colon) : raw);
    if (heading) {
      sectionIndex++;
      section = heading;
      raw = colon >= 0 ? raw.slice(colon + 1).trim() : "";
      if (!raw) continue;
    }
    // Markdown headings that we do not recognize close the previous section.
    // This prevents a new company/policy section from inheriting "required".
    if (!heading && /^#{1,6}\s/.test(line)) {
      sectionIndex++;
      section = "unknown";
      continue;
    }
    if (requirementBoilerplate(raw) || section === "ignore") continue;
    const candidates = requirementClauses(raw, section);
    for (const candidate of candidates) {
      if (requirementBoilerplate(candidate)) continue;
      const explicitlyRequired = explicitQualification(candidate);
      if (
        !explicitlyRequired &&
        section === "unknown" &&
        !(optionalQualification(candidate) && explicitQualification(raw))
      )
        continue;
      const preferred =
        optionalQualification(candidate) || section === "preferred";
      const fullText = candidate.replace(/\s+/g, " ").trim();
      const text = fullText.slice(0, 700);
      const mentioned = Object.entries(skills)
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => name);
      if (
        (!mentioned.length && text.length < 8) ||
        requirementHeading(text) ||
        seen.has(text.toLowerCase())
      )
        continue;
      seen.add(text.toLowerCase());
      const target =
        section === "responsibilities" ? responsibilities : qualifications;
      const id =
        "req-" + createHash("sha256").update(text).digest("hex").slice(0, 12);
      if (fullText.length > text.length) shortened.add(id);
      if (listed) listedSections.add(sectionIndex);
      else if (
        !explicitlyRequired &&
        !mentioned.length &&
        !/\b(?:experience|years?|skills?|ability|able to|proficien\w*|knowledge|familiar\w*|understand\w*|expertise|background|fluen\w*|track record|education|degree|certifi\w*|licen[cs]\w*|authori[sz]\w*|residen\w*|citizen\w*|comfortable|you (?:have|can|bring|know|excel|thrive))\b/i.test(
          text,
        )
      )
        paragraphSections.set(id, sectionIndex);
      target.push({
        id,
        text,
        skills: mentioned,
        essential: !preferred,
        hard: !preferred && /\b(?:must|mandatory|minimum)\b/i.test(text),
      });
    }
  }
  // Duties are useful capability evidence when no required qualifications are
  // supplied. Do not double-count both lists as separate mandatory criteria.
  const actualItems = (items: Requirement[]) =>
    items.filter((item) => {
      const paragraphSection = paragraphSections.get(item.id);
      return (
        paragraphSection === undefined || !listedSections.has(paragraphSection)
      );
    });
  const requiredItems = actualItems(qualifications);
  const duties = actualItems(responsibilities);
  const useDuties = !requiredItems.some((requirement) => requirement.essential);
  const items = useDuties
    ? [...duties.slice(0, 12), ...requiredItems]
    : requiredItems;
  return {
    requirements: items.slice(0, 30),
    requirementsTruncated:
      items.length > 30 ||
      (useDuties && duties.length > 12) ||
      items.some((item) => shortened.has(item.id)),
  };
}

export function extractRequirements(description: string): Requirement[] {
  return extractRequirementDetails(description).requirements;
}

export function remoteScope(text: string): Opportunity["remoteScope"] {
  const clauses = text.split(/[\n.!?;]+/).map((clause) => clause.trim());
  if (requiresPhysicalPresence(text)) return "onsite";
  if (
    clauses.some((clause) => {
      const worldwide = clause.match(
        /\bremote(?:\s+(?:role|position|work|working|opportunity|job))?\s*[-–—,:()]*\s*(?:(?:from|across|in)\s+)?(?:worldwide|globally|anywhere(?!\s+(?:in|within|across|throughout)\s+(?!(?:the\s+)?world\b)))\b|\bwork(?:\s+remotely)?\s+from\s+anywhere\s+in\s+the\s+world\b|^(?:worldwide|global)[ -]+remote(?:\s+(?:role|position|job|work))?$/i,
      );
      return (
        worldwide &&
        !/\b(?:not|never|no|no longer)\s+(?:fully\s+)?$/i.test(
          clause.slice(0, worldwide.index),
        )
      );
    })
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
function postingScope(
  location: string,
  description: string,
  workplace?: string,
  remoteFlag?: boolean,
): Opportunity["remoteScope"] {
  const mode = workplace?.toLowerCase();
  if (
    /^(?:on[- ]?site|hybrid|office)$/.test(mode ?? "") ||
    /\b(?:hybrid|on[- ]?site)\b/i.test(location) ||
    (mode !== "remote" && remoteFlag === false)
  )
    return "onsite";
  // A source's remote flag establishes work mode, never worldwide permission.
  const prefix = mode === "remote" || remoteFlag === true ? "Remote " : "";
  const scope = remoteScope(`${prefix}${location}\n${description}`);
  // A coarse region inferred from the first location must not erase the other
  // locations. Geography evaluates the complete list and explicit restrictions.
  return location.includes(";") && ["us", "latam"].includes(scope)
    ? "unknown"
    : scope;
}
function postingLocation(
  location: string,
  scope: Opportunity["remoteScope"],
  workplace?: string,
  remoteFlag?: boolean,
) {
  // Keep explicit source work-mode evidence for country-specific remote jobs,
  // which cannot be represented by the coarse remoteScope enum alone.
  return scope !== "onsite" &&
    (workplace?.toLowerCase() === "remote" || remoteFlag === true) &&
    !/\bremote\b/i.test(location)
    ? `Remote — ${location}`
    : location;
}
function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function currency(value: unknown): string {
  // Missing currency is not USD: a remote board can advertise local pay.
  return typeof value === "string" && /^[A-Z]{3}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : "Unknown";
}
function locations(values: unknown[]): string {
  return (
    [
      ...new Set(
        values
          .filter(
            (value): value is string =>
              typeof value === "string" && Boolean(value.trim()),
          )
          .map((value) => value.trim()),
      ),
    ].join("; ") || "Unknown"
  );
}
function boardJobs(data: unknown, provider: string): any[] {
  if (
    !data ||
    typeof data !== "object" ||
    !("jobs" in data) ||
    !Array.isArray(data.jobs)
  )
    throw new Error(`${provider} returned an invalid jobs feed.`);
  return data.jobs;
}
async function sourceText(
  url: string,
  accept = "application/json",
): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: { Accept: accept },
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
  return Buffer.concat(chunks).toString("utf8");
}
async function json(url: string): Promise<any> {
  return JSON.parse(await sourceText(url));
}
function base(
  source: Source,
  id: string | number,
  data: Record<string, unknown>,
): Opportunity {
  return OpportunitySchema.parse({
    id: randomUUID(),
    kind: "job",
    company: source.companyName ?? source.label,
    companyId: source.companyId,
    companyCountry: source.countrySource ? source.companyCountry : undefined,
    companyCountrySource: source.countrySource,
    source: source.provider,
    sourceId: source.id,
    sourceKey: `${source.provider}:${source.board}:${id}`,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    salaryVersion: SALARY_EXTRACTION_VERSION,
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
  options: HimalayasOptions = {},
): Promise<Opportunity[]> {
  if (
    source.provider !== "hackernews" &&
    source.provider !== "seedcamp" &&
    source.provider !== "jobicy" &&
    source.provider !== "weworkremotely" &&
    source.provider !== "himalayas" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(source.board)
  )
    throw new Error(
      "Use the public job-board identifier, such as acme, rather than a full URL.",
    );
  if (source.provider === "jobicy") return discoverJobicy(source);
  if (source.provider === "weworkremotely")
    return discoverWeWorkRemotely(source);
  if (source.provider === "himalayas")
    return discoverHimalayas(source, prefs, options);
  if (source.provider === "seedcamp")
    return discoverSeedcamp(source, prefs, safeFetchText);
  const board = encodeURIComponent(source.board);
  if (source.provider === "ashby") {
    const data = await json(
      `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
    );
    return boardJobs(data, "Ashby")
      .filter((j: any) => j.isListed !== false)
      .map((j: any) => {
        const desc = j.descriptionHtml
          ? plainText(j.descriptionHtml, true)
          : (j.descriptionPlain ?? "");
        const components = j.compensation?.summaryComponents ?? [];
        const pay = components.find(
          (p: any) => p.compensationType === "Salary",
        );
        const structuredPay: PublishedSalary = {
          salaryMin: number(pay?.minValue),
          salaryMax: number(pay?.maxValue),
          salaryCurrency: currency(pay?.currencyCode),
          salaryPeriod:
            pay?.interval === "1 YEAR"
              ? "year"
              : pay?.interval === "1 MONTH"
                ? "month"
                : pay?.interval === "1 HOUR"
                  ? "hour"
                  : "unknown",
        };
        const salary =
          structuredPay.salaryMin !== null || structuredPay.salaryMax !== null
            ? structuredPay
            : (publishedSalary(j.title ?? "", desc) ?? structuredPay);
        const workplace = j.workplaceType;
        const location = locations([
          j.location,
          j.address?.postalAddress?.addressCountry,
          ...(Array.isArray(j.secondaryLocations)
            ? j.secondaryLocations
            : []
          ).flatMap((secondary: any) => [
            secondary?.location,
            secondary?.address?.addressCountry,
          ]),
        ]);
        const scope = postingScope(location, desc, workplace, j.isRemote);
        return base(source, j.id ?? j.jobUrl, {
          title: j.title ?? "Untitled role",
          description: desc,
          url: j.jobUrl ?? j.applyUrl ?? "",
          location: postingLocation(location, scope, workplace, j.isRemote),
          remoteScope: scope,
          publishedAt: iso(j.publishedAt),
          ...salary,
          ...extractRequirementDetails(desc),
          requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
          notes:
            "Ashby publishedAt is the last publication date. Company headquarters and hiring countries require verification.",
        });
      });
  }
  if (source.provider === "greenhouse") {
    const data = await json(
      `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
    );
    return boardJobs(data, "Greenhouse").map((j: any) => {
      const desc = plainText(j.content ?? "", true);
      return base(source, j.id, {
        company: j.company_name ?? source.label,
        title: j.title ?? "Untitled role",
        description: desc,
        url: j.absolute_url ?? "",
        location: j.location?.name ?? "Unknown",
        remoteScope: postingScope(j.location?.name ?? "", desc),
        publishedAt: iso(j.first_published),
        ...(publishedSalary(j.title ?? "", desc) ?? {
          salaryPeriod: "unknown",
        }),
        ...extractRequirementDetails(desc),
        requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
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
        j.description
          ? plainText(j.description, true)
          : (j.descriptionPlain ?? ""),
        ...(j.lists ?? []).map(
          (l: any) => `## ${l.text}\n${plainText(l.content ?? "", true)}`,
        ),
        j.additional
          ? plainText(j.additional, true)
          : (j.additionalPlain ?? ""),
        j.salaryDescription || j.salaryDescriptionPlain
          ? `Compensation: ${j.salaryDescription ? plainText(j.salaryDescription, true) : j.salaryDescriptionPlain}`
          : "",
      ].join("\n");
      const pay = j.salaryRange;
      const structuredPay: PublishedSalary = {
        salaryMin: number(pay?.min),
        salaryMax: number(pay?.max),
        salaryCurrency: currency(pay?.currency),
        salaryPeriod: /year|annual/i.test(pay?.interval ?? "")
          ? "year"
          : /month/i.test(pay?.interval ?? "")
            ? "month"
            : /hour/i.test(pay?.interval ?? "")
              ? "hour"
              : "unknown",
      };
      const salary =
        structuredPay.salaryMin !== null || structuredPay.salaryMax !== null
          ? structuredPay
          : (publishedSalary(j.text ?? "", desc) ?? structuredPay);
      const location = locations([
        j.categories?.location,
        ...(Array.isArray(j.categories?.allLocations)
          ? j.categories.allLocations
          : []),
      ]);
      const scope = postingScope(location, desc, j.workplaceType);
      return base(source, j.id, {
        title: j.text ?? "Untitled role",
        description: desc,
        url: j.hostedUrl ?? j.applyUrl ?? "",
        location: postingLocation(location, scope, j.workplaceType),
        remoteScope: scope,
        publishedAt: iso(j.createdAt),
        ...salary,
        ...extractRequirementDetails(desc),
        requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
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
export async function research(
  op: Opportunity,
  fetchText = safeFetchText,
): Promise<Partial<Opportunity>> {
  if (op.isDemo)
    return {
      description: op.description,
      notes: [
        op.notes,
        "Demo research uses the existing fictional description; no website request was made.",
      ]
        .filter(Boolean)
        .join("\n"),
      updatedAt: new Date().toISOString(),
    };
  const result = await fetchText(
    op.kind === "job" ? op.url : op.companyUrl || op.url,
  );
  const $ = load(result.text);
  const summary =
    $('meta[name="description"]').attr("content") ??
    $('meta[property="og:description"]').attr("content") ??
    "";
  const visibleText = plainText(result.text, true);
  const visible = visibleText.slice(0, 14000);
  const contact = $('a[href^="mailto:"]')
    .map((_, a) => $(a).attr("href") ?? "")
    .get()
    .map((h) => h.slice(7).split("?")[0])
    .find((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const fullDescription = [summary, visible].filter(Boolean).join("\n\n");
  const description = fullDescription.slice(0, 18000);
  const patch: Partial<Opportunity> = {
    description,
    descriptionTruncated:
      visibleText.length > visible.length ||
      fullDescription.length > description.length,
    updatedAt: new Date().toISOString(),
    notes: [
      op.notes,
      `Public website inspected at ${new Date().toISOString()}: ${result.url}. Website content is unverified source material; research does not prove traction or hiring eligibility.`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
  if (op.kind === "job") {
    Object.assign(patch, extractRequirementDetails(description));
    patch.requirementsVersion = REQUIREMENT_EXTRACTION_VERSION;
  }
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
      const desc = plainText(
        String(j.jobDescription ?? j.jobExcerpt ?? ""),
        true,
      );
      const structuredPay: PublishedSalary = {
        salaryMin: number(j.salaryMin),
        salaryMax: number(j.salaryMax),
        salaryCurrency: currency(j.salaryCurrency),
        salaryPeriod: /year|annual/i.test(j.salaryPeriod ?? "")
          ? "year"
          : /month/i.test(j.salaryPeriod ?? "")
            ? "month"
            : /hour/i.test(j.salaryPeriod ?? "")
              ? "hour"
              : "unknown",
      };
      const salary =
        structuredPay.salaryMin !== null || structuredPay.salaryMax !== null
          ? structuredPay
          : (publishedSalary(j.jobTitle ?? "", desc) ?? structuredPay);
      const geo = String(j.jobGeo ?? "Unknown");
      const scope =
        postingScope(geo, desc, "remote") === "onsite"
          ? "onsite"
          : /^(anywhere|worldwide)$/i.test(geo)
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
          location: postingLocation(geo, scope, "remote"),
          remoteScope: scope,
          description: desc,
          publishedAt: iso(j.pubDate),
          ...salary,
          ...extractRequirementDetails(desc),
          requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
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

async function discoverWeWorkRemotely(source: Source): Promise<Opportunity[]> {
  const xml = await sourceText(
    "https://weworkremotely.com/remote-jobs.rss",
    "application/rss+xml, application/xml, text/xml",
  );
  const $ = load(xml, { xml: true });
  if (!$("rss > channel").length)
    throw new Error("We Work Remotely returned an invalid RSS feed.");
  const jobs = new Map<string, Opportunity>();
  for (const element of $("rss > channel > item").toArray().slice(0, 1000)) {
    const item = $(element);
    const field = (name: string) => item.children(name).first().text().trim();
    const url = field("link");
    let canonical: URL;
    try {
      canonical = new URL(url);
      if (
        canonical.origin !== "https://weworkremotely.com" ||
        canonical.username ||
        canonical.password ||
        !/^\/remote-jobs\/[^/]+\/?$/.test(canonical.pathname)
      )
        continue;
    } catch {
      continue;
    }
    const sourceExpiresAt = iso(field("expires_at"));
    if (sourceExpiresAt && Date.parse(sourceExpiresAt) <= Date.now()) continue;
    const headline = field("title");
    const separator = headline.indexOf(": ");
    // WWR's documented/live feed title is "Company: Role". Keep unfamiliar
    // titles intact instead of inventing employer identity.
    const company =
      separator > 0 ? headline.slice(0, separator).trim() : "Unknown";
    const title =
      separator > 0 ? headline.slice(separator + 2).trim() : headline;
    const desc = plainText(field("description"), true);
    if (!title || !desc) continue;
    const location = locations([
      field("region"),
      field("country"),
      field("state"),
    ]);
    const scope = postingScope(location, desc, "remote");
    const key = createHash("sha256")
      .update(canonical.origin + canonical.pathname.replace(/\/$/, ""))
      .digest("hex");
    jobs.set(
      key,
      base(source, key, {
        company,
        companyCountry: "Unknown",
        sourceKey: `weworkremotely:${key}`,
        title,
        url,
        location: postingLocation(location, scope, "remote"),
        remoteScope: scope,
        description: desc,
        publishedAt: iso(field("pubDate")),
        ...(sourceExpiresAt ? { sourceExpiresAt } : {}),
        ...(publishedSalary(title, desc) ?? {
          salaryPeriod: "unknown",
          salaryCurrency: "Unknown",
        }),
        ...extractRequirementDetails(desc),
        requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
        notes:
          "Source: We Work Remotely (https://weworkremotely.com). Open the original listing to apply. Employer headquarters and hiring restrictions require verification. Feed absence does not establish closure.",
      }),
    );
  }
  return [...jobs.values()];
}

async function discoverHimalayas(
  source: Source,
  prefs: Preferences,
  options: HimalayasOptions,
): Promise<Opportunity[]> {
  const jobs = await himalayasJobs(prefs, source.board, options);
  return jobs.map((job) => {
    const text = plainText(job.description, true);
    const zones = job.timezoneRestrictions;
    // Geography consumes sourceTimezoneRestrictions directly. Synthesizing a
    // sentence in the job description would turn source metadata into an
    // employer qualification and incorrectly reduce experience coverage.
    const description = [
      job.employmentType ? `Employment type: ${job.employmentType}` : "",
      text,
    ]
      .filter(Boolean)
      .join("\n");
    const location = job.locationRestrictions?.length
      ? `Remote: ${job.locationRestrictions.join("; ")}`
      : job.locationRestrictions
        ? "Remote worldwide"
        : "Remote — hiring countries unspecified";
    const scope = postingScope(location, description, "remote");
    const updated = job.pubDate ? iso(job.pubDate * 1000) : null;
    const expires = job.expiryDate ? iso(job.expiryDate * 1000) : null;
    const structuredPay: PublishedSalary = {
      salaryMin: number(job.minSalary),
      salaryMax: number(job.maxSalary),
      salaryCurrency: currency(job.currency),
      salaryPeriod:
        job.salaryPeriod === "annual"
          ? "year"
          : job.salaryPeriod === "monthly"
            ? "month"
            : job.salaryPeriod === "hourly"
              ? "hour"
              : "unknown",
    };
    const textPay =
      structuredPay.salaryMin === null && structuredPay.salaryMax === null
        ? publishedSalary(job.title, description)
        : null;
    // The API can supply currency and period even when amounts exist only in
    // the description. Retain that metadata when recovering the stated range.
    const salary = textPay
      ? {
          ...textPay,
          salaryCurrency:
            structuredPay.salaryCurrency !== "Unknown"
              ? structuredPay.salaryCurrency
              : textPay.salaryCurrency,
          salaryPeriod:
            textPay.salaryPeriod !== "unknown"
              ? textPay.salaryPeriod
              : structuredPay.salaryPeriod,
        }
      : structuredPay;
    return base(source, job.guid, {
      company: job.companyName,
      companyCountry: "Unknown",
      sourceKey: `himalayas:${job.guid}`,
      sourceAttributionUrl: job.guid,
      ...(updated ? { sourceUpdatedAt: updated } : {}),
      ...(expires ? { sourceExpiresAt: expires } : {}),
      ...(zones ? { sourceTimezoneRestrictions: zones } : {}),
      title: job.title,
      url: job.applicationLink,
      description,
      location,
      remoteScope: scope,
      publishedAt: null,
      ...salary,
      ...extractRequirementDetails(description),
      requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
      notes: `Source: Himalayas (${job.guid}). Apply using the original application link. The source update date is not the original posting date. Employer headquarters and pay applicable to your country need verification.${job.salaryPeriod && salary.salaryPeriod === "unknown" ? ` Published pay period: ${job.salaryPeriod}.` : ""}`,
    });
  });
}

/** Cached feed data is public; database IDs and relationships belong to a workspace. */
export function freshFeedRecords(
  records: Opportunity[],
  sourceId: string,
): Opportunity[] {
  return records
    .filter(
      (record) =>
        !record.sourceExpiresAt ||
        Date.parse(record.sourceExpiresAt) > Date.now(),
    )
    .map((record) =>
      OpportunitySchema.parse({
        ...record,
        id: randomUUID(),
        sourceId,
        companyId: undefined,
      }),
    );
}
