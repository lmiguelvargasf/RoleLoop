import { SlidersHorizontal } from "lucide-react";
import type { OpportunityView } from "../shared/opportunity-views";

const refinements: Partial<
  Record<OpportunityView, ReadonlyArray<readonly [string, string]>>
> = {
  review: [
    ["all", "All review items"],
    ["location-review", "Hiring location"],
    ["fit-review", "Qualifications and other questions"],
  ],
  all: [
    ["all", "All saved jobs"],
    ["excluded", "Excluded by preferences"],
    ["location-review", "Needs location review"],
  ],
};

export function OpportunityFilters({
  country,
  view,
  detail,
  onViewChange,
  onDetailChange,
}: {
  country: string;
  view: OpportunityView;
  detail: string;
  onViewChange: (view: OpportunityView) => void;
  onDetailChange: (detail: string) => void;
}) {
  const options = refinements[view] ?? [];
  const activeLabel = options.find(([value]) => value === detail)?.[1];
  return (
    <div className="job-filter-controls">
      <select
        aria-label="Job view"
        value={view}
        onChange={(event) =>
          onViewChange(event.target.value as OpportunityView)
        }
      >
        <option value="matches">Matches for {country || "your country"}</option>
        <option value="review">Needs review</option>
        <option value="all">All saved</option>
        <option value="archived">Archived</option>
      </select>
      {options.length > 0 && (
        <details className="job-filter-details" key={view}>
          <summary>
            <SlidersHorizontal size={13} aria-hidden="true" />
            {detail === "all" ? "More filters" : activeLabel}
          </summary>
          <div className="job-filter-panel">
            <label className="field">
              <span>{view === "review" ? "Review reason" : "Show"}</span>
              <select
                value={detail}
                onChange={(event) => onDetailChange(event.target.value)}
              >
                {options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {detail !== "all" && (
              <button
                className="text-button"
                type="button"
                onClick={() => onDetailChange("all")}
              >
                Clear filter
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
