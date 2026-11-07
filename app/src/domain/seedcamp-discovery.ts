import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { industryKey, industryPriorityBoost } from "../shared/industries.js";
import {
  OpportunitySchema,
  type Opportunity,
  type Preferences,
  type Source,
} from "../shared/types.js";
import { startupWebsiteIdentity } from "./startup-identity.js";

export const SEEDCAMP_PORTFOLIO_URL = "https://seedcamp.com/our-companies/";
export const SEEDCAMP_RESULT_LIMIT = 25;

type FetchText = (url: string) => Promise<{ text: string; url: string }>;

// These are the labels published in Seedcamp's portfolio filter controls.
// Preserve those labels as source material rather than inferring an industry.
const sectors: Record<string, string> = {
  ai: "AI",
  climate: "Climate",
  consumer: "Consumer",
  crypto: "Crypto",
  "defense-resilience": "Defense & Resilience",
  "developer-tools": "Developer Tools",
  enterprise: "Enterprise",
  fintech: "Fintech",
  "health-bio": "Health/Bio",
  "infra-dev-tools": "Infra & Dev. Tools",
  marketplaces: "Marketplaces",
  "robotics-hardware": "Robotics & Hardware",
  security: "Security",
};

function companyWebsite(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port)) ||
      !startupWebsiteIdentity(url.href)
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Parse only the public portfolio table; featured articles are not new leads. */
export function parseSeedcampPortfolio(
  html: string,
  source: Source,
  preferences: Preferences,
  now = new Date(),
): Opportunity[] {
  const $ = load(html);
  const rows = $(".company__item");
  // A changed or blocked page must not be reported as a healthy empty search.
  if (!rows.length)
    throw new Error(
      "Seedcamp's portfolio format changed or is unavailable. Try again later.",
    );
  const found = new Map<string, { opportunity: Opportunity; year: number }>();
  const keyword = industryKey(source.board);
  const timestamp = now.toISOString();
  let validRows = 0;

  rows.slice(0, 1000).each((_, row) => {
    const item = $(row);
    const company = item
      .find(".company__item__name")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const description = item
      .find(".company__item__description__content")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const website = companyWebsite(
      item.find("a.company__item__link").first().attr("href"),
    );
    if (!company || !description || !website) return;
    validRows++;
    const identity = startupWebsiteIdentity(website)!;
    if (found.has(identity)) return;
    const listedSectors = (item.attr("class") ?? "")
      .split(/\s+/)
      .map((name) => sectors[name])
      .filter(Boolean);
    const yearText = item.find(".company__item__year").text().trim();
    const year =
      /^\d{4}$/.test(yearText) &&
      Number(yearText) >= 1900 &&
      Number(yearText) <= now.getUTCFullYear()
        ? Number(yearText)
        : 0;
    const signals = [
      `Listed in Seedcamp's portfolio${year ? `; investment year ${year}` : ""}.`,
      ...listedSectors.map((sector) => `Seedcamp sector: ${sector}`),
    ];
    const fullDescription = [
      description,
      listedSectors.length
        ? `Seedcamp sectors: ${listedSectors.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (
      keyword &&
      !industryKey(`${company} ${fullDescription}`).includes(keyword)
    )
      return;
    const sourceKey = `seedcamp:${identity}`;
    const opportunity = OpportunitySchema.parse({
      id: randomUUID(),
      kind: "startup",
      company: company.slice(0, 500),
      title: description.slice(0, 500),
      description: fullDescription.slice(0, 50000),
      descriptionTruncated: fullDescription.length > 50000,
      companyUrl: website,
      url: SEEDCAMP_PORTFOLIO_URL,
      source: "seedcamp",
      sourceId: source.id,
      sourceKey,
      firstSeenAt: timestamp,
      updatedAt: timestamp,
      publishedAt: null,
      signals,
      discoverySignals: [
        {
          source: "seedcamp",
          sourceKey,
          title:
            `Seedcamp portfolio: ${company}${year ? ` · investment year ${year}` : ""}`.slice(
              0,
              2000,
            ),
          url: SEEDCAMP_PORTFOLIO_URL,
          publishedAt: null,
        },
      ],
      notes:
        "Source: Seedcamp's public company portfolio. The investment year is not a publication or launch date. Portfolio membership does not establish current operating status, hiring, headquarters, remote eligibility, compensation, or founder contact details.",
    });
    found.set(identity, { opportunity, year });
  });
  if (!validRows)
    throw new Error(
      "Seedcamp's portfolio did not contain readable company records. Try again later.",
    );
  return [...found.values()]
    .sort(
      (a, b) =>
        industryPriorityBoost(b.opportunity, preferences) -
          industryPriorityBoost(a.opportunity, preferences) ||
        b.year - a.year ||
        a.opportunity.company.localeCompare(b.opportunity.company),
    )
    .slice(0, SEEDCAMP_RESULT_LIMIT)
    .map(({ opportunity }) => opportunity);
}

/** One public page request; caller supplies the DNS-pinned, bounded transport. */
export async function discoverSeedcamp(
  source: Source,
  preferences: Preferences,
  fetchText: FetchText,
): Promise<Opportunity[]> {
  const result = await fetchText(SEEDCAMP_PORTFOLIO_URL);
  const resolved = new URL(result.url);
  if (
    resolved.origin !== new URL(SEEDCAMP_PORTFOLIO_URL).origin ||
    resolved.pathname.replace(/\/$/, "") !== "/our-companies"
  )
    throw new Error("Seedcamp's portfolio redirected to an unexpected page.");
  return parseSeedcampPortfolio(result.text, source, preferences);
}
