import { useEffect, useState } from "react";
import {
  ArrowRight,
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  History,
  Info,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { Bootstrap } from "../shared/types";
import { applicationCounts } from "../shared/discovery";
import {
  buildActivityItems,
  type ActivityItem,
  type ActivityStatus,
} from "./activity-model";
import "./activity.css";

const filters = [
  ["all", "All activity"],
  ["issues", "Issues"],
  ["searches", "Searches"],
  ["drafts", "Drafts"],
  ["workspace", "Workspace"],
] as const;
type Filter = (typeof filters)[number][0];
const statusLabels: Record<ActivityStatus, string> = {
  queued: "Waiting",
  running: "In progress",
  success: "Completed",
  partial: "Partial results",
  warning: "Notice",
  error: "Failed",
  info: "Update",
};
const categoryLabels = {
  search: "Search",
  evaluation: "Evaluation",
  research: "Research",
  draft: "Draft",
  resume: "Resume",
  preferences: "Preferences",
  application: "Application",
  workspace: "Workspace",
};
const isIssue = (item: ActivityItem) =>
  ["error", "warning", "partial"].includes(item.status);
const isActive = (item: ActivityItem) =>
  item.status === "running" || item.status === "queued";

function matchesFilter(item: ActivityItem, filter: Filter): boolean {
  return (
    filter === "all" ||
    (filter === "issues" && isIssue(item)) ||
    (filter === "searches" &&
      ["search", "evaluation", "research"].includes(item.category)) ||
    (filter === "drafts" && item.category === "draft") ||
    (filter === "workspace" &&
      ["resume", "preferences", "application", "workspace"].includes(
        item.category,
      ))
  );
}

function matchesQuery(item: ActivityItem, query: string): boolean {
  return [
    item.title,
    item.description,
    item.nextStep,
    categoryLabels[item.category],
    statusLabels[item.status],
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
}

export function activityMatches(
  item: ActivityItem,
  filter: Filter,
  query: string,
): boolean {
  return (
    (matchesFilter(item, filter) && matchesQuery(item, query)) ||
    !!item.events?.some((event) => activityMatches(event, filter, query))
  );
}

function readFilters(): { filter: Filter; query: string } {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.hash.split("?")[1],
  );
  const filter = params.get("filter");
  return {
    filter: filters.some(([id]) => id === filter) ? (filter as Filter) : "all",
    query: params.get("q") || "",
  };
}

function validDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function dayLabel(value: string) {
  const parsed = validDate(value);
  if (!parsed) return "Date unavailable";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (parsed.toDateString() === today.toDateString()) return "Today";
  if (parsed.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function ActivityTime({
  value,
  started = false,
}: {
  value: string;
  started?: boolean;
}) {
  const parsed = validDate(value);
  return parsed ? (
    <time dateTime={value} title={parsed.toLocaleString()}>
      {started ? "Started " : ""}
      {new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(parsed)}
    </time>
  ) : null;
}

function StateIcon({ item }: { item: ActivityItem }) {
  const Icon =
    item.status === "running"
      ? LoaderCircle
      : item.status === "queued"
        ? Clock3
        : isIssue(item)
          ? AlertTriangle
          : item.status === "success"
            ? Check
            : item.category === "draft"
              ? FileText
              : item.category === "preferences"
                ? SlidersHorizontal
                : Info;
  return (
    <Icon
      size={17}
      aria-hidden="true"
      className={item.status === "running" ? "spin" : undefined}
    />
  );
}

function ActivityLink({ item }: { item: ActivityItem }) {
  if (!item.action) return null;
  const { page, opportunityId, label } = item.action;
  const href = `#${page}${opportunityId ? `?opportunity=${encodeURIComponent(opportunityId)}` : ""}`;
  return (
    <a className="activity-action" href={href}>
      {label}
      <ArrowRight size={14} aria-hidden="true" />
    </a>
  );
}

function TechnicalDetails({ item }: { item: ActivityItem }) {
  if (!item.technicalDetails) return null;
  return (
    <details className="activity-technical">
      <summary>Technical details</summary>
      <p>Diagnostic information for troubleshooting.</p>
      <pre>{item.technicalDetails}</pre>
    </details>
  );
}

function ActivityEntry({
  item,
  nested = false,
  expandChildren = false,
}: {
  item: ActivityItem;
  nested?: boolean;
  expandChildren?: boolean;
}) {
  const summary = item.summary;
  const events = item.events || [];
  return (
    <article
      className={`activity-entry activity-${item.status}${nested ? " activity-entry-nested" : ""}`}
    >
      <span className="activity-marker">
        <StateIcon item={item} />
      </span>
      <div className="activity-entry-content">
        <div className="activity-entry-meta">
          <span>{categoryLabels[item.category]}</span>
          <span className={`activity-status activity-status-${item.status}`}>
            {statusLabels[item.status]}
          </span>
          <ActivityTime value={item.createdAt} started={!!item.run} />
        </div>
        {nested ? <h4>{item.title}</h4> : <h3>{item.title}</h3>}
        <p className="activity-description">{item.description}</p>
        {summary && (
          <dl className="activity-results" aria-label="Search results">
            <div>
              <dt>new opportunities</dt>
              <dd>{summary.newOpportunities.toLocaleString()}</dd>
            </div>
            <div>
              <dt>already saved</dt>
              <dd>{summary.existingOpportunities.toLocaleString()}</dd>
            </div>
            <div>
              <dt>drafts prepared</dt>
              <dd>{summary.draftsCreated.toLocaleString()}</dd>
            </div>
          </dl>
        )}
        {item.nextStep && (
          <p className="activity-next-step">
            <strong>Next step</strong> {item.nextStep}
          </p>
        )}
        {isActive(item) && (
          <div className="activity-progress">
            <progress
              aria-label={`${item.title} progress`}
              max={100}
              value={item.progress || 0}
            />
            <span>{item.progress || 0}%</span>
          </div>
        )}
        <div className="activity-entry-actions">
          <ActivityLink item={item} />
          {summary && summary.draftsCreated > 0 && (
            <a className="activity-action" href="#drafts">
              Review drafts
              <ArrowRight size={14} aria-hidden="true" />
            </a>
          )}
        </div>
        {!nested && (events.length > 0 || summary) && (
          <details
            className="activity-run-details"
            open={expandChildren || undefined}
          >
            <summary>
              <ChevronDown size={14} aria-hidden="true" />{" "}
              {item.category === "search" ? "Search details" : "Task details"}
              {events.length ? ` · ${events.length} updates` : ""}
            </summary>
            {item.updatedAt && !isActive(item) && validDate(item.updatedAt) && (
              <p className="activity-detail-note">
                {item.status === "error" ? "Stopped" : "Finished"}{" "}
                {new Date(item.updatedAt).toLocaleString()}.
              </p>
            )}
            {summary && (
              <p className="activity-run-summary">
                {summary.evaluated.toLocaleString()} evaluated ·{" "}
                {summary.sourcesChecked.toLocaleString()} sources checked ·{" "}
                {summary.sourcesFailed.toLocaleString()} sources failed ·{" "}
                {summary.companiesConnected.toLocaleString()} companies
                connected
                {summary.draftFailures > 0
                  ? ` · ${summary.draftFailures.toLocaleString()} drafts could not be prepared`
                  : ""}
                .
              </p>
            )}
            {events.map((event) => (
              <ActivityEntry key={event.id} item={event} nested />
            ))}
            {events.length > 0 && (
              <p className="activity-detail-note">
                Updates available in recent history.
              </p>
            )}
          </details>
        )}
        <TechnicalDetails item={item} />
      </div>
    </article>
  );
}

function SourceResults({ data }: { data: Bootstrap }) {
  const groups = new Map<string, Bootstrap["opportunities"]>();
  for (const job of data.opportunities) {
    if (job.kind !== "job") continue;
    const key = job.sourceId || job.source;
    const group = groups.get(key);
    if (group) group.push(job);
    else groups.set(key, [job]);
  }
  if (!groups.size) return null;
  return (
    <details className="activity-source-results">
      <summary>
        <ChevronDown size={14} aria-hidden="true" /> Results by source
      </summary>
      <div
        className="activity-source-table"
        role="region"
        aria-label="Saved jobs and hiring outcomes by source"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Saved</th>
              <th scope="col">Applied</th>
              <th scope="col">Interviews</th>
              <th scope="col">Offers</th>
            </tr>
          </thead>
          <tbody>
            {[...groups].map(([id, jobs]) => {
              const counts = applicationCounts(jobs);
              return (
                <tr key={id}>
                  <th scope="row">
                    {data.sources.find((source) => source.id === id)?.label ??
                      jobs[0].source}
                  </th>
                  <td>{jobs.length}</td>
                  <td>{counts.applied}</td>
                  <td>{counts.interview}</td>
                  <td>{counts.offer}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        Counts cover all jobs currently saved in your workspace. Interview and
        offer milestones remain counted after a rejection.
      </p>
    </details>
  );
}

export function ActivityPage({ data }: { data: Bootstrap }) {
  const [{ filter, query }, setFilters] = useState(readFilters);
  const [visible, setVisible] = useState(20);
  useEffect(() => {
    const sync = () => {
      setFilters(readFilters());
      setVisible(20);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const updateFilters = (next: { filter: Filter; query: string }) => {
    setFilters(next);
    setVisible(20);
    const params = new URLSearchParams();
    if (next.filter !== "all") params.set("filter", next.filter);
    if (next.query) params.set("q", next.query);
    window.history.replaceState(
      null,
      "",
      `#activity${params.size ? `?${params}` : ""}`,
    );
  };
  const items = buildActivityItems(data);
  const active = items.filter(isActive);
  const history = items.filter((item) => !isActive(item));
  const filtered = history.filter((item) =>
    activityMatches(item, filter, query.trim()),
  );
  const shown = filtered.slice(0, visible);
  const groups = new Map<string, ActivityItem[]>();
  for (const item of shown) {
    const day = dayLabel(item.createdAt);
    groups.set(day, [...(groups.get(day) || []), item]);
  }
  return (
    <section className="page activity-page" aria-labelledby="activity-title">
      <header className="page-heading">
        <div>
          <h1 id="activity-title">Activity</h1>
          <p>Search outcomes, prepared drafts and workspace changes.</p>
        </div>
        <a href="#jobs" className="button">
          <Search size={15} aria-hidden="true" />
          Open opportunities
        </a>
      </header>
      {active.length > 0 && (
        <section
          className="activity-active"
          aria-labelledby="active-tasks-title"
        >
          <div className="activity-section-heading">
            <h2 id="active-tasks-title">Happening now</h2>
            <span role="status">
              {active.length} {active.length === 1 ? "task" : "tasks"} · updates
              automatically
            </span>
          </div>
          {!data.status.worker && (
            <p className="activity-worker-notice" role="status">
              <AlertTriangle size={16} aria-hidden="true" /> Background
              processing is offline. Queued tasks will wait. After restarting
              RoleLoop, review any interrupted tasks and retry them if needed.
            </p>
          )}
          {active.map((item) => (
            <ActivityEntry key={item.id} item={item} />
          ))}
        </section>
      )}
      <div className="activity-toolbar">
        <div
          className="activity-filters"
          role="group"
          aria-label="Filter activity"
        >
          {filters.map(([id, label]) => {
            const count = history.filter((item) =>
              activityMatches(item, id, ""),
            ).length;
            return (
              <button
                type="button"
                key={id}
                aria-pressed={filter === id}
                onClick={() => updateFilters({ filter: id, query })}
              >
                {label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
        <label className="activity-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search activity</span>
          <input
            type="search"
            name="activity-search"
            aria-label="Search activity"
            placeholder="Search activity…"
            value={query}
            onChange={(e) => updateFilters({ filter, query: e.target.value })}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear activity search"
              onClick={() => updateFilters({ filter, query: "" })}
            >
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </label>
      </div>
      <div className="activity-history-heading">
        <h2>History</h2>
        <p role="status">
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
          {query ? " found" : ""}
        </p>
      </div>
      {filter === "issues" && (
        <p className="activity-history-hint">
          Past warnings and failures. An old issue does not mean it is still
          happening.
        </p>
      )}
      {shown.length ? (
        <div className="activity-timeline">
          {[...groups].map(([day, entries]) => (
            <section className="activity-day" key={day} aria-label={day}>
              <h2 className="activity-date-label">{day}</h2>
              <div>
                {entries.map((item) => (
                  <ActivityEntry
                    key={item.id}
                    item={item}
                    expandChildren={
                      (filter !== "all" || !!query.trim()) &&
                      !!item.events?.some((event) =>
                        activityMatches(event, filter, query.trim()),
                      )
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="activity-empty">
          {history.length || query || filter !== "all" ? (
            <Search size={27} aria-hidden="true" />
          ) : (
            <History size={27} aria-hidden="true" />
          )}
          <h3>
            {history.length || query || filter !== "all"
              ? "No activity matches this view"
              : "Your activity will appear here"}
          </h3>
          <p>
            {history.length || query || filter !== "all"
              ? "Try another filter or a different search."
              : "Search for opportunities or prepare a draft to see the outcome here."}
          </p>
          {history.length || query || filter !== "all" ? (
            <button
              type="button"
              className="button"
              onClick={() => updateFilters({ filter: "all", query: "" })}
            >
              Clear filters
            </button>
          ) : (
            <a className="button" href="#jobs">
              Open opportunities
              <ArrowRight size={14} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      {filtered.length > shown.length && (
        <button
          type="button"
          className="button activity-load-more"
          onClick={() => setVisible((value) => value + 20)}
        >
          Show more activity{" "}
          <span>({filtered.length - shown.length} more)</span>
        </button>
      )}
      <SourceResults data={data} />
      <footer className="activity-footer">
        <p>Recent history · up to 100 tasks and 60 workspace events.</p>
        <details>
          <summary>What appears here?</summary>
          <p>
            Searches, evaluations, drafts, resume processing, preference saves
            and application status changes. Updates from the same task are
            grouped together. Browsing, downloads and individual text edits are
            not recorded. Older entries may have fewer details.
          </p>
        </details>
      </footer>
    </section>
  );
}
