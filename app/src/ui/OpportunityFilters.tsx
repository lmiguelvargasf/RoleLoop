import type { OpportunityView } from "../shared/opportunity-views";

export function OpportunityFilters({
  country,
  view,
  onViewChange,
}: {
  country: string;
  view: OpportunityView;
  onViewChange: (view: OpportunityView) => void;
}) {
  return (
    <select
      className="job-view-select"
      aria-label="Job view"
      value={view}
      onChange={(event) => onViewChange(event.target.value as OpportunityView)}
    >
      <option value="matches">Matches for {country || "your country"}</option>
      <option value="review">Needs review</option>
      <option value="all">All saved</option>
      <option value="archived">Archived</option>
    </select>
  );
}
