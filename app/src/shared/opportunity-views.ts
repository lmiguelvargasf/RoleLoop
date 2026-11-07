import { isTrackedApplication } from "./application-board.js";
import { recommendationForJob } from "./job-recommendations.js";
import type { Opportunity, Preferences } from "./types.js";

export type OpportunityView = "recommended" | "all" | "archived";

/** Recommendations are actionable candidates; all saved jobs remain accessible. */
export function opportunityMatchesView(
  opportunity: Opportunity,
  preferences: Preferences,
  view: OpportunityView,
): boolean {
  if (view === "archived") return opportunity.stage === "archived";
  if (opportunity.stage === "archived") return false;

  if (view === "recommended")
    return (
      !isTrackedApplication(opportunity) &&
      recommendationForJob(opportunity, preferences).recommendable
    );
  return view === "all";
}
