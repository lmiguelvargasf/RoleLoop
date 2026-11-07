import { industryCatalog, preferredIndustryMatches } from "./industries";
import { careerFacts, type Opportunity, type Profile } from "./types";

const clean = (text: string) =>
  text
    .replace(/^Startup research lead from a Show HN post:\s*/i, "")
    .replace(/^Show HN:\s*/i, "")
    .replace(/(?:^|\s)#{1,6}\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function startupSummary(op: Opportunity): string {
  // Website research stores the publisher's meta description before the page
  // body. Keep that useful introduction instead of concatenating navigation,
  // repeated headings and the entire scraped page into a list preview.
  const introduction = op.description.trim().split(/\n\s*\n/)[0] ?? "";
  const text = clean(introduction || op.title);
  if (text.length <= 600) return text;
  const end = text.lastIndexOf(" ", 600);
  return `${text.slice(0, end > 400 ? end : 600).trimEnd()}…`;
}

export function startupIndustries(op: Opportunity): {
  labels: string[];
  listed: boolean;
} {
  const listed = [
    ...new Set(
      op.signals
        .filter((signal) => /^Seedcamp sector:\s*/i.test(signal))
        .map((signal) => signal.replace(/^Seedcamp sector:\s*/i, "").trim())
        .filter(Boolean),
    ),
  ];
  if (listed.length) return { labels: listed, listed: true };
  const product = { ...op, description: startupSummary(op) };
  const labels = preferredIndustryMatches(product, {
    industries: [...industryCatalog],
    industryPreference: "prefer",
  });
  if (
    !labels.includes("AI") &&
    /\b(nlp|machine learning|language models?|coding agents?)\b/i.test(
      `${op.title} ${product.description}`,
    )
  )
    labels.unshift("AI");
  if (
    !labels.includes("Developer tools") &&
    /\b(coding agents?|(?:typescript|javascript|web) framework|software development kit|sdk)\b/i.test(
      `${op.title} ${product.description}`,
    )
  )
    labels.push("Developer tools");
  return { labels: labels.slice(0, 4), listed: false };
}

export function hasSupportedStartupContribution(
  op: Opportunity,
  profile: Profile,
): boolean {
  const assessment = op.assessment;
  const ids = assessment?.relevantEvidenceIds ?? [];
  const evidence = careerFacts(profile)?.evidence ?? [];
  return (
    assessment?.startupFit?.method === "semantic" &&
    assessment.startupFit.status === "potential" &&
    ids.length > 0 &&
    ids.every((id) => evidence.some((fact) => fact.id === id && fact.verified))
  );
}

export function startupHighlights(op: Opportunity): string[] {
  return [
    ...new Set(
      op.signals
        .filter((signal) => !/^Seedcamp sector:/i.test(signal))
        .map(clean),
    ),
  ].slice(0, 3);
}
