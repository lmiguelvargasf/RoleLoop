import { normalizeCountry } from "../domain/geography.js";
import { matchesTargetRole } from "./discovery.js";
import { JOB_RECOMMENDATION_RULES_VERSION } from "./job-recommendations.js";
import type { Opportunity, Preferences } from "./types.js";

export function jobLocationAssessment(
  opportunity: Opportunity,
  preferences: Preferences,
): { status: "eligible" | "review" | "excluded"; reasons: string[] } {
  const geography = opportunity.assessment?.geography;
  // Old or differently scoped assessments never establish current eligibility.
  if (
    !geography ||
    (opportunity.assessment?.rulesVersion ?? 0) <
      JOB_RECOMMENDATION_RULES_VERSION ||
    !preferences.country.trim() ||
    normalizeCountry(geography.workingCountry) !==
      normalizeCountry(preferences.country)
  )
    return {
      status: "review",
      reasons: [
        "Hiring eligibility has not been checked for your current working country.",
      ],
    };
  return geography;
}

export function jobLocationStatus(
  opportunity: Opportunity,
  preferences: Preferences,
): "eligible" | "review" | "excluded" {
  return jobLocationAssessment(opportunity, preferences).status;
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
