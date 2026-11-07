import type { OpportunityView } from "../shared/opportunity-views";
import { SelectField } from "./SelectField";

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
    <div className="job-view-select">
      <SelectField<OpportunityView>
        label="Job view"
        value={view}
        onChange={onViewChange}
        options={[
          {
            value: "matches",
            label: `Matches for ${country || "your country"}`,
          },
          { value: "review", label: "Needs review" },
          { value: "all", label: "All saved" },
          { value: "archived", label: "Archived" },
        ]}
      />
    </div>
  );
}
