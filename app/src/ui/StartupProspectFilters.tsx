import type {
  StartupSourceFilter,
  StartupView,
} from "../shared/startup-prospects";
import { SelectField } from "./SelectField";

export function StartupProspectFilters({
  view,
  onViewChange,
  source,
  sourceOptions,
  onSourceChange,
}: {
  view: StartupView;
  onViewChange: (view: StartupView) => void;
  source: StartupSourceFilter;
  sourceOptions: { value: StartupSourceFilter; label: string }[];
  onSourceChange: (source: StartupSourceFilter) => void;
}) {
  return (
    <div className="job-list-filters startup-list-filters">
      <div className="job-view-select">
        <SelectField<StartupView>
          label="Startup view"
          value={view}
          onChange={onViewChange}
          options={[
            { value: "explore", label: "To explore" },
            { value: "all", label: "All saved" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </div>
      <div className="job-view-select">
        <SelectField<StartupSourceFilter>
          label="Startup source"
          value={source}
          onChange={onSourceChange}
          options={sourceOptions}
        />
      </div>
    </div>
  );
}
