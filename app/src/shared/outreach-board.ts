import type { Opportunity } from "./types.js";

export type OutreachProgress = NonNullable<Opportunity["outreach"]>;
export type OutreachStatus = OutreachProgress["status"];
export type OutreachColumnId =
  | "to_contact"
  | "contacted"
  | "conversation"
  | "closed";
export const outreachColumns = [
  { id: "to_contact", label: "To contact" },
  { id: "contacted", label: "Contacted" },
  { id: "conversation", label: "In conversation" },
  { id: "closed", label: "Closed" },
] as const satisfies ReadonlyArray<{ id: OutreachColumnId; label: string }>;
export const outreachStatusLabels: Record<OutreachStatus, string> = {
  saved: "To contact",
  contacted: "Contacted",
  conversation: "In conversation",
  closed: "Closed",
};
export const outreachOutcomeLabels: Record<
  NonNullable<OutreachProgress["outcome"]>,
  string
> = {
  opportunity: "Opportunity opened",
  not_interested: "Not interested",
  no_response: "No response",
  withdrawn: "Stopped pursuing",
};
export function isTrackedOutreach(opportunity: Opportunity): boolean {
  return opportunity.kind === "startup" && !!opportunity.outreach;
}
export function outreachColumn(
  opportunity: Opportunity,
): OutreachColumnId | null {
  if (!isTrackedOutreach(opportunity) || opportunity.stage === "archived")
    return null;
  return opportunity.outreach!.status === "saved"
    ? "to_contact"
    : opportunity.outreach!.status;
}
export function outreachProgressFor(
  opportunity: Opportunity,
  status: OutreachStatus,
  outcome?: OutreachProgress["outcome"],
): OutreachProgress {
  return {
    outcome: null,
    contactedAt: null,
    conversationAt: null,
    closedAt: null,
    nextAction: "",
    followUpOn: null,
    notes: "",
    ...opportunity.outreach,
    status,
    ...(outcome === undefined ? {} : { outcome }),
  };
}
export function outreachFollowUpDue(
  opportunity: Opportunity,
  today: string,
): boolean {
  return (
    outreachColumn(opportunity) !== null &&
    opportunity.outreach?.status !== "closed" &&
    !!opportunity.outreach?.followUpOn &&
    opportunity.outreach.followUpOn <= today
  );
}
