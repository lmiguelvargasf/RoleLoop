import type { Opportunity } from "../shared/types.js";

type GeographicJob = Pick<
  Opportunity,
  "location" | "description" | "remoteScope"
> &
  Partial<Pick<Opportunity, "title">>;
type CountryMention = { country: string; start: number; end: number };
type CountryList = {
  countries: Set<string>;
  start: number;
  end: number;
  ambiguous: boolean;
};

const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim();
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const aliases = new Map<string, string>();
const countryCodes = new Map<string, string>();
const labels = new Map<string, string>();
// Intl supplies country/territory names without a runtime network dependency.
// Exclude its non-country aggregate and pseudo-region codes.
const aggregates = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ"]);
for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const label = countryNames.of(code);
    if (!label || label === code || aggregates.has(code)) continue;
    const country = fold(label);
    aliases.set(country, country);
    countryCodes.set(code, country);
    labels.set(country, label);
  }
}
for (const [alias, code] of Object.entries({
  "united states of america": "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  uk: "GB",
  "u.k.": "GB",
  "great britain": "GB",
  britain: "GB",
  brasil: "BR",
  "south korea": "KR",
  "north korea": "KP",
  "czech republic": "CZ",
  "russian federation": "RU",
  vietnam: "VN",
  "ivory coast": "CI",
  "cape verde": "CV",
  turkey: "TR",
}))
  aliases.set(alias, countryCodes.get(code)!);
countryCodes.set("USA", countryCodes.get("US")!);
countryCodes.set("UK", countryCodes.get("GB")!);

export function normalizeCountry(value: string): string {
  const normalized = fold(value);
  return (
    countryCodes.get(value.trim().toUpperCase()) ??
    aliases.get(normalized) ??
    normalized
  );
}

const latam = new Set([
  "ecuador",
  "mexico",
  "colombia",
  "peru",
  "chile",
  "argentina",
  "brazil",
  "bolivia",
  "paraguay",
  "uruguay",
  "venezuela",
  "costa rica",
  "panama",
  "guatemala",
  "honduras",
  "el salvador",
  "nicaragua",
  "dominican republic",
  "cuba",
  "haiti",
]);
export const isLatam = (country: string) =>
  latam.has(normalizeCountry(country));
// Unicode CLDR territoryContainment region 019 (Americas), including territories.
// https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/territoryContainment.json
const americas = new Set(
  "AG AI AR AW BB BL BM BO BQ BR BS BV BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI"
    .split(" ")
    .map((code) => countryCodes.get(code)!),
);
const inAmericas = (country: string) => americas.has(normalizeCountry(country));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namePattern = [...aliases.keys()]
  .filter((name) => name.length > 3)
  .sort((a, b) => b.length - a.length)
  .map(escape)
  .join("|");

// These also name US states/territories. Job prose alone cannot distinguish
// California from Canada (CA), or Indiana from India (IN).
const ambiguousCodes = new Set(
  "AL AR AS AZ CA CO DE GA ID IL IN KY LA MA MD ME MN MO MS MT NC NE PA PR SC SD TN VA VI".split(
    " ",
  ),
);
function mentions(text: string, explicitCountries = false): CountryMention[] {
  const normalized = fold(text);
  const found: CountryMention[] = [];
  for (const match of normalized.matchAll(
    new RegExp(`\\b(?:${namePattern})\\b`, "g"),
  )) {
    if (match[0] === "georgia" && !explicitCountries) continue;
    found.push({
      country: aliases.get(match[0])!,
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }
  // ISO abbreviations are accepted only in uppercase in job prose, so "us",
  // "in", "it" and "no" do not become country restrictions accidentally.
  for (const match of text.matchAll(/\b[A-Z]{2,3}\b/g)) {
    if (!explicitCountries && ambiguousCodes.has(match[0])) continue;
    const country = countryCodes.get(match[0]);
    if (
      country &&
      !found.some(
        (item) => item.start <= match.index! && item.end > match.index!,
      )
    )
      found.push({
        country,
        start: match.index!,
        end: match.index! + match[0].length,
      });
  }
  return found.sort((a, b) => a.start - b.start);
}

function listAfter(text: string, start: number): CountryList | null {
  const rest = text.slice(start);
  const found = mentions(
    rest,
    /\b(?:countries|country codes)\s*:\s*$/i.test(text.slice(0, start)),
  );
  if (
    !found.length ||
    !/^(?:\s|[:(])*(?:(?:the|either)\s+)?$/i.test(rest.slice(0, found[0].start))
  )
    return null;
  const countries = new Set([found[0].country]);
  let end = found[0].end;
  let ambiguous = false;
  for (const item of found.slice(1)) {
    const separator = rest.slice(end, item.start);
    if (!/^\s*(?:(?:,|\/|&|\band\b|\bor\b)\s*)+(?:the\s+)?$/i.test(separator)) {
      // Never turn the understood prefix of a mixed list into an exhaustive
      // restriction, e.g. "Brazil, CA or Ecuador".
      if (/^\s*(?:,|\/|&|\band\b|\bor\b)/i.test(separator)) ambiguous = true;
      break;
    }
    countries.add(item.country);
    end = item.end;
  }
  if (
    /^\s*(?:(?:,|\/|&|\band\b|\bor\b)\s*)+(?:the\s+)?(?:LATAM|Latin America|Americas|AMER|EMEA|Europe|European Union|APAC|Asia Pacific|worldwide|global|anywhere)\b/i.test(
      rest.slice(end),
    )
  )
    ambiguous = true;
  return {
    countries,
    start: start + found[0].start,
    end: start + end,
    ambiguous,
  };
}

const negated = (before: string) =>
  /\b(?:not|never|no|no longer|cannot|can't|unable to)\s+(?:only\s+)?(?:\w+\s+){0,2}$/i.test(
    before,
  ) ||
  /\b(?:no need to|not required to|do not need to|don't need to)\s*$/i.test(
    before,
  );
const incidental = (text: string) =>
  /\b(?:headquarters?|headquartered|offices?|customers?|clients?|markets?|company|companies|team|time\s*zones?|hours|time overlap)\b/i.test(
    text,
  ) &&
  !/\b(?:candidates?|applicants?|residents?|(?:this )?(?:role|position|job) (?:is|requires)|hiring|recruiting|(?:must|need to|have to|are required to)\s+(?:be\s+)?(?:based|located|reside|live|work)|(?:work|duties|services)\s+must\s+be)\b/i.test(
    text,
  );

function restrictions(text: string) {
  const allowed: Set<string>[] = [],
    excluded = new Set<string>();
  const negatedCountries = new Set<string>();
  const regions = new Set<"latam" | "americas">();
  const ignoredScopes = new Set<"us" | "latam">();
  let unclear = false;
  let ambiguousLists = false;
  let timezone = false;
  // Keep dotted country abbreviations intact before splitting sentences.
  const clean = text
    .replace(/\bU\.S\.(?:A\.)?/gi, "US")
    .replace(/\bU\.K\./gi, "UK");
  for (const raw of clean.split(/[\n.!?;]+/)) {
    const clause = raw.trim();
    if (!clause) continue;
    const ignoreScope = () => {
      if (mentions(clause).some((value) => value.country === "united states"))
        ignoredScopes.add("us");
      if (/\b(?:LATAM|Latin America)\b/i.test(clause))
        ignoredScopes.add("latam");
    };
    if (incidental(clause)) {
      ignoreScope();
      continue;
    }
    const addAllowed = (list: CountryList | null) => {
      if (!list) return;
      if (list.ambiguous) {
        ambiguousLists = true;
        return;
      }
      if (
        /^\s*[-–—]?\s*(?:time\s*zones?|hours|business hours|working hours|time)\b/i.test(
          clause.slice(list.end),
        )
      ) {
        timezone = true;
        return;
      }
      allowed.push(list.countries);
    };
    // Compensation sections describe the pay of eligible employees; they do
    // not establish which countries may apply.
    if (
      /\b(?:salary|compensation|pay range|benefits?|insurance|pension|401k)\b/i.test(
        clause,
      ) &&
      !/\b(?:must (?:be|reside|live)|hiring|recruiting|eligible to apply|(?:this )?(?:role|position|job) (?:is|requires)|only (?:candidates?|applicants?|residents?))\b/i.test(
        clause,
      )
    ) {
      ignoreScope();
      continue;
    }
    if (!/\b(?:countries|country codes)\s*:/i.test(clause)) {
      for (const match of clause.matchAll(/\b(?:[A-Z]{2}|Georgia)\b/gi)) {
        if (
          match[0].toLowerCase() !== "georgia" &&
          !ambiguousCodes.has(match[0])
        )
          continue;
        const before = clause.slice(0, match.index!);
        const after = clause.slice(match.index! + match[0].length);
        if (
          /^\s*[-–—]?\s*(?:(?:applicants?|candidates?|residents?)\s+)?only\b/i.test(
            after,
          ) ||
          (/\b(?:in|from|within|of)\s*$/i.test(before) &&
            /\b(?:must|only|hiring|hire|remote|located|based|reside|live)\b/i.test(
              before,
            ))
        )
          unclear = true;
      }
    }
    for (const match of clause.matchAll(
      /\b(?:LATAM|Latin America|Americas|AMER)\s*[-–—]?\s*only\b/gi,
    )) {
      if (!negated(clause.slice(0, match.index!)))
        regions.add(
          /LATAM|Latin America/i.test(match[0]) ? "latam" : "americas",
        );
      else if (/LATAM|Latin America/i.test(match[0]))
        ignoredScopes.add("latam");
    }
    const negative =
      /\b(?:(?:(?:not|cannot|can't|unable to|do not|don't)\s+(?:currently\s+)?(?:hire|hiring|employ|employing|accept applications|accept candidates)\s+(?:(?:candidates?|applicants?|people|residents?)\s+)?(?:(?:based|located|residing)\s+)?(?:in|from))|(?:(?:candidates?|applicants?|you)\s+(?:must not|cannot|can't)\s+(?:be\s+)?(?:based|located|reside|live)\s+(?:in|from))|(?:except(?:\s+for)?|excluding|not available in|not open to))\s+/gi;
    for (const match of clause.matchAll(negative)) {
      const list = listAfter(clause, match.index! + match[0].length);
      if (list) for (const country of list.countries) excluded.add(country);
      else unclear = true;
    }
    const positive =
      /\b(?:(?:(?:must|need to|have to|are required to)\s+(?:be\s+)?(?:based|located|reside|residing|live|living|work|working|(?:a\s+)?resident)\s+(?:in|from|within|of))|(?:(?:hire|hiring|recruiting|accepting (?:applications|candidates|applicants))\s+(?:only\s+)?(?:(?:candidates?|applicants?|people|residents?)\s+)?(?:(?:based|located|residing)\s+)?(?:in|from))|(?:(?:this\s+)?(?:role|position|job|opportunity)\s+(?:is\s+)?(?:only\s+)?(?:open|available|restricted|limited)\s+(?:only\s+)?(?:to|in|for)\s+(?:(?:candidates?|applicants?|people|residents?)\s+)?(?:(?:based|located|residing)\s+)?(?:(?:in|from|of)\s+)?)|(?:(?:eligible|permitted|allowed|supported|hiring)\s+(?:countries|locations)\s*:)|(?:(?:work|duties|services)\s+must\s+be\s+(?:performed|done|carried out)\s+(?:in|from|within))|(?:remote\s+(?:within|in|from)))\s*/gi;
    for (const match of clause.matchAll(positive)) {
      const before = clause.slice(0, match.index!);
      const list = listAfter(clause, match.index! + match[0].length);
      if (negated(before)) {
        if (list)
          for (const country of list.countries) negatedCountries.add(country);
        if (
          /^\s*(?:LATAM|Latin America)\b/i.test(
            clause.slice(match.index! + match[0].length),
          )
        )
          ignoredScopes.add("latam");
        continue;
      }
      addAllowed(list);
      if (!list) {
        const region = clause
          .slice(match.index! + match[0].length)
          .match(
            /^\s*(?:the\s+)?(LATAM|Latin America|Americas|AMER|EMEA|Europe|European Union|APAC|Asia Pacific)\b(.*)$/i,
          );
        if (region) {
          if (/\b(?:or|and)\b/i.test(region[2])) unclear = true;
          else if (/^(?:LATAM|Latin America)$/i.test(region[1]))
            regions.add("latam");
          else if (/^(?:Americas|AMER)$/i.test(region[1]))
            regions.add("americas");
          else unclear = true;
        }
      }
    }
    // "Only candidates based in Brazil or Ecuador" and "Brazil/Ecuador only".
    const onlyPrefix =
      /\bonly\s+(?:(?:candidates?|applicants?|residents?|people)\s+)?(?:(?:who\s+)?(?:are\s+)?(?:based|located|residing|living)\s+)?(?:(?:in|from|of)\s+)?/gi;
    for (const match of clause.matchAll(onlyPrefix)) {
      const list = listAfter(clause, match.index! + match[0].length);
      if (negated(clause.slice(0, match.index!))) {
        if (list)
          for (const country of list.countries) negatedCountries.add(country);
        continue;
      }
      addAllowed(list);
    }
    for (const mention of mentions(clause)) {
      const list = listAfter(clause, mention.start);
      if (list?.ambiguous && /\bonly\b/i.test(clause.slice(list.end))) {
        ambiguousLists = true;
        continue;
      }
      if (
        !list ||
        !/^\s*[-–—]?\s*(?:(?:(?:candidates?|applicants?|residents?)\s+)?only\b|[- ]based\s+(?:candidates?|applicants?|residents?)\s+only\b)/i.test(
          clause.slice(list.end),
        )
      )
        continue;
      // A tail of a multi-country list must not become a second, narrower rule.
      if (
        allowed.some((countries) =>
          [...list.countries].every((country) => countries.has(country)),
        )
      )
        continue;
      if (negated(clause.slice(0, mention.start))) {
        for (const country of list.countries) negatedCountries.add(country);
      } else addAllowed(list);
    }
    for (const match of clause.matchAll(
      /\b(?:candidates?|applicants?|residents?|people)\s+(?:based\s+|located\s+)?(?:in|from|of)\s+/gi,
    )) {
      const list = listAfter(clause, match.index! + match[0].length);
      if (
        list &&
        /^\s+(?:are\s+)?(?:not eligible|cannot apply|can't apply|not accepted)\b/i.test(
          clause.slice(list.end),
        )
      )
        for (const country of list.countries) excluded.add(country);
    }
    if (
      /\b(?:citizens?|citizenship|work authori[sz]ation|authori[sz]ed to work|visa|selected countries|certain countries)\b/i.test(
        clause,
      ) &&
      /\b(?:must|required|only|restrict|eligible|available|need|cannot|can't)\b/i.test(
        clause,
      )
    )
      unclear = true;
  }
  return {
    allowed,
    excluded,
    negatedCountries,
    regions,
    ignoredScopes,
    unclear,
    ambiguousLists,
    timezone,
  };
}

export function assessGeography(
  job: GeographicJob,
  workingCountry: string,
): { blockers: string[]; unknowns: string[] } {
  const blockers: string[] = [],
    unknowns: string[] = [];
  const country = normalizeCountry(workingCountry);
  if (!country) unknowns.push("Your working country is missing.");
  else if (!labels.has(country))
    unknowns.push(
      "Set a specific working country, such as Ecuador, to check hiring eligibility.",
    );
  const knownCountry = labels.has(country);
  const text = `${job.title ?? ""}\n${job.location}\n${job.description}`;
  const evidence = restrictions(text);
  const allowed = evidence.allowed.length
    ? new Set(
        [...evidence.allowed[0]].filter((value) =>
          evidence.allowed.every((countries) => countries.has(value)),
        ),
      )
    : null;
  const conflict =
    evidence.ambiguousLists ||
    (allowed !== null && allowed.size === 0) ||
    (allowed !== null &&
      [...allowed].some((value) => evidence.excluded.has(value)));
  if (job.remoteScope === "onsite")
    blockers.push("The opportunity is not fully remote.");
  if (evidence.ambiguousLists)
    unknowns.push(
      "The posting mixes country, region or state names. Confirm the complete hiring-location list before applying.",
    );
  else if (conflict)
    unknowns.push(
      "The posting gives conflicting hiring-country restrictions. Confirm eligibility before applying.",
    );
  else if (knownCountry && evidence.excluded.has(country)) {
    blockers.push(
      `This role explicitly excludes applicants working in ${labels.get(country)}.`,
    );
  } else if (knownCountry && allowed !== null && !allowed.has(country)) {
    const countries = [...allowed]
      .map((value) =>
        value === "united states" ? "the United States" : labels.get(value),
      )
      .join(", ");
    blockers.push(`This role is restricted to people working in ${countries}.`);
  }
  if (evidence.unclear)
    unknowns.push(
      "Country-specific work authorization or hiring restrictions need confirmation.",
    );
  if (evidence.timezone)
    unknowns.push(
      "Required working hours or time-zone overlap need confirmation.",
    );

  if (
    !conflict &&
    allowed === null &&
    knownCountry &&
    evidence.regions.has("latam") &&
    !isLatam(country)
  )
    blockers.push("This opportunity is restricted to Latin America.");
  if (
    !conflict &&
    allowed === null &&
    knownCountry &&
    evidence.regions.has("americas") &&
    !inAmericas(country)
  )
    blockers.push("This opportunity is restricted to the Americas.");

  // Stored scope remains a fallback for older records. Concrete country lists
  // take precedence over coarse worldwide/LATAM labels.
  if (
    !conflict &&
    allowed === null &&
    job.remoteScope === "us" &&
    !evidence.ignoredScopes.has("us") &&
    !evidence.negatedCountries.has("united states") &&
    knownCountry &&
    country !== "united states"
  )
    blockers.push(
      "This role is restricted to people working in the United States.",
    );
  else if (
    !conflict &&
    allowed === null &&
    job.remoteScope === "latam" &&
    !evidence.ignoredScopes.has("latam") &&
    knownCountry &&
    !isLatam(country)
  )
    blockers.push("This opportunity is restricted to Latin America.");
  if (job.remoteScope === "unknown")
    unknowns.push("Remote location and hiring arrangement need confirmation.");
  if (
    job.remoteScope === "us" &&
    evidence.negatedCountries.has("united states") &&
    allowed === null
  )
    unknowns.push("Remote location and hiring arrangement need confirmation.");
  if (
    (job.remoteScope === "us" || job.remoteScope === "latam") &&
    evidence.ignoredScopes.has(job.remoteScope) &&
    allowed === null &&
    !evidence.regions.size
  )
    unknowns.push("Remote location and hiring arrangement need confirmation.");
  if (
    (job.remoteScope === "us" || allowed?.has("united states")) &&
    country === "united states"
  )
    unknowns.push(
      "Confirm any state restrictions and work authorization directly in the application.",
    );

  const outsideAmericas = job.location.match(
    /\b(?:EMEA|Europe|European Union|APAC|Asia Pacific|Australia|New Zealand)\b/i,
  );
  if (
    knownCountry &&
    inAmericas(country) &&
    outsideAmericas &&
    !/\b(?:LATAM|Latin America|Americas|AMER|worldwide|global|anywhere)\b/i.test(
      job.location,
    ) &&
    !allowed?.has(country) &&
    !conflict
  )
    blockers.push(
      `The listed hiring region (${outsideAmericas[0]}) does not include your working country.`,
    );
  // A short ATS location field can name the employer's country even when its
  // description explicitly welcomes LATAM. Preserve these for review.
  const locationCountries = mentions(job.location);
  if (
    knownCountry &&
    allowed === null &&
    locationCountries.length &&
    !locationCountries.some((value) => value.country === country) &&
    !blockers.length &&
    !conflict
  )
    unknowns.push(
      "The listed country and broader remote scope need confirmation for your working country.",
    );
  return { blockers: [...new Set(blockers)], unknowns: [...new Set(unknowns)] };
}
