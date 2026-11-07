import type { OpportunityView } from "../shared/opportunity-views";
import { SelectField } from "./SelectField";

export function OpportunityFilters({
  view,
  onViewChange,
}: {
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
          { value: "recommended", label: "Recommended" },
          { value: "all", label: "All saved" },
          { value: "archived", label: "Archived" },
        ]}
      />
    </div>
  );
}
