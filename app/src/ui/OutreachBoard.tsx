import { useEffect, useRef, useState } from "react";
import { CalendarClock, GripVertical, Search } from "lucide-react";
import type { Draft, Opportunity, Run } from "../shared/types";
import {
  outreachColumn,
  outreachColumns,
  outreachProgressFor,
  outreachStatusLabels,
  type OutreachColumnId,
  type OutreachStatus,
  outreachOutcomeLabels,
  outreachFollowUpDue,
  type OutreachProgress as Progress,
} from "../shared/outreach-board";

import { write } from "./api";
import { OutreachPreparation } from "./OutreachPreparation";
import "./ApplicationsBoard.css";
import "./OutreachBoard.css";

const dragType = "application/x-roleloop-startup";
const emptyColumns: Record<OutreachColumnId, string> = {
  to_contact: "Startups you want to contact",
  contacted: "Waiting for a reply",
  conversation: "Replies and ongoing conversations",
  closed: "Outcomes and completed conversations",
};

export function OutreachBoard({
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
  const [over, setOver] = useState<OutreachColumnId | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const closeChoice = useRef<HTMLButtonElement>(null);
  const today = new Date().toLocaleDateString("en-CA");
  const tracked = opportunities.filter((op) => outreachColumn(op) !== null);
  const visible = tracked.filter(
    (op) =>
      (!dueOnly || outreachFollowUpDue(op, today)) &&
      `${op.company} ${op.title} ${op.contactName} ${op.outreach?.nextAction ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const closingOpportunity = tracked.find((op) => op.id === closing);
  const dueCount = tracked.filter((op) =>
    outreachFollowUpDue(op, today),
  ).length;
  useEffect(() => {
    if (closing) closeChoice.current?.focus();
  }, [closing]);
  useEffect(() => {
    if (dueCount === 0) setDueOnly(false);
    if (tracked.length === 0) setQuery("");
  }, [dueCount, tracked.length]);

  const move = async (
    op: Opportunity,
    status: OutreachStatus,
    outcome: Progress["outcome"] = null,
  ) => {
    if (busy || op.outreach?.status === status) return;
    const saved = await perform(
      () =>
        write(
          `/opportunities/${op.id}`,
          {
            outreach: outreachProgressFor(op, status, outcome),
          },
          "PATCH",
        ),
      `Moved to ${outreachStatusLabels[status]}.`,
    );
    if (saved) setClosing(null);
  };
  const drop = (id: string, column: OutreachColumnId) => {
    setDragging(null);
    setOver(null);
    const op = tracked.find((item) => item.id === id);
    if (!op || busy || outreachColumn(op) === column) return;
    if (column === "closed") setClosing(id);
    else void move(op, column === "to_contact" ? "saved" : column);
  };

  return (
    <section
      className="applications-board outreach-board"
      aria-label="Startup outreach board"
    >
      {tracked.length > 0 && (
        <div className="application-board-toolbar">
          <div className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="Search outreach"
              placeholder="Search company, contact or next action…"
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
            {tracked.length === 1 ? "startup" : "startups"}
          </span>
        </div>
      )}
      {tracked.length === 0 ? (
        <div className="application-board-empty">
          <div>
            <h2>Choose the startups you want to contact.</h2>
            <p>Add a company from Startup prospects to start in To contact.</p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="application-board-empty">
          <p>No startups match these filters.</p>
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
        aria-label="Outreach stages; scroll horizontally to see all columns"
      >
        <div className="application-board-columns outreach-board-columns">
          {outreachColumns.map((column) => {
            const cards = visible.filter(
              (op) => outreachColumn(op) === column.id,
            );
            return (
              <section
                key={column.id}
                className={`application-column outreach-column-${column.id}${over === column.id ? " drag-over" : ""}`}
                aria-labelledby={`outreach-column-${column.id}`}
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
                  <h2 id={`outreach-column-${column.id}`}>{column.label}</h2>
                  <span
                    aria-label={`${cards.length} ${cards.length === 1 ? "startup" : "startups"}`}
                  >
                    {cards.length}
                  </span>
                </header>
                {column.id === "closed" && closingOpportunity && (
                  <div
                    className="application-close-choice"
                    role="group"
                    aria-label="Choose outreach outcome"
                  >
                    <strong>How did it end?</strong>
                    <p>
                      {closingOpportunity.company} · {closingOpportunity.title}
                    </p>
                    <div>
                      {(
                        Object.entries(outreachOutcomeLabels) as Array<
                          [NonNullable<Progress["outcome"]>, string]
                        >
                      ).map(([outcome, label], index) => (
                        <button
                          key={outcome}
                          ref={index === 0 ? closeChoice : undefined}
                          type="button"
                          className="button"
                          disabled={busy}
                          onClick={() =>
                            void move(closingOpportunity, "closed", outcome)
                          }
                        >
                          {label}
                        </button>
                      ))}
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
                    const progress = op.outreach!;
                    const due = outreachFollowUpDue(op, today);
                    return (
                      <article
                        key={op.id}
                        aria-label={`${op.company} · ${op.title}`}
                        className={`application-card${dragging === op.id ? " dragging" : ""}`}
                      >
                        <div className="application-card-company">
                          <span>{op.contactName || "Contact to confirm"}</span>
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
                          {op.company}
                        </button>
                        {op.title && op.title !== op.company && (
                          <p className="outreach-card-description">
                            {op.title}
                          </p>
                        )}
                        {column.id === "closed" && (
                          <span
                            className={`application-outcome outreach-outcome-${progress.outcome ?? "closed"}`}
                          >
                            {progress.outcome
                              ? outreachOutcomeLabels[progress.outcome]
                              : "Closed"}
                          </span>
                        )}
                        {progress.nextAction && (
                          <p className="application-next-action">
                            {progress.nextAction}
                          </p>
                        )}
                        {progress.followUpOn &&
                          progress.status !== "closed" && (
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
                        <OutreachPreparation
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
          Prepare outreach in To contact. Move to Contacted after sending your
          message. Open a startup to change its status or add follow-up notes.
        </p>
      )}
    </section>
  );
}
