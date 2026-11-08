import { isTrackedApplication } from "./application-board.js";
import { recommendationForJob } from "./job-recommendations.js";
import type { Opportunity, Preferences } from "./types.js";

export type OpportunityView = "recommended" | "all" | "archived";

/** Expired feed listings leave discovery; application history remains on its board. */
export function isExpiredFeedListing(
  opportunity: Opportunity,
  now = Date.now(),
): boolean {
  return (
    opportunity.kind === "job" &&
    ["himalayas", "weworkremotely"].includes(
      opportunity.sourceKey.split(":")[0] || opportunity.source,
    ) &&
    !!opportunity.sourceExpiresAt &&
    Date.parse(opportunity.sourceExpiresAt) <= now
  );
}

/** Selected jobs leave discovery; archived application history stays recoverable. */
export function opportunityMatchesView(
  opportunity: Opportunity,
  preferences: Preferences,
  view: OpportunityView,
): boolean {
  const expired = isExpiredFeedListing(opportunity);
  if (view === "archived")
    return (
      opportunity.stage === "archived" &&
      (!expired || isTrackedApplication(opportunity))
    );
  if (expired) return false;
  if (opportunity.stage === "archived") return false;
  if (isTrackedApplication(opportunity)) return false;

  if (view === "recommended")
    return recommendationForJob(opportunity, preferences).recommendable;
  return view === "all";
}
