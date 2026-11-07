import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartupProspectFilters } from "../src/ui/StartupProspectFilters";

describe("startup prospect filters", () => {
  it("gives the company view and source distinct accessible labels", () => {
    const html = renderToStaticMarkup(
      <StartupProspectFilters
        view="explore"
        onViewChange={() => {}}
        source="all"
        sourceOptions={[{ value: "all", label: "All sources" }]}
        onSourceChange={() => {}}
      />,
    );
    expect(html).toContain("Startup view");
    expect(html).toContain("Startup source");
    expect(html).toContain("To explore");
    expect(html).toContain("All sources");
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(2);
  });
});
