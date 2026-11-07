import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpportunityFilters } from "../src/ui/OpportunityFilters";

describe("job filters", () => {
  it("labels the view and source selectors separately and defaults to all sources", () => {
    const html = renderToStaticMarkup(
      <OpportunityFilters
        view="all"
        onViewChange={() => {}}
        source="all"
        sourceOptions={[{ value: "all", label: "All sources" }, { value: "jobicy", label: "Jobicy" }]}
        onSourceChange={() => {}}
      />,
    );
    expect(html).toContain("Job view");
    expect(html).toContain("Job source");
    expect(html).toContain("All saved");
    expect(html).toContain("All sources");
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(2);
  });
});
