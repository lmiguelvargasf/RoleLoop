import { matchesTargetRole } from "./discovery.js";
import { isPotentialJobMatch, needsLocationReview } from "./job-matches.js";
import type { Opportunity, Preferences } from "./types.js";

export type OpportunityView = "matches" | "review" | "all" | "archived";

function needsReview(
  opportunity: Opportunity,
  preferences: Preferences,
): boolean {
  return (
    opportunity.kind === "job" &&
    opportunity.assessment?.recommendation !== "excluded" &&
    matchesTargetRole(
      opportunity.title,
      preferences.roles,
      opportunity.company,
    ) &&
    (!opportunity.assessment ||
      opportunity.assessment.recommendation === "review" ||
      needsLocationReview(opportunity, preferences))
  );
}

/** A detail always narrows its main view; it never replaces eligibility checks. */
export function opportunityMatchesView(
  opportunity: Opportunity,
  preferences: Preferences,
  view: OpportunityView,
  detail = "all",
): boolean {
  if (view === "archived")
    return opportunity.stage === "archived" && detail === "all";
  if (opportunity.stage === "archived") return false;

  if (view === "review") {
    if (!needsReview(opportunity, preferences)) return false;
    if (detail === "all") return true;
    if (detail === "location-review")
      return needsLocationReview(opportunity, preferences);
    if (detail === "fit-review")
      return !needsLocationReview(opportunity, preferences);
    return false;
  }

  if (view === "matches")
    return detail === "all" && isPotentialJobMatch(opportunity, preferences);
  if (view !== "all") return false;

  if (detail === "all") return true;
  if (opportunity.kind === "job") {
    if (detail === "excluded")
      return opportunity.assessment?.recommendation === "excluded";
    if (detail === "location-review")
      return needsLocationReview(opportunity, preferences);
  }
  return false;
}
