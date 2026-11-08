import type { Opportunity } from "./types.js";

export type ApplicationProgress = NonNullable<Opportunity["application"]>;
export type ApplicationStatus = ApplicationProgress["status"];
export type ApplicationColumnId =
  "to_apply" | "applied" | "interview" | "offer" | "closed";

export const applicationColumns = [
  { id: "to_apply", label: "To apply" },
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "closed", label: "Closed" },
] as const satisfies ReadonlyArray<{ id: ApplicationColumnId; label: string }>;

export const applicationStatusLabels: Record<ApplicationStatus, string> = {
  saved: "To apply",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** Membership is explicit progress, retained even when a job is archived. */
export function isTrackedApplication(opportunity: Opportunity): boolean {
  return opportunity.kind === "job" && !!opportunity.application;
}

/** Hiring preferences never remove a job the user chose to track. */
export function applicationColumn(
  opportunity: Opportunity,
): ApplicationColumnId | null {
  if (!isTrackedApplication(opportunity) || opportunity.stage === "archived")
    return null;
  const status = opportunity.application!.status;
  if (status === "saved") return "to_apply";
  if (status === "rejected" || status === "withdrawn") return "closed";
  return status;
}

/** A board move changes status without replacing notes, dates or next steps. */
export function applicationProgressFor(
  opportunity: Opportunity,
  status: ApplicationStatus,
): ApplicationProgress {
  return {
    appliedAt: null,
    interviewAt: null,
    offerAt: null,
    nextAction: "",
    followUpOn: null,
    notes: "",
    ...opportunity.application,
    status,
  };
}

/** Records the user's submission and suggests a follow-up in their local calendar. */
export function submittedApplicationProgress(
  opportunity: Opportunity,
  now = new Date(),
): ApplicationProgress {
  const next = applicationProgressFor(opportunity, "applied");
  const followUp = new Date(now);
  followUp.setDate(followUp.getDate() + 7);
  const day = `${followUp.getFullYear()}-${String(followUp.getMonth() + 1).padStart(2, "0")}-${String(followUp.getDate()).padStart(2, "0")}`;
  return {
    ...next,
    appliedAt: next.appliedAt ?? now.toISOString(),
    followUpOn: next.followUpOn || day,
    nextAction: next.nextAction || "Follow up on application",
  };
}
