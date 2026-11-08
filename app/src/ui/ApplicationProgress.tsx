import { useState } from "react";
import type { Opportunity } from "../shared/types";
import { safeUrl, write } from "./api";
import { submittedApplicationProgress } from "../shared/application-board";

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
  const day = (value: string | null | undefined) => {
    if (!value) return "";
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const dateValue = (value: string) =>
    value ? new Date(`${value}T00:00:00`).toISOString() : null;
  const applicationUrl = safeUrl(opportunity.url);
  return (
    <section className="form-section application-progress">
      <h3>Application progress</h3>
      {applicationUrl && (
        <p>
          <a
            className="text-button"
            href={applicationUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open listing / apply ↗
          </a>
        </p>
      )}
      {(!opportunity.application ||
        opportunity.application.status === "saved") && (
        <div className="application-handoff">
          <p className="muted">
            After submitting on the employer’s website, record it here. A
            follow-up is suggested in seven days.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              void perform(
                () =>
                  write(
                    `/opportunities/${opportunity.id}`,
                    {
                      application: submittedApplicationProgress({
                        ...opportunity,
                        application: progress,
                      }),
                    },
                    "PATCH",
                  ),
                "Application marked as submitted.",
              )
            }
          >
            Mark as submitted
          </button>
        </div>
      )}
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
            <span>Application channel</span>
            <select
              disabled={busy}
              value={progress.channel || "direct"}
              onChange={(event) =>
                set({ channel: event.target.value as Progress["channel"] })
              }
            >
              <option value="direct">Direct application</option>
              <option value="referral">Employee referral</option>
              <option value="recruiter">Recruiter</option>
              <option value="community">Community connection</option>
            </select>
          </label>
          <label className="field">
            <span>First human reply</span>
            <input
              type="date"
              disabled={busy}
              max={day(new Date().toISOString())}
              value={day(progress.repliedAt)}
              onChange={(event) =>
                set({ repliedAt: dateValue(event.target.value) })
              }
            />
            <small>
              Record a personal response, rather than an automated receipt.
            </small>
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
        <details
          className="application-contacts"
          open={Boolean(
            progress.contactName ||
              (progress.referralStatus && progress.referralStatus !== "none"),
          )}
        >
          <summary>Contact & referral</summary>
          <div className="form-grid">
            <label className="field">
              <span>Contact name</span>
              <input
                disabled={busy}
                maxLength={200}
                value={progress.contactName || ""}
                onChange={(event) => set({ contactName: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Contact link</span>
              <input
                type="url"
                disabled={busy}
                maxLength={2000}
                placeholder="https://…"
                value={progress.contactUrl || ""}
                onChange={(event) => set({ contactUrl: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Referral progress</span>
              <select
                disabled={busy}
                value={progress.referralStatus || "none"}
                onChange={(event) =>
                  set({
                    referralStatus: event.target
                      .value as Progress["referralStatus"],
                  })
                }
              >
                <option value="none">No referral planned</option>
                <option value="to_ask">Ask for an introduction</option>
                <option value="requested">Introduction requested</option>
                <option value="received">Referral received</option>
              </select>
            </label>
            <label className="field">
              <span>Last contact</span>
              <input
                type="date"
                disabled={busy}
                max={day(new Date().toISOString())}
                value={day(progress.lastContactAt)}
                onChange={(event) =>
                  set({ lastContactAt: dateValue(event.target.value) })
                }
              />
            </label>
          </div>
        </details>
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
