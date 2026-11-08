import { applicationColumn } from "./application-board.js";
import { opportunityMatchesView } from "./opportunity-views.js";
import { outreachColumn } from "./outreach-board.js";
import type { Opportunity, Preferences } from "./types.js";

/** Date-only follow-ups follow the user's calendar, never a UTC date slice. */
export function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export interface TodayAction {
  opportunity: Opportunity;
  label: string;
  nextAction: string;
  followUpOn: string | null;
  due: boolean;
  overdue: boolean;
  conversation: boolean;
}

export interface TodayMetrics {
  submitted: number;
  replies: number;
  interviews: number;
  offers: number;
}

export function recentMilestones(
  opportunities: Opportunity[],
  now: Date = new Date(),
): TodayMetrics {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const recent = (value?: string | null) => {
    if (!value) return false;
    const time = Date.parse(value);
    return time >= start.getTime() && time <= now.getTime();
  };
  const metrics: TodayMetrics = {
    submitted: 0,
    replies: 0,
    interviews: 0,
    offers: 0,
  };
  // Archived or closed records retain their milestones. Deduplicate collections
  // if a caller supplies both a full collection and tracked-board records.
  for (const opportunity of new Map(
    opportunities.map((op) => [op.id, op]),
  ).values()) {
    if (opportunity.kind === "job") {
      const progress = opportunity.application;
      if (recent(progress?.appliedAt)) metrics.submitted++;
      if (recent(progress?.repliedAt)) metrics.replies++;
      if (recent(progress?.interviewAt)) metrics.interviews++;
      if (recent(progress?.offerAt)) metrics.offers++;
    } else if (recent(opportunity.outreach?.conversationAt)) metrics.replies++;
  }
  return metrics;
}

export function todayActions(
  opportunities: Opportunity[],
  now: Date = new Date(),
): TodayAction[] {
  const today = localDateKey(now);
  const actions: TodayAction[] = [];
  for (const opportunity of new Map(
    opportunities.map((op) => [op.id, op]),
  ).values()) {
    const application = applicationColumn(opportunity);
    const outreach = outreachColumn(opportunity);
    if (
      (!application && !outreach) ||
      application === "closed" ||
      outreach === "closed"
    )
      continue;
    const progress =
      opportunity.kind === "job"
        ? opportunity.application!
        : opportunity.outreach!;
    const followUpOn = progress.followUpOn;
    const due = !!followUpOn && followUpOn <= today;
    const conversation =
      application === "interview" ||
      application === "offer" ||
      outreach === "conversation";
    const referral = opportunity.application?.referralStatus === "to_ask";
    if (!due && !conversation && !referral) continue;
    const label =
      application === "offer"
        ? "Offer"
        : application === "interview"
          ? "Interview"
          : outreach === "conversation"
            ? "In conversation"
            : due
              ? "Follow-up"
              : "Referral";
    const fallback =
      application === "offer"
        ? "Review the offer and agree on your next step."
        : application === "interview"
          ? "Prepare for your next interview."
          : outreach === "conversation"
            ? "Keep the conversation moving."
            : referral
              ? "Ask your contact for an introduction."
              : "Follow up and record the next step.";
    actions.push({
      opportunity,
      label,
      nextAction: progress.nextAction.trim() || fallback,
      followUpOn,
      due,
      overdue: due && followUpOn! < today,
      conversation,
    });
  }
  return actions.sort(
    (a, b) =>
      Number(b.conversation) - Number(a.conversation) ||
      Number(b.overdue) - Number(a.overdue) ||
      Number(b.due) - Number(a.due) ||
      (a.followUpOn ?? "9999").localeCompare(b.followUpOn ?? "9999") ||
      a.opportunity.company.localeCompare(b.opportunity.company),
  );
}

export function similarJobKey(opportunity: Opportunity): string {
  // Only identical source descriptions qualify. Missing descriptions are not
  // evidence that two listings advertise the same opening.
  if (!opportunity.description.trim()) return JSON.stringify([opportunity.id]);
  return JSON.stringify([
    opportunity.company.trim().toLowerCase(),
    opportunity.title.trim().toLowerCase(),
    opportunity.description.trim(),
  ]);
}

export interface PostingRecency {
  ageDays: number | null;
  band: "recent" | "two_weeks" | "older" | "unknown";
  label: string;
}

/** Publication and source-update dates have different meanings. */
export function postingRecency(
  opportunity: Pick<Opportunity, "publishedAt" | "sourceUpdatedAt">,
  now = new Date(),
): PostingRecency {
  const format = (date: Date) =>
    date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() !== now.getFullYear()
        ? { year: "numeric" as const }
        : {}),
    });
  const published = opportunity.publishedAt
    ? new Date(opportunity.publishedAt)
    : null;
  if (published && Number.isFinite(published.getTime())) {
    // A future timestamp is unconfirmed even when it falls later today.
    if (published.getTime() > now.getTime())
      return {
        ageDays: null,
        band: "unknown",
        label: `Posting date is in the future · ${format(published)} · check source`,
      };
    // Compare calendar days, not elapsed 24-hour periods (including DST days).
    const calendarDay = (date: Date) =>
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const ageDays = Math.round(
      (calendarDay(now) - calendarDay(published)) / 86_400_000,
    );
    return {
      ageDays,
      band: ageDays <= 7 ? "recent" : ageDays <= 14 ? "two_weeks" : "older",
      label: `${ageDays === 0 ? "Posted today" : ageDays === 1 ? "Posted yesterday" : `Posted ${ageDays} days ago`} · ${format(published)}`,
    };
  }
  const updated = opportunity.sourceUpdatedAt
    ? new Date(opportunity.sourceUpdatedAt)
    : null;
  return {
    ageDays: null,
    band: "unknown",
    label: `Posting date unknown${updated && Number.isFinite(updated.getTime()) ? ` · source updated ${format(updated)}` : ""}`,
  };
}

/** Prioritize posting-age bands, preserving production fit order within each. */
export function nextRecommendedJobs(
  rankedOpportunities: Opportunity[],
  preferences: Preferences,
  limit = 5,
  now = new Date(),
): Opportunity[] {
  // A regional copy must not become a new suggestion after its identical
  // posting was selected. Keep every saved record available in All saved.
  const seen = new Set(
    rankedOpportunities
      .filter((op) => op.kind === "job" && !!op.application)
      .map(similarJobKey),
  );
  return rankedOpportunities
    .filter(
      (op) =>
        op.kind === "job" &&
        opportunityMatchesView(op, preferences, "recommended"),
    )
    .map((op, index) => ({ op, index, band: postingRecency(op, now).band }))
    .sort((a, b) => {
      const priority = { recent: 0, two_weeks: 1, older: 2, unknown: 3 };
      return priority[a.band] - priority[b.band] || a.index - b.index;
    })
    .map(({ op }) => op)
    .filter((op) => {
      const key = similarJobKey(op);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function selectedApplications(
  opportunities: Opportunity[],
): Opportunity[] {
  return opportunities.filter((op) => applicationColumn(op) === "to_apply");
}
