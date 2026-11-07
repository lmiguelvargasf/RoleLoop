import type { Opportunity } from "./types";

export function opportunityMatchesQuery(
  opportunity: Opportunity,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searchable = [
    opportunity.company,
    opportunity.title,
    opportunity.description,
    opportunity.location,
    opportunity.companyCountry,
    opportunity.assessment?.fitSummary ?? "",
    ...opportunity.signals,
    ...opportunity.requirements.flatMap((requirement) => [
      requirement.text,
      ...requirement.skills,
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => searchable.includes(term));
}
