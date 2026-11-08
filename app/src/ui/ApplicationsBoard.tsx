import { useEffect, useRef, useState } from "react";
import { CalendarClock, GripVertical, Search } from "lucide-react";
import type { Draft, Opportunity, Run } from "../shared/types";
import {
  applicationColumn,
  applicationColumns,
  applicationProgressFor,
  applicationStatusLabels,
  type ApplicationColumnId,
  type ApplicationStatus,
} from "../shared/application-board";
import { followUpDue } from "../shared/discovery";
import { requiredQualificationFit } from "../shared/job-recommendations";
import { formatOpportunitySalary } from "../shared/salary";
import { write } from "./api";
import { ApplicationPreparation } from "./ApplicationPreparation";
import "./ApplicationsBoard.css";

const dragType = "application/x-roleloop-opportunity";
const emptyColumns: Record<ApplicationColumnId, string> = {
  to_apply: "Jobs you choose to pursue",
  applied: "No applications yet",
  interview: "No interviews yet",
  offer: "No offers yet",
  closed: "Rejected or withdrawn",
};

export function ApplicationsBoard({
  opportunities,
  drafts = [],
  runs = [],
  busy,
  perform,
  onSelect,
}: {
  opportunities: Opportunity[];
  drafts?: Draft[];
  runs?: Run[];
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
  onSelect: (opportunity: Opportunity) => void;
}) {
  const [query, setQuery] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<ApplicationColumnId | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const closeChoice = useRef<HTMLButtonElement>(null);
  const today = new Date().toLocaleDateString("en-CA");
  const tracked = opportunities.filter((op) => applicationColumn(op) !== null);
  const visible = tracked.filter(
    (op) =>
      (!dueOnly || followUpDue(op, today)) &&
      `${op.company} ${op.title} ${op.location} ${op.application?.nextAction ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const closingOpportunity = tracked.find((op) => op.id === closing);
  const dueCount = tracked.filter((op) => followUpDue(op, today)).length;
  useEffect(() => {
    if (closing) closeChoice.current?.focus();
  }, [closing]);
  useEffect(() => {
    if (dueCount === 0) setDueOnly(false);
    if (tracked.length === 0) setQuery("");
  }, [dueCount, tracked.length]);

  const move = async (op: Opportunity, status: ApplicationStatus) => {
    if (busy || op.application?.status === status) return;
    const saved = await perform(
      () =>
        write(
          `/opportunities/${op.id}`,
          {
            application: applicationProgressFor(op, status),
          },
          "PATCH",
        ),
      `Moved to ${applicationStatusLabels[status]}.`,
    );
    if (saved) setClosing(null);
  };
  const drop = (id: string, column: ApplicationColumnId) => {
    setDragging(null);
    setOver(null);
    const op = tracked.find((item) => item.id === id);
    if (!op || busy || applicationColumn(op) === column) return;
    if (column === "closed") setClosing(id);
    else void move(op, column === "to_apply" ? "saved" : column);
  };

  return (
    <section className="applications-board" aria-label="Applications board">
      {tracked.length > 0 && (
        <div className="application-board-toolbar">
          <div className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="Search applications"
              placeholder="Search company or role…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {dueCount > 0 && (
            <button
              type="button"
              className={`application-due-filter ${dueOnly ? "active" : ""}`}
              aria-pressed={dueOnly}
              onClick={() => setDueOnly(!dueOnly)}
            >
              <CalendarClock size={15} aria-hidden="true" />
              Follow-ups due <span>{dueCount}</span>
            </button>
          )}
          <span className="application-board-count" role="status">
            {query || dueOnly
              ? `${visible.length} of ${tracked.length}`
              : tracked.length}{" "}
            {tracked.length === 1 ? "job" : "jobs"}
          </span>
        </div>
      )}
      {tracked.length === 0 ? (
        <div className="application-board-empty">
          <div>
            <h2>Choose the jobs you want to pursue.</h2>
            <p>Add a job from Job opportunities to start in To apply.</p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="application-board-empty">
          <p>No applications match these filters.</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setQuery("");
              setDueOnly(false);
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}
      <div
        className="application-board-scroll"
        tabIndex={0}
        aria-label="Hiring stages; scroll horizontally to see all columns"
      >
        <div className="application-board-columns">
          {applicationColumns.map((column) => {
            const cards = visible.filter(
              (op) => applicationColumn(op) === column.id,
            );
            return (
              <section
                key={column.id}
                className={`application-column application-column-${column.id}${over === column.id ? " drag-over" : ""}`}
                aria-labelledby={`application-column-${column.id}`}
                onDragOver={(event) => {
                  if (busy || !event.dataTransfer.types.includes(dragType))
                    return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOver(column.id);
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    setOver(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  drop(event.dataTransfer.getData(dragType), column.id);
                }}
              >
                <header className="application-column-heading">
                  <h2 id={`application-column-${column.id}`}>{column.label}</h2>
                  <span
                    aria-label={`${cards.length} ${cards.length === 1 ? "job" : "jobs"}`}
                  >
                    {cards.length}
                  </span>
                </header>
                {column.id === "closed" && closingOpportunity && (
                  <div
                    className="application-close-choice"
                    role="group"
                    aria-label="Choose application outcome"
                  >
                    <strong>How did it end?</strong>
                    <p>
                      {closingOpportunity.company} · {closingOpportunity.title}
                    </p>
                    <div>
                      <button
                        ref={closeChoice}
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void move(closingOpportunity, "rejected")
                        }
                      >
                        Rejected
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void move(closingOpportunity, "withdrawn")
                        }
                      >
                        Withdrawn
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setClosing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <div className="application-column-cards">
                  {cards.map((op) => {
                    const progress = op.application!;
                    const due = followUpDue(op, today);
                    const fit = requiredQualificationFit(op);
                    return (
                      <article
                        key={op.id}
                        aria-label={`${op.company} · ${op.title}`}
                        className={`application-card${dragging === op.id ? " dragging" : ""}`}
                      >
                        <div className="application-card-company">
                          <span>{op.company}</span>
                          <span
                            className="application-drag-handle"
                            draggable={!busy}
                            title="Drag to another column"
                            aria-hidden="true"
                            onDragStart={(event) => {
                              event.dataTransfer.setData(dragType, op.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDragging(op.id);
                            }}
                            onDragEnd={() => {
                              setDragging(null);
                              setOver(null);
                            }}
                          >
                            <GripVertical size={16} />
                          </span>
                        </div>
                        <button
                          type="button"
                          className="application-card-title"
                          onClick={() => onSelect(op)}
                        >
                          {op.title}
                        </button>
                        <dl className="application-card-metrics">
                          <div className="application-card-salary">
                            <dt>
                              Salary
                              {op.salaryCurrency &&
                                !/^unknown$/i.test(op.salaryCurrency) && (
                                  <span>{op.salaryCurrency}</span>
                                )}
                            </dt>
                            <dd>{formatOpportunitySalary(op)}</dd>
                          </div>
                          <div className="application-card-fit">
                            <dt>Required match</dt>
                            <dd
                              className={
                                fit.score === null
                                  ? "application-card-fit-pending"
                                  : ""
                              }
                            >
                              {fit.score === null
                                ? fit.fitLabel
                                : `${Math.round(fit.score)}%`}
                            </dd>
                            {fit.score !== null && (
                              <dd className="application-card-fit-meter">
                                <meter
                                  min={0}
                                  max={100}
                                  value={fit.score}
                                  aria-label="Required qualification match"
                                >
                                  {Math.round(fit.score)}%
                                </meter>
                              </dd>
                            )}
                          </div>
                        </dl>
                        {column.id === "closed" && (
                          <span
                            className={`application-outcome application-outcome-${progress.status}`}
                          >
                            {applicationStatusLabels[progress.status]}
                          </span>
                        )}
                        {progress.nextAction && (
                          <p className="application-next-action">
                            {progress.nextAction}
                          </p>
                        )}
                        {progress.followUpOn &&
                          !["offer", "rejected", "withdrawn"].includes(
                            progress.status,
                          ) && (
                            <span
                              className={`application-follow-up${due ? " due" : ""}`}
                            >
                              <CalendarClock size={12} aria-hidden="true" />
                              {due ? "Due " : "Follow up "}
                              {new Date(
                                `${progress.followUpOn}T12:00:00`,
                              ).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          )}
                        <ApplicationPreparation
                          opportunity={op}
                          drafts={drafts}
                          runs={runs}
                          busy={busy}
                          perform={perform}
                          onReviewFit={() => onSelect(op)}
                        />
                      </article>
                    );
                  })}
                  {cards.length === 0 && (
                    <p className="application-column-empty">
                      {emptyColumns[column.id]}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {tracked.length > 0 && (
        <p className="application-board-help">
          Prepare documents in To apply. Move to Applied after submitting. Open
          a job to change its status or add follow-up notes.
        </p>
      )}
    </section>
  );
}
