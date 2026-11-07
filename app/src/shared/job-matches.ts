import { normalizeCountry } from "../domain/geography.js";
import { matchesTargetRole } from "./discovery.js";
import type { Opportunity, Preferences } from "./types.js";

export function jobLocationStatus(
  opportunity: Opportunity,
  preferences: Preferences,
): "eligible" | "review" | "excluded" {
  const geography = opportunity.assessment?.geography;
  // Old or differently scoped assessments never establish current eligibility.
  if (
    !geography ||
    !preferences.country.trim() ||
    normalizeCountry(geography.workingCountry) !==
      normalizeCountry(preferences.country)
  )
    return "review";
  return geography.status;
}

export function isPotentialJobMatch(
  opportunity: Opportunity,
  preferences: Preferences,
): boolean {
  return (
    opportunity.kind === "job" &&
    opportunity.stage !== "archived" &&
    opportunity.assessment?.recommendation !== "excluded" &&
    jobLocationStatus(opportunity, preferences) === "eligible" &&
    matchesTargetRole(opportunity.title, preferences.roles, opportunity.company)
  );
}

export function needsLocationReview(
  opportunity: Opportunity,
  preferences: Preferences,
): boolean {
  return (
    opportunity.kind === "job" &&
    opportunity.stage !== "archived" &&
    opportunity.assessment?.recommendation !== "excluded" &&
    jobLocationStatus(opportunity, preferences) === "review" &&
    matchesTargetRole(opportunity.title, preferences.roles, opportunity.company)
  );
}
