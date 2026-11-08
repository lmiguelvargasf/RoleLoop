import type { OpportunityView } from "../shared/opportunity-views";
import type { JobSourceFilter } from "../shared/job-sources";
import { SelectField } from "./SelectField";

export function OpportunityFilters({
  view,
  onViewChange,
  source,
  sourceOptions,
  onSourceChange,
  engagement = "all",
  onEngagementChange,
}: {
  view: OpportunityView;
  onViewChange: (view: OpportunityView) => void;
  source: JobSourceFilter;
  sourceOptions: { value: JobSourceFilter; label: string }[];
  onSourceChange: (source: JobSourceFilter) => void;
  engagement?: "all" | "full_time" | "flexible" | "unknown";
  onEngagementChange?: (
    value: "all" | "full_time" | "flexible" | "unknown",
  ) => void;
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
      {onEngagementChange && (
        <div className="job-view-select">
          <SelectField
            label="Work type"
            value={engagement}
            onChange={onEngagementChange}
            options={[
              { value: "all", label: "All work types" },
              { value: "full_time", label: "Full-time employment" },
              { value: "flexible", label: "Contracts & part-time" },
              { value: "unknown", label: "Type not stated" },
            ]}
          />
        </div>
      )}
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
