import { useState } from "react";
import type { Opportunity } from "../shared/types";
import { safeUrl, write } from "./api";

type Progress = NonNullable<Opportunity["application"]>;
export function ApplicationProgress({
  opportunity,
  busy,
  perform,
}: {
  opportunity: Opportunity;
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const [progress, setProgress] = useState<Progress>(
    opportunity.application ?? {
      status: "saved",
      appliedAt: null,
      nextAction: "",
      followUpOn: null,
      notes: "",
    },
  );
  const set = (patch: Partial<Progress>) =>
    setProgress((p) => ({ ...p, ...patch }));
  return (
    <section className="form-section application-progress">
      <h3>Application progress</h3>
      <p>
        <a
          className="text-button"
          href={safeUrl(opportunity.url)}
          target="_blank"
          rel="noreferrer"
        >
          Open listing / apply ↗
        </a>
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(
            () =>
              write(
                `/opportunities/${opportunity.id}`,
                { application: progress },
                "PATCH",
              ),
            "Application progress saved.",
          );
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>Status</span>
            <select
              value={progress.status}
              disabled={busy}
              onChange={(e) =>
                set({ status: e.target.value as Progress["status"] })
              }
            >
              <option value="saved">To apply</option>
              <option value="applied">Applied</option>
              <option value="interview">Interview</option>
              <option value="offer">Offer</option>
              <option value="rejected">Rejected</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </label>
          <label className="field">
            <span>Follow-up date</span>
            <input
              type="date"
              value={progress.followUpOn ?? ""}
              onChange={(e) => set({ followUpOn: e.target.value || null })}
            />
          </label>
          <label className="field wide">
            <span>Next action</span>
            <input
              maxLength={1000}
              placeholder="Confirm hiring country, contact recruiter, prepare interview…"
              value={progress.nextAction}
              onChange={(e) => set({ nextAction: e.target.value })}
            />
          </label>
          <label className="field wide">
            <span>Contact and outcome notes</span>
            <textarea
              rows={3}
              maxLength={10000}
              value={progress.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </label>
        </div>
        {opportunity.application?.appliedAt && (
          <p className="muted">
            Applied{" "}
            {new Date(opportunity.application.appliedAt).toLocaleDateString()}
          </p>
        )}
        <button className="button" disabled={busy}>
          Save progress
        </button>
      </form>
    </section>
  );
}
