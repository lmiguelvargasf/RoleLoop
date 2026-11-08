import { ArrowRight, CalendarClock } from "lucide-react";
import type { Bootstrap, Opportunity } from "../shared/types";
import { recommendationForJob } from "../shared/job-recommendations";
import { jobEngagement } from "../shared/job-engagement";
import {
  localDateKey,
  nextRecommendedJobs,
  postingRecency,
  recentMilestones,
  selectedApplications,
  todayActions,
  type TodayAction,
} from "../shared/today";
import { ApplicationPreparation } from "./ApplicationPreparation";
import { safeUrl } from "./api";
import "./today.css";

export interface TodayPageProps {
  /** Full, production-ranked bootstrap collection, including tracked history. */
  data: Bootstrap;
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
  onOpenOpportunity: (opportunity: Opportunity) => void;
  now?: Date;
}

function FollowUp({ action, today }: { action: TodayAction; today: string }) {
  if (!action.followUpOn) return null;
  const date = new Date(`${action.followUpOn}T12:00:00`).toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  );
  return (
    <span className={`today-follow-up${action.overdue ? " overdue" : ""}`}>
      <CalendarClock size={13} aria-hidden="true" />
      {action.overdue
        ? `Overdue · ${date}`
        : action.followUpOn === today
          ? "Due today"
          : `Follow up ${date}`}
    </span>
  );
}

export function TodayPage({
  data,
  busy,
  perform,
  onOpenOpportunity,
  now = new Date(),
}: TodayPageProps) {
  const actions = todayActions(data.opportunities, now);
  const selected = selectedApplications(data.opportunities);
  const recommended = nextRecommendedJobs(
    data.opportunities,
    data.preferences,
    3,
    now,
  );
  const today = localDateKey(now);
  const metrics = recentMilestones(data.opportunities, now);

  return (
    <div className="page today-page">
      <header className="page-heading today-header">
        <div>
          <p className="today-date">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <h1>Today</h1>
        </div>
      </header>

      <section className="today-outcomes" aria-labelledby="today-outcomes-title">
        <div className="today-outcomes-heading">
          <h2 id="today-outcomes-title">Last 7 days</h2>
          <span>Including today</span>
        </div>
        <dl className="today-metrics">
          <div>
            <dt>Applications submitted</dt>
            <dd>{metrics.submitted}</dd>
          </div>
          <div>
            <dt>Replies &amp; conversations</dt>
            <dd>{metrics.replies}</dd>
          </div>
          <div>
            <dt>Reached interview</dt>
            <dd>{metrics.interviews}</dd>
          </div>
          <div>
            <dt>Offers received</dt>
            <dd>{metrics.offers}</dd>
          </div>
        </dl>
      </section>

      {actions.length > 0 && (
        <section
          className="today-section"
          aria-labelledby="today-priority-title"
        >
          <div className="today-section-heading">
            <h2 id="today-priority-title">Needs attention</h2>
            {actions.length > 3 && (
              <div className="today-board-links">
                <a href="#applications">Applications</a>
                <a href="#outreach">Outreach</a>
              </div>
            )}
          </div>
          <ul className="today-action-list">
            {actions.slice(0, 3).map((action) => (
              <li key={action.opportunity.id} className="today-action">
                <span className="today-action-kind">{action.label}</span>
                <div className="today-action-content">
                  <button
                    type="button"
                    className="today-opportunity-title"
                    onClick={() => onOpenOpportunity(action.opportunity)}
                  >
                    {action.opportunity.company}
                    <span>
                      {action.opportunity.kind === "job"
                        ? action.opportunity.title
                        : "Startup outreach"}
                    </span>
                  </button>
                  <p>{action.nextAction}</p>
                  <FollowUp action={action} today={today} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selected.length > 0 && (
        <section
          className="today-section"
          aria-labelledby="today-applications-title"
        >
          <div className="today-section-heading">
            <h2 id="today-applications-title">To apply</h2>
            <a href="#applications" className="text-link">
              View all <ArrowRight size={14} aria-hidden="true" />
            </a>
          </div>
          <ul className="today-application-list">
            {selected.slice(0, 3).map((opportunity) => (
              <li key={opportunity.id}>
                <button
                  type="button"
                  className="today-opportunity-title"
                  onClick={() => onOpenOpportunity(opportunity)}
                >
                  {opportunity.company}
                  <span>{opportunity.title}</span>
                </button>
                <ApplicationPreparation
                  opportunity={opportunity}
                  drafts={data.drafts}
                  runs={data.runs}
                  busy={busy}
                  perform={perform}
                  onReviewFit={() => onOpenOpportunity(opportunity)}
                  compact
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className="today-section"
        aria-labelledby="today-recommendations-title"
      >
        <div className="today-section-heading">
          <h2 id="today-recommendations-title">Recommended jobs</h2>
          <a href="#jobs" className="text-link">
            Browse jobs <ArrowRight size={14} aria-hidden="true" />
          </a>
        </div>
        {recommended.length ? (
          <ul className="today-recommended-list">
            {recommended.map((opportunity) => {
              const fit = recommendationForJob(opportunity, data.preferences);
              const engagement = jobEngagement(opportunity);
              const recency = postingRecency(opportunity, now);
              const sourceUrl = safeUrl(opportunity.sourceAttributionUrl ?? "");
              return (
                <li key={opportunity.id}>
                  <div className="today-recommendation-content">
                    <p className="today-company">{opportunity.company}</p>
                    <h3>{opportunity.title}</h3>
                    <p className="today-job-meta">
                      <span>
                        {recency.band === "unknown"
                          ? "Posting date unconfirmed"
                          : recency.label}
                      </span>
                      {engagement.kind !== "unknown" && (
                        <span>{engagement.label}</span>
                      )}
                      {engagement.hoursLabel && (
                        <span>{engagement.hoursLabel}</span>
                      )}
                    </p>
                    <div className="today-job-notes">
                      {Boolean(
                        fit.question || opportunity.assessment?.unknowns.length,
                      ) && <span>Details to confirm</span>}
                      {sourceUrl && (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="today-source-link"
                        >
                          {opportunity.source === "himalayas"
                            ? "Himalayas"
                            : "Source listing"}{" "}
                          ↗
                        </a>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="button today-review"
                    onClick={() => onOpenOpportunity(opportunity)}
                    aria-label={`Review ${opportunity.title} at ${opportunity.company}`}
                  >
                    Review job <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="today-empty">
            No recommended jobs yet. Browse jobs to start a search or review
            your saved roles.
          </p>
        )}
      </section>
    </div>
  );
}
