import type { OpportunityView } from "../shared/opportunity-views";
import type { JobSourceFilter } from "../shared/job-sources";
import { SelectField } from "./SelectField";

export function OpportunityFilters({
  view,
  onViewChange,
  source,
  sourceOptions,
  onSourceChange,
}: {
  view: OpportunityView;
  onViewChange: (view: OpportunityView) => void;
  source: JobSourceFilter;
  sourceOptions: { value: JobSourceFilter; label: string }[];
  onSourceChange: (source: JobSourceFilter) => void;
}) {
  return (
    <div className="job-list-filters">
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
      <div className="job-view-select">
        <SelectField<JobSourceFilter>
          label="Job source"
          value={source}
          onChange={onSourceChange}
          options={sourceOptions}
        />
      </div>
    </div>
  );
}
