import { useState } from "react";
import type { Opportunity } from "../shared/types";
import {
  outreachProgressFor,
  outreachStatusLabels,
  outreachOutcomeLabels,
  type OutreachProgress as Progress,
} from "../shared/outreach-board";
import { write } from "./api";

export function OutreachProgress({
  opportunity,
  busy,
  perform,
}: {
  opportunity: Opportunity;
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const [progress, setProgress] = useState<Progress>(
    opportunity.outreach ?? outreachProgressFor(opportunity, "saved"),
  );
  const set = (patch: Partial<Progress>) =>
    setProgress((current) => ({ ...current, ...patch }));
  return (
    <section className="form-section outreach-progress">
      <h3>Outreach progress</h3>
      <p className="muted">
        Mark Contacted after sending your message. RoleLoop does not send it.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(
            () =>
              write(
                `/opportunities/${opportunity.id}`,
                { outreach: progress },
                "PATCH",
              ),
            "Outreach progress saved.",
          );
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>Status</span>
            <select
              value={progress.status}
              disabled={busy}
              onChange={(event) => {
                const status = event.target.value as Progress["status"];
                set({
                  status,
                  outcome: status === "closed" ? progress.outcome : null,
                });
              }}
            >
              {Object.entries(outreachStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Follow-up date</span>
            <input
              type="date"
              disabled={busy || progress.status === "closed"}
              value={progress.followUpOn ?? ""}
              onChange={(event) =>
                set({ followUpOn: event.target.value || null })
              }
            />
          </label>
          {progress.status === "closed" && (
            <label className="field wide">
              <span>Outcome</span>
              <select
                required
                disabled={busy}
                value={progress.outcome ?? ""}
                onChange={(event) =>
                  set({
                    outcome: (event.target.value ||
                      null) as Progress["outcome"],
                  })
                }
              >
                <option value="" disabled>
                  Choose an outcome
                </option>
                {Object.entries(outreachOutcomeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field wide">
            <span>Next action</span>
            <input
              maxLength={1000}
              disabled={busy}
              placeholder="Find the right contact, follow up, arrange a call…"
              value={progress.nextAction}
              onChange={(event) => set({ nextAction: event.target.value })}
            />
          </label>
          <label className="field wide">
            <span>Contact and conversation notes</span>
            <textarea
              rows={3}
              maxLength={10000}
              disabled={busy}
              value={progress.notes}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </label>
        </div>
        {(opportunity.outreach?.contactedAt ||
          opportunity.outreach?.conversationAt ||
          opportunity.outreach?.closedAt) && (
          <p className="muted outreach-milestones">
            {(
              [
                ["First contacted", opportunity.outreach.contactedAt],
                ["Conversation started", opportunity.outreach.conversationAt],
                ["First closed", opportunity.outreach.closedAt],
              ] as const
            )
              .filter(([, date]) => date)
              .map(([label, date]) => (
                <span key={label}>
                  {label} {new Date(date!).toLocaleDateString()}
                </span>
              ))}
          </p>
        )}
        <button
          className="button"
          disabled={busy || (progress.status === "closed" && !progress.outcome)}
        >
          Save progress
        </button>
      </form>
    </section>
  );
}
