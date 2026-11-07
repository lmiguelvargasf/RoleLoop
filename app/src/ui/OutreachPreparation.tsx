import { Mail, LoaderCircle, RotateCw } from "lucide-react";
import type { Draft, Opportunity, Run } from "../shared/types";
import { outreachColumn } from "../shared/outreach-board";
import { write } from "./api";

export function OutreachPreparation({
  opportunity,
  drafts,
  runs,
  busy,
  perform,
  onReviewFit,
}: {
  opportunity: Opportunity;
  drafts: Draft[];
  runs: Run[];
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
  onReviewFit: () => void;
}) {
  const column = outreachColumn(opportunity);
  if (!column) return null;
  const draft = drafts
    .filter(
      (item) =>
        item.opportunityId === opportunity.id && item.kind === "outreach",
    )
    .reduce<
      Draft | undefined
    >((latest, item) => (!latest || item.createdAt > latest.createdAt ? item : latest), undefined);
  const canPrepare = column === "to_contact";
  const tasks = runs.filter(
    (run) => run.action === "draft" && run.opportunityId === opportunity.id,
  );
  const active = tasks.some(
    (run) => run.status === "queued" || run.status === "running",
  );
  const latest = tasks.reduce<Run | undefined>(
    (last, run) => (!last || run.createdAt > last.createdAt ? run : last),
    undefined,
  );
  const failed =
    canPrepare &&
    !active &&
    latest?.status === "failed" &&
    (!draft || latest.updatedAt > draft.createdAt);
  const excluded = opportunity.assessment?.recommendation === "excluded";
  const prepare = () =>
    void perform(
      () => write("/runs", { action: "draft", opportunityId: opportunity.id }),
      "Preparing outreach. Your draft will appear on this card.",
    );
  if (!canPrepare && !draft && !active) return null;

  return (
    <div className="application-preparation">
      {failed && (
        <p className="application-preparation-error">
          {draft ? "Couldn’t update the draft." : "Couldn’t prepare outreach."}{" "}
          <a href="#activity">View error</a>
        </p>
      )}
      {active ? (
        <span className="application-preparing" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          Preparing outreach…
        </span>
      ) : draft ? (
        <div className="application-review-actions">
          <a
            className="application-prepare-button"
            href={`#drafts?opportunity=${encodeURIComponent(opportunity.id)}`}
          >
            <Mail size={14} aria-hidden="true" />
            Review outreach
          </a>
          {canPrepare && !excluded && (
            <button
              type="button"
              className="icon-button"
              aria-label="Prepare outreach again"
              title="Prepare again"
              disabled={busy}
              onClick={prepare}
            >
              <RotateCw size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      ) : excluded ? (
        <button
          type="button"
          className="application-prepare-button"
          onClick={onReviewFit}
        >
          Review fit before preparing
        </button>
      ) : (
        <button
          type="button"
          className="application-prepare-button"
          disabled={busy}
          onClick={prepare}
        >
          <Mail size={14} aria-hidden="true" />
          {failed ? "Retry preparation" : "Prepare outreach"}
        </button>
      )}
    </div>
  );
}
