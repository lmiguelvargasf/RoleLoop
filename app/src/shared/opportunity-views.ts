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

/** Saved roles stay accessible while Matches enforces current eligibility. */
export function opportunityMatchesView(
  opportunity: Opportunity,
  preferences: Preferences,
  view: OpportunityView,
): boolean {
  if (view === "archived") return opportunity.stage === "archived";
  if (opportunity.stage === "archived") return false;

  if (view === "review") return needsReview(opportunity, preferences);
  if (view === "matches") return isPotentialJobMatch(opportunity, preferences);
  return view === "all";
}
