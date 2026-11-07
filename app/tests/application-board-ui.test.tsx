import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationsBoard } from "../src/ui/ApplicationsBoard";
import { applicationProgressFor } from "../src/shared/application-board";
import { demoOpportunities } from "./fixtures";

const props = {
  busy: false,
  perform: async () => true,
  onSelect: () => {},
  onBrowse: () => {},
};

describe("application board interface", () => {
  it("keeps imported jobs out of the board and gives an empty board a browse action", () => {
    const jobs = demoOpportunities().map((op) => ({
      ...op,
      application: undefined,
    }));
    const html = renderToStaticMarkup(
      <ApplicationsBoard {...props} opportunities={jobs} />,
    );
    expect(html).toContain("Browse jobs");
    expect(html).toContain("Choose the jobs you want to pursue.");
    expect(html).not.toContain('class="application-card"');
    expect(html.match(/class="application-column-heading"/g)).toHaveLength(5);
  });

  it("shows distinct closed outcomes and accessible job details while leaving archives out", () => {
    const base = demoOpportunities().find((op) => op.kind === "job")!;
    const jobs = [
      {
        ...base,
        id: "selected",
        title: "Selected role",
        application: applicationProgressFor(base, "saved"),
      },
      {
        ...base,
        id: "rejected",
        title: "Rejected role",
        application: applicationProgressFor(base, "rejected"),
      },
      {
        ...base,
        id: "withdrawn",
        title: "Withdrawn role",
        application: applicationProgressFor(base, "withdrawn"),
      },
      {
        ...base,
        id: "archived",
        title: "Archived role",
        stage: "archived" as const,
        application: applicationProgressFor(base, "applied"),
      },
    ];
    const html = renderToStaticMarkup(
      <ApplicationsBoard {...props} opportunities={jobs} />,
    );
    expect(html).toContain("Selected role");
    expect(html).not.toContain("Archived role");
    expect(html).toContain('application-outcome-rejected">Rejected');
    expect(html).toContain('application-outcome-withdrawn">Withdrawn');
    expect(html).not.toContain("<select");
    expect(html.match(/class="application-card-title"/g)).toHaveLength(3);
    expect(html).toContain("Open a job to change its status");
  });
});
