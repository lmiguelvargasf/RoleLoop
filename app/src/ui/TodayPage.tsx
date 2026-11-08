import { ArrowRight, CalendarClock, Check, Plus } from "lucide-react";
import type { Bootstrap, Opportunity } from "../shared/types";
import { applicationProgressFor } from "../shared/application-board";
import { recommendationForJob } from "../shared/job-recommendations";
import { jobEngagement } from "../shared/job-engagement";
import {
  localDateKey,
  nextRecommendedJobs,
  postingRecency,
  recentMilestones,
  selectedApplications,
  similarJobKey,
  todayActions,
  type TodayAction,
} from "../shared/today";
import { ApplicationPreparation } from "./ApplicationPreparation";
import { safeUrl, write } from "./api";
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
    <span
      className={`today-follow-up${action.overdue ? " overdue" : action.due ? " due" : ""}`}
    >
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
    5,
    now,
  );
  const metrics = recentMilestones(data.opportunities, now);
  const today = localDateKey(now);
  const hasActivity = Object.values(metrics).some((value) => value > 0);
  const addToApplications = (opportunity: Opportunity) =>
    void perform(
      () =>
        write(
          `/opportunities/${opportunity.id}`,
          { application: applicationProgressFor(opportunity, "saved") },
          "PATCH",
        ),
      "Job added to To apply.",
    );

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
          <p>Move your conversations and applications forward.</p>
        </div>
        <a href="#jobs" className="button">
          Browse jobs <ArrowRight size={15} aria-hidden="true" />
        </a>
      </header>

      <section
        className="today-outcomes"
        aria-labelledby="today-outcomes-title"
      >
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
        <p className="today-outcomes-note">
          {hasActivity
            ? "Recorded milestones, including closed and archived opportunities. Replies include application responses and startup conversations."
            : "No milestones recorded this week. After applying or hearing back, update the opportunity to keep your progress here."}
        </p>
      </section>

      <section
        className="today-section today-priority"
        aria-labelledby="today-priority-title"
      >
        <div className="today-section-heading">
          <div>
            <h2 id="today-priority-title">
              Keep things moving <span>{actions.length}</span>
            </h2>
            <p>
              Conversations first, followed by due follow-ups and introductions.
            </p>
          </div>
          <div className="today-board-links">
            <a href="#applications">Applications</a>
            <a href="#outreach">Startup outreach</a>
          </div>
        </div>
        {actions.length ? (
          <ul className="today-action-list">
            {actions.slice(0, 6).map((action) => (
              <li key={action.opportunity.id} className="today-action">
                <span
                  className={`today-action-kind${action.conversation ? " conversation" : ""}`}
                >
                  {action.label}
                </span>
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
                <button
                  type="button"
                  className="today-open-action"
                  onClick={() => onOpenOpportunity(action.opportunity)}
                  aria-label={`Open next action for ${action.opportunity.company}`}
                >
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="today-clear">
            <Check size={18} aria-hidden="true" />
            <div>
              <strong>No follow-ups due.</strong>
              <p>
                Choose an application below, or add a next action and follow-up
                date to an opportunity you’re pursuing.
              </p>
            </div>
          </div>
        )}
        {actions.length > 6 && (
          <p className="today-list-note">
            Showing 6 of {actions.length} next actions. Open the boards to see
            the rest.
          </p>
        )}
      </section>

      <section
        className="today-section"
        aria-labelledby="today-applications-title"
      >
        <div className="today-section-heading">
          <div>
            <h2 id="today-applications-title">
              Finish an application <span>{selected.length}</span>
            </h2>
            <p>The jobs you have chosen to pursue.</p>
          </div>
          <a href="#applications" className="text-link">
            All applications <ArrowRight size={14} aria-hidden="true" />
          </a>
        </div>
        {selected.length ? (
          <ul className="today-application-list">
            {selected.slice(0, 5).map((opportunity) => (
              <li key={opportunity.id}>
                <div>
                  <button
                    type="button"
                    className="today-opportunity-title"
                    onClick={() => onOpenOpportunity(opportunity)}
                  >
                    {opportunity.company}
                    <span>{opportunity.title}</span>
                  </button>
                  {opportunity.application?.nextAction && (
                    <p className="today-selected-next">
                      {opportunity.application.nextAction}
                    </p>
                  )}
                </div>
                <ApplicationPreparation
                  opportunity={opportunity}
                  drafts={data.drafts}
                  runs={data.runs}
                  busy={busy}
                  perform={perform}
                  onReviewFit={() => onOpenOpportunity(opportunity)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="today-empty">
            No applications waiting. Review a recommended job below and add it
            to Applications when you want to pursue it.
          </p>
        )}
        {selected.length > 5 && (
          <p className="today-list-note">
            Showing 5 of {selected.length} selected jobs.
          </p>
        )}
      </section>

      <section
        className="today-section"
        aria-labelledby="today-recommendations-title"
      >
        <div className="today-section-heading">
          <div>
            <h2 id="today-recommendations-title">Next opportunities</h2>
            <p>
              Recent postings first; older and undated matches remain available.
            </p>
          </div>
          <a href="#jobs" className="text-link">
            All recommended <ArrowRight size={14} aria-hidden="true" />
          </a>
        </div>
        {recommended.length ? (
          <ul className="today-recommended-list">
            {recommended.map((opportunity) => {
              const fit = recommendationForJob(opportunity, data.preferences);
              const engagement = jobEngagement(opportunity);
              const recency = postingRecency(opportunity, now);
              const sourceUrl = safeUrl(opportunity.sourceAttributionUrl ?? "");
              const similar = data.opportunities.filter(
                (op) =>
                  op.kind === "job" &&
                  op.stage !== "archived" &&
                  similarJobKey(op) === similarJobKey(opportunity),
              ).length;
              return (
                <li key={opportunity.id}>
                  <div className="today-recommendation-content">
                    <button
                      type="button"
                      className="today-opportunity-title"
                      onClick={() => onOpenOpportunity(opportunity)}
                    >
                      {opportunity.company}
                      <span>{opportunity.title}</span>
                    </button>
                    <span
                      className={`today-posting-date${recency.band === "unknown" ? " unconfirmed" : ""}`}
                    >
                      {recency.label}
                    </span>
                    {(engagement.kind !== "unknown" ||
                      engagement.hoursLabel) && (
                      <span className="today-engagement">
                        {[
                          engagement.kind !== "unknown"
                            ? engagement.label
                            : null,
                          engagement.hoursLabel,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                    {similar > 1 && (
                      <span className="today-similar">
                        {similar} similar listings · showing one
                      </span>
                    )}
                    <p>{fit.reason}</p>
                    {fit.question && (
                      <p className="today-review-question">{fit.question}</p>
                    )}
                    {sourceUrl && (
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="today-source-link"
                      >
                        {opportunity.source === "himalayas"
                          ? "View on Himalayas"
                          : "View source listing"}{" "}
                        ↗
                      </a>
                    )}
                  </div>
                  <button
                    type="button"
                    className="button today-add"
                    disabled={busy}
                    onClick={() => addToApplications(opportunity)}
                    aria-label={`Add ${opportunity.title} at ${opportunity.company} to applications`}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Add to applications
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="today-empty">
            <p>
              No new recommended jobs right now. Search for fresh opportunities
              or review your saved jobs and preferences.
            </p>
            <a href="#jobs" className="text-link">
              Open job opportunities <ArrowRight size={14} aria-hidden="true" />
            </a>
          </div>
        )}
      </section>
    </div>
  );
}
