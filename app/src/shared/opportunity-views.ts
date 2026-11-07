import { followUpDue, matchesTargetRole } from "./discovery.js";
import { isPotentialJobMatch, needsLocationReview } from "./job-matches.js";
import type { Opportunity, Preferences } from "./types.js";

export type OpportunityView =
  "matches" | "review" | "applications" | "all" | "archived";

const preparationStages = new Set([
  "new",
  "review",
  "ready",
  "drafted",
  "approved",
]);
const applicationStatuses = new Set([
  "applied",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
]);

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
  today = new Date().toLocaleDateString("en-CA"),
): boolean {
  if (view === "archived")
    return opportunity.stage === "archived" && detail === "all";
  if (opportunity.stage === "archived") return false;

  if (view === "applications") {
    if (
      opportunity.kind !== "job" ||
      !opportunity.application ||
      opportunity.application.status === "saved"
    )
      return false;
    if (detail === "all") return true;
    if (detail === "followups") return followUpDue(opportunity, today);
    return (
      applicationStatuses.has(detail) &&
      opportunity.application.status === detail
    );
  }

  if (view === "review") {
    if (!needsReview(opportunity, preferences)) return false;
    if (detail === "all") return true;
    if (detail === "location-review")
      return needsLocationReview(opportunity, preferences);
    if (detail === "fit-review")
      return !needsLocationReview(opportunity, preferences);
    return false;
  }

  if (view === "matches") {
    if (!isPotentialJobMatch(opportunity, preferences)) return false;
  } else if (view !== "all") return false;

  if (detail === "all") return true;
  if (preparationStages.has(detail)) return opportunity.stage === detail;
  if (view === "all" && opportunity.kind === "job") {
    if (detail === "excluded")
      return opportunity.assessment?.recommendation === "excluded";
    if (detail === "location-review")
      return needsLocationReview(opportunity, preferences);
  }
  return false;
}
