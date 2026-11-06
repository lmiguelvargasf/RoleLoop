import type { Opportunity, Preferences } from "./types.js";

export const industryKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const industryCatalog = [
  "AI",
  "Developer tools",
  "B2B software",
  "SaaS",
  "Legaltech",
  "Fintech",
  "Climate",
  "Healthcare",
  "Ecommerce",
  "Education",
  "Cybersecurity",
  "Consumer apps",
  "Data infrastructure",
  "Robotics",
  "Space technology",
  "Energy",
  "Biotech",
  "Logistics",
  "Manufacturing",
  "Mobility",
  "Real estate",
  "Media & entertainment",
  "Travel & hospitality",
  "Food & agriculture",
] as const;

type IndustryPreferences = Pick<Preferences, "industries"> &
  Partial<Pick<Preferences, "industryPreference" | "topIndustries">>;

const aliases: Record<string, string[]> = {
  ai: ["artificial intelligence", "generative ai", "llm"],
  "developer tools": ["developer tooling", "devtools"],
  "b2b software": ["business software", "enterprise software"],
  saas: ["software as a service"],
  legaltech: ["legal technology", "legal tech"],
  fintech: ["financial technology", "fin tech"],
  climate: ["climate tech", "cleantech", "clean energy"],
  healthcare: ["health care", "healthtech", "health tech"],
  ecommerce: ["e commerce", "online retail"],
  education: ["edtech", "education technology"],
  cybersecurity: ["cyber security", "information security"],
  "data infrastructure": [
    "data platform",
    "data platforms",
    "data engineering",
  ],
  robotics: ["robot", "robots"],
  "space technology": ["space tech", "aerospace", "satellite", "satellites"],
  energy: ["renewable energy", "power grid", "battery", "batteries"],
  biotech: ["biotechnology", "life sciences"],
  logistics: ["supply chain", "freight"],
  mobility: ["transportation", "automotive"],
  "media entertainment": ["media", "entertainment", "gaming"],
  "travel hospitality": ["travel", "hospitality"],
  "food agriculture": ["food", "agriculture", "agtech"],
};

export function preferredIndustryMatches(
  opportunity: Pick<Opportunity, "title" | "description" | "signals">,
  preferences: IndustryPreferences,
): string[] {
  if (
    preferences.industryPreference === "any" ||
    !preferences.industries.length
  )
    return [];
  const source = ` ${industryKey([opportunity.title, opportunity.description, ...opportunity.signals].join(" "))} `;
  const seen = new Set<string>();
  return preferences.industries.filter((industry) => {
    const key = industryKey(industry);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return [key, ...(aliases[key] ?? [])].some((term) =>
      source.includes(` ${term} `),
    );
  });
}

/** Use the strongest matching level, so overlapping sectors never stack bonuses. */
export function industryPriorityBoost(
  opportunity: Pick<Opportunity, "title" | "description" | "signals">,
  preferences: IndustryPreferences,
): number {
  const matches = preferredIndustryMatches(opportunity, preferences);
  if (!matches.length) return 0;
  const top = new Set((preferences.topIndustries ?? []).map(industryKey));
  return matches.some((match) => top.has(industryKey(match))) ? 10 : 5;
}
