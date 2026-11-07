import type { Opportunity } from "../shared/types.js";

type GeographicJob = Pick<
  Opportunity,
  "location" | "description" | "remoteScope"
> &
  Partial<Pick<Opportunity, "title">>;
export type GeographyAssessment = {
  status: "eligible" | "review" | "excluded";
  blockers: string[];
  unknowns: string[];
};

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

// City names are read only from location fields or explicit hiring clauses.
// This deliberately finite dictionary is not a guess for every place name:
// unfamiliar cities remain unresolved instead of becoming worldwide eligibility.
const cityCountries = new Map<string, string>();
for (const [code, cities] of Object.entries({
  IN: "Bangalore|Bengaluru|Mumbai|New Delhi|Delhi|Hyderabad|Chennai|Pune|Kolkata|Gurgaon|Gurugram|Noida|Ahmedabad",
  CN: "Beijing|Shanghai|Shenzhen|Guangzhou|Hangzhou",
  JP: "Tokyo|Osaka|Yokohama",
  KR: "Seoul|Busan",
  TW: "Taipei",
  TH: "Bangkok",
  MY: "Kuala Lumpur",
  ID: "Jakarta",
  PH: "Manila|Quezon City",
  VN: "Hanoi|Ho Chi Minh City",
  BD: "Dhaka",
  PK: "Karachi|Islamabad|Lahore",
  LK: "Colombo",
  NP: "Kathmandu",
  AE: "Dubai|Abu Dhabi",
  EC: "Quito|Guayaquil",
})) {
  for (const city of cities.split("|"))
    cityCountries.set(fold(city), countryCodes.get(code)!);
}

type Region =
  | "latam"
  | "americas"
  | "northAmerica"
  | "southAmerica"
  | "europe"
  | "eu"
  | "asia"
  | "apac"
  | "emea"
  | "africa"
  | "oceania";
const countriesFromCodes = (codes: string) =>
  new Set(codes.split(" ").map((code) => countryCodes.get(code)!));
const europe = countriesFromCodes(
  "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA",
);
const eu = countriesFromCodes(
  "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK",
);
const asia = countriesFromCodes(
  "AE AF AM AZ BD BH BN BT CC CN CX GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
);
const africa = countriesFromCodes(
  "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
);
const oceania = countriesFromCodes(
  "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS",
);
const northAmerica = countriesFromCodes(
  "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI",
);
const southAmerica = countriesFromCodes(
  "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
);
// APAC is a commercial region with variable boundaries. Only its common core
// establishes compatibility; Western/Central Asian membership stays unresolved.
const apac = countriesFromCodes(
  "AU BD BN BT CN FJ HK ID IN JP KH KI KP KR LA LK MH MM MN MO MV MY NC NP NR NU NZ PF PG PH PK PW SB SG TH TL TO TV TW VN VU WS",
);
const middleEast = countriesFromCodes(
  "AE BH EG IL IQ IR JO KW LB OM PS QA SA SY TR YE",
);
const regionContains = (region: Region, country: string) => {
  if (region === "latam") return isLatam(country);
  if (region === "americas") return inAmericas(country);
  if (region === "northAmerica") return northAmerica.has(country);
  if (region === "southAmerica") return southAmerica.has(country);
  if (region === "europe") return europe.has(country);
  if (region === "eu") return eu.has(country);
  if (region === "asia") return asia.has(country);
  if (region === "africa") return africa.has(country);
  if (region === "oceania") return oceania.has(country);
  if (region === "emea")
    return (
      europe.has(country) || africa.has(country) || middleEast.has(country)
    );
  return apac.has(country);
};
const regionName: Record<Region, string> = {
  latam: "Latin America",
  americas: "the Americas",
  northAmerica: "North America",
  southAmerica: "South America",
  europe: "Europe",
  eu: "the European Union",
  asia: "Asia",
  apac: "Asia Pacific",
  emea: "EMEA",
  africa: "Africa",
  oceania: "Oceania",
};
const regionPattern =
  "LATAM|Latin America|North America|South America|Americas|AMER|EMEA|Europe|European Union|APAC|Asia[ -]Pacific|Asia|Africa|Oceania";
function regionKey(value: string): Region {
  if (/^(?:LATAM|Latin America)$/i.test(value)) return "latam";
  if (/^(?:Americas|AMER)$/i.test(value)) return "americas";
  if (/^(?:APAC|Asia[ -]Pacific)$/i.test(value)) return "apac";
  if (/^North America$/i.test(value)) return "northAmerica";
  if (/^South America$/i.test(value)) return "southAmerica";
  if (/^European Union$/i.test(value)) return "eu";
  return value.toLowerCase() as Region;
}
function regionMentions(value: string) {
  return [
    ...value.matchAll(new RegExp(`\\b(?:${regionPattern})\\b`, "gi")),
  ].map((match) => regionKey(match[0]));
}
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
function mentions(
  text: string,
  explicitCountries = false,
  includeCities = false,
): CountryMention[] {
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
  if (includeCities) {
    for (const [city, country] of cityCountries) {
      for (const match of normalized.matchAll(
        new RegExp(`\\b${escape(city)}\\b`, "g"),
      ))
        found.push({
          country,
          start: match.index!,
          end: match.index! + match[0].length,
        });
    }
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
    true,
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
  const regions = new Set<Region>();
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
    if (
      /\b(?:time\s*zones?|hours|overlap)\b/i.test(clause) &&
      /\b(?:must|need to|required|working hours|business hours|overlap)\b/i.test(
        clause,
      ) &&
      !/\b(?:not required|no need|optional)\b/i.test(clause)
    )
      timezone = true;
    if (incidental(clause)) {
      ignoreScope();
      continue;
    }
    const interpretedBefore = allowed.length + excluded.size + regions.size;
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
      new RegExp(`\\b(${regionPattern})\\s*[-–—]?\\s*only\\b`, "gi"),
    )) {
      if (!negated(clause.slice(0, match.index!)))
        regions.add(regionKey(match[1]));
      else if (/LATAM|Latin America/i.test(match[1]))
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
      /\b(?:(?:(?:must|need to|have to|are required to)\s+(?:be\s+)?(?:based|located|reside|residing|live|living|work|working|(?:a\s+)?resident)\s+(?:in|from|within|of))|(?:(?:hire|hiring|recruiting|accepting (?:applications|candidates|applicants))\s+(?:only\s+)?(?:(?:candidates?|applicants?|people|residents?)\s+)?(?:(?:based|located|residing)\s+)?(?:in|from))|(?:(?:this\s+)?(?:role|position|job|opportunity)\s+(?:is\s+)?(?:only\s+)?(?:open|available|restricted|limited)\s+(?:only\s+)?(?:to|in|for)\s+(?:(?:candidates?|applicants?|people|residents?)\s+)?(?:(?:based|located|residing)\s+)?(?:(?:in|from|of)\s+)?)|(?:(?:eligible|permitted|allowed|supported|hiring)\s+(?:countries|locations)\s*:)|(?:(?:work|duties|services)\s+must\s+be\s+(?:performed|done|carried out)\s+(?:in|from|within))|(?:(?:this\s+)?(?:role|position|job)\s+(?:is\s+)?(?:based|located)\s+(?:in|within|out of))|(?:(?:candidates?|applicants?|you)\s+(?:may|can|will)\s+(?:work|be based|reside|live)\s+(?:in|from))|(?:(?:work(?:\s+remotely)?|remote)\s+(?:from\s+)?anywhere\s+(?:in|within|across|throughout))|(?:(?:remote|remotely)\s+(?:within|in|from)))\s*/gi;
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
            new RegExp(`^\\s*(?:the\\s+)?(${regionPattern})\\b(.*)$`, "i"),
          );
        if (region) {
          if (/\b(?:or|and)\b/i.test(region[2])) unclear = true;
          else if (/\b(?:time\s*zones?|hours)\b/i.test(region[2]))
            timezone = true;
          else regions.add(regionKey(region[1]));
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
    for (const mention of mentions(clause, false, true)) {
      const list = listAfter(clause, mention.start);
      if (
        list &&
        /^\s+residents?\b/i.test(clause.slice(list.end)) &&
        /\b(?:role|position|job)\s+(?:is\s+)?for\s*$/i.test(
          clause.slice(0, mention.start),
        )
      )
        addAllowed(list);
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
      /\b(?:citizens?|citizenship|nationals?|nationality|work authori[sz]ation|authori[sz]ed to work|visa|selected countries|certain countries)\b/i.test(
        clause,
      ) &&
      /\b(?:must|require(?:s|d)?|only|restrict|eligible|available|need|cannot|can't)\b/i.test(
        clause,
      )
    )
      unclear = true;
    // Unrecognized candidate-location assertions must not inherit a broad
    // worldwide label. Review them rather than guess the employer's intent.
    // Parsed restrictions and explicitly optional/negated residence statements
    // retain their more precise treatment above.
    const residenceAssertion =
      /\b(?:residency|residence|location requirement)\b|\b(?:supported|eligible|permitted|allowed|hiring)\s+(?:countries|locations)\b|\b(?:candidates?|applicants?|you)\b.{0,80}\b(?:based|located|reside|residing|live|living)\b|\b(?:role|position|job)\b.{0,40}\b(?:based|located)\b|\bonly (?:consider|accept)\s+(?:candidates?|applicants?)\b/i.test(
        clause,
      );
    if (
      residenceAssertion &&
      allowed.length + excluded.size + regions.size === interpretedBefore &&
      !/\b(?:not required|no need|do not need|don't need|optional|not (?:be )?(?:based|located))\b/i.test(
        clause,
      ) &&
      !/\b(?:time\s*zones?|hours|overlap)\b/i.test(clause)
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

function worldwideRemote(clause: string): boolean {
  const coverage = clause.match(
    /\bremote(?:ly)?\s*[-–—:,·(]*\s*(?:(?:work|working|role|position|job)\s+)?(?:worldwide|globally|(?:from\s+)?anywhere(?!\s+(?:in|within|across|throughout)\s+(?!(?:the\s+)?world\b)))\b|\b(?:work|working|hire|hiring|recruiting)\s+(?:remotely\s+)?(?:from\s+)?(?:worldwide|globally|anywhere(?!\s+(?:in|within|across|throughout)\s+(?!(?:the\s+)?world\b)))\b|^(?:worldwide|global|anywhere)\s*[-–—:,·(]*\s*remote(?:\s+(?:role|position|job|work|opportunity))?[). ]*$/i,
  );
  return Boolean(
    coverage &&
      !/\b(?:not|never|no|no longer|cannot|can't|unable to)\s+(?:\w+\s+){0,2}$/i.test(
        clause.slice(0, coverage.index),
      ),
  );
}

// Shared by connectors and stored-record reassessment: office requirements
// take precedence over broad remote wording, while alternatives and descriptions
// of other teams do not become requirements for this role.
export function requiresPhysicalPresence(text: string): boolean {
  return text.split(/[\n.!?;]+/).some((raw) => {
    const clause = raw.trim();
    const required = clause.match(
      /\bhybrid\s+(?:role|position|work|schedule|working|office)|\b(?:role|position|work|schedule|working)\s+(?:is\s+)?hybrid\b|\bon[- ]?site\s+(?:role|position|work|office)|\b(?:work|working)\s+on[- ]?site\b|\b(?:must|required to)\s+(?:attend|work in|come to|be in)\s+(?:the |an |our )?office|^(?:hybrid|on[- ]?site)(?:\s*[-–—,:()]|$)/i,
    );
    if (!required) return false;
    const before = clause.slice(0, required.index);
    if (
      /\b(?:not|never|no|no longer)\s+(?:a\s+)?$|\boptional(?:ly)?\s+(?:a\s+)?$/i.test(
        before,
      )
    )
      return false;
    const mandatory =
      /\bmust\b/i.test(clause) ||
      (/\b(?:required|mandatory)\b/i.test(clause) &&
        !/\b(?:not required|not mandatory)\b/i.test(clause));
    if (
      !mandatory &&
      /\b(?:on[- ]?site|hybrid|office)\s+(?:(?:work|working|attendance|schedule|schedules|role|position)\s+)*(?:(?:is|are)\s+)?(?:not required|not mandatory|optional)\b/i.test(
        clause,
      )
    )
      return false;
    if (
      /\b(?:other|some)\s+(?:teams?|roles?|positions?|employees?)\b/i.test(
        clause,
      ) &&
      !/\b(?:this|the)\s+(?:role|position|job)\b/i.test(clause) &&
      !mandatory
    )
      return false;
    if (
      !mandatory &&
      /\b(?:can|may|choose|choice|option)\b/i.test(clause) &&
      /\bremote(?:ly)?\b.*\bor\b.*\b(?:hybrid|on[- ]?site)\b|\b(?:hybrid|on[- ]?site)\b.*\bor\b.*\bremote(?:ly)?\b/i.test(
        clause,
      )
    )
      return false;
    return true;
  });
}

export function assessGeography(
  job: GeographicJob,
  workingCountry: string,
): GeographyAssessment {
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
  if (
    job.remoteScope === "onsite" ||
    requiresPhysicalPresence(`${job.location}\n${job.description}`)
  )
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

  if (!conflict && allowed === null && knownCountry) {
    for (const region of evidence.regions)
      if (!regionContains(region, country)) {
        if (region === "apac" && (asia.has(country) || oceania.has(country)))
          unknowns.push(
            "The posting uses APAC without a country list. Confirm whether your working country is included.",
          );
        else
          blockers.push(
            `This opportunity is restricted to ${regionName[region]}.`,
          );
      }
  }

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

  const remoteClauses = `${job.location}\n${job.description}`
    .split(/[\n.!?;]+/)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        clause &&
        !incidental(clause) &&
        !/\b(?:salary|compensation|pay range|benefits?)\b/i.test(clause),
    );
  const remote = remoteClauses.some(
    (clause) =>
      /\bremote(?:ly)?\b/i.test(clause) &&
      !/\b(?:not|never|no longer)\s+(?:fully\s+)?remote(?:ly)?\b/i.test(clause),
  );
  const worldwide =
    remoteClauses.some(worldwideRemote) ||
    (remote &&
      /^(?:(?:fully )?remote\s*[-–—:,·(]*\s*)?(?:worldwide|global|anywhere(?: in the world)?)(?:\s*[-–—:,·(]*\s*remote)?[). ]*$/i.test(
        job.location.trim(),
      ));
  const directWorldwidePermission = job.description
    .split(/[\n.!?;]+/)
    .some(
      (clause) =>
        worldwideRemote(clause) &&
        /\b(?:this (?:role|position|job)|(?:candidates?|applicants?|you) (?:may|can))\b/i.test(
          clause,
        ),
    );

  const locationIsContext = incidental(job.location);
  const locationRegions = locationIsContext ? [] : regionMentions(job.location);
  const compatibleLocationRegion = locationRegions.some((region) =>
    regionContains(region, country),
  );
  const locationCountries = locationIsContext
    ? []
    : mentions(job.location, false, true);
  const listedCountryCompatible = locationCountries.some(
    (value) => value.country === country,
  );
  // A concrete job-location field is a restriction, not a worldwide signal.
  // Preserve conflicting explicit coverage for review rather than inventing
  // which source field the employer intended to take precedence.
  const explicitCompatibleRegion = [...evidence.regions].some((region) =>
    regionContains(region, country),
  );
  const descriptionRegion = regionMentions(job.description).some(
    (region) =>
      regionContains(region, country) &&
      new RegExp(
        `\\bremote\\s*[-–—:,·(]*\\s*(?:${region === "latam" ? "LATAM|Latin America" : regionName[region].replace(/^the /, "")})\\b`,
        "i",
      ).test(job.description),
  );
  const broadLocation = /\b(?:worldwide|globally|anywhere)\b/i.test(
    job.location,
  );
  const differentLocation =
    knownCountry &&
    !listedCountryCompatible &&
    !compatibleLocationRegion &&
    (locationCountries.length > 0 || locationRegions.length > 0);
  if (differentLocation && !conflict && !blockers.length) {
    if (
      allowed?.has(country) ||
      explicitCompatibleRegion ||
      descriptionRegion ||
      broadLocation ||
      directWorldwidePermission
    ) {
      unknowns.push(
        "The listed country and broader remote scope need confirmation for your working country.",
      );
    } else if (
      locationRegions.includes("apac") &&
      (asia.has(country) || oceania.has(country))
    ) {
      unknowns.push(
        "The posting uses APAC without a country list. Confirm whether your working country is included.",
      );
    } else if (locationRegions.length) {
      blockers.push(
        `The listed hiring region (${locationRegions.map((region) => regionName[region].replace(/^the /, "")).join(", ")}) does not include your working country.`,
      );
    } else {
      const names = [
        ...new Set(locationCountries.map((value) => labels.get(value.country))),
      ].join(", ");
      blockers.push(
        `The listed job location (${names}) does not include your working country (${labels.get(country)}).`,
      );
    }
  }

  const compatibleRemoteRegion = remoteClauses.some(
    (clause) =>
      /\bremote\b/i.test(clause) &&
      regionMentions(clause).some((region) => regionContains(region, country)),
  );
  // A recognizable location alone does not establish remote work; an unknown
  // city is not treated as global merely because the text says "remote".
  const neutralLocation =
    /^(?:remote|fully remote|100% remote|worldwide|global|anywhere(?: in the world)?|location (?:to confirm|unknown)|unknown|not (?:specified|provided)|[\s,·:()–—-])+$/i.test(
      job.location.trim(),
    );
  const unresolvedLocation =
    Boolean(job.location.trim()) &&
    !neutralLocation &&
    !locationIsContext &&
    !locationCountries.length &&
    !locationRegions.length;
  if (unresolvedLocation && !blockers.length)
    unknowns.push(
      "The listed location could not be resolved to a hiring country. Confirm eligibility before applying.",
    );
  const compatible =
    knownCountry &&
    remote &&
    (Boolean(allowed?.has(country)) ||
      listedCountryCompatible ||
      compatibleLocationRegion ||
      explicitCompatibleRegion ||
      compatibleRemoteRegion ||
      worldwide);
  if (!compatible && !blockers.length && !unknowns.length)
    unknowns.push(
      "The posting does not confirm remote hiring from your working country.",
    );
  if (
    !remote &&
    !blockers.length &&
    !unknowns.includes(
      "Remote location and hiring arrangement need confirmation.",
    )
  )
    unknowns.push("Remote location and hiring arrangement need confirmation.");
  // Working hours need review before drafting, but do not by themselves
  // disqualify an explicitly supported country from the application shortlist.
  const unresolvedEligibility = unknowns.some(
    (message) =>
      message !==
      "Required working hours or time-zone overlap need confirmation.",
  );
  return {
    status: blockers.length
      ? "excluded"
      : unresolvedEligibility || !compatible
        ? "review"
        : "eligible",
    blockers: [...new Set(blockers)],
    unknowns: [...new Set(unknowns)],
  };
}
