import { FileText, LoaderCircle, RotateCw } from "lucide-react";
import type { Draft, Opportunity, Run } from "../shared/types";
import { applicationColumn } from "../shared/application-board";
import { write } from "./api";

export function ApplicationPreparation({
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
  if (applicationColumn(opportunity) !== "to_apply") return null;
  const draft = drafts.find((item) => item.opportunityId === opportunity.id);
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
    !active &&
    latest?.status === "failed" &&
    (!draft || latest.updatedAt > draft.createdAt);
  const excluded = opportunity.assessment?.recommendation === "excluded";
  const prepare = () =>
    void perform(
      () => write("/runs", { action: "draft", opportunityId: opportunity.id }),
      "Preparing application. Your documents will appear on this card.",
    );

  return (
    <div className="application-preparation">
      {failed && (
        <p className="application-preparation-error">
          {draft ? "Couldn’t update documents." : "Couldn’t prepare documents."}{" "}
          <a href="#activity">View error</a>
        </p>
      )}
      {active ? (
        <span className="application-preparing" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          Preparing application…
        </span>
      ) : draft ? (
        <div className="application-review-actions">
          <a
            className="application-prepare-button"
            href={`#drafts?opportunity=${encodeURIComponent(opportunity.id)}`}
          >
            <FileText size={14} aria-hidden="true" />
            Review application
          </a>
          {!excluded && (
            <button
              type="button"
              className="icon-button"
              aria-label="Prepare application again"
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
        <>
          <button
            type="button"
            className="application-prepare-button"
            disabled={busy}
            onClick={prepare}
          >
            <FileText size={14} aria-hidden="true" />
            {failed ? "Retry preparation" : "Prepare application"}
          </button>
        </>
      )}
    </div>
  );
}
