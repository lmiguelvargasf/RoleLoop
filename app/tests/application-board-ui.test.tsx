import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationsBoard } from "../src/ui/ApplicationsBoard";
import { applicationProgressFor } from "../src/shared/application-board";
import { assessOpportunity } from "../src/domain/rules";
import type { Opportunity } from "../src/shared/types";
import { demoOpportunities, demoWorkspace } from "./fixtures";

const props = {
  busy: false,
  perform: async () => true,
  onSelect: () => {},
};

function evaluatedJob() {
  const job = demoOpportunities()[0];
  const workspace = demoWorkspace();
  job.application = applicationProgressFor(job, "saved");
  job.assessment = assessOpportunity(
    job,
    workspace.profile,
    workspace.preferences,
  );
  job.assessment.fitEvaluation = {
    method: "semantic",
    status: "complete",
    assessedRequired: 2,
    totalRequired: 2,
  };
  job.assessment.essentialScore = 87.4;
  job.assessment.score = 99;
  return job;
}

describe("application board interface", () => {
  it("replaces long country lists with salary and required qualification coverage", () => {
    const job = evaluatedJob();
    job.location = "Remote: Anguilla; Antigua and Barbuda; Argentina; Ecuador";
    job.application!.nextAction = "Contact the recruiter";
    const html = renderToStaticMarkup(
      <ApplicationsBoard {...props} opportunities={[job]} />,
    );
    expect(html).not.toContain(job.location);
    expect(html).not.toContain("application-card-location");
    expect(html).toContain("USD");
    expect(html).toContain("$100K–$140K / year");
    expect(html).toContain("Required match");
    expect(html).toContain("87%");
    expect(html).not.toContain("99%");
    expect(html).toContain('value="87.4"');
    expect(html).toContain('aria-label="Required qualification match"');
    expect(html).toContain("Prepare application");
    expect(html).toContain("Contact the recruiter");
  });

  it.each<[string, (job: Opportunity) => void, string]>([
    [
      "not evaluated",
      (job) => {
        job.assessment = null;
      },
      "Needs AI evaluation",
    ],
    [
      "skills only",
      (job) => {
        job.assessment!.fitEvaluation!.method = "skills";
      },
      "Needs AI evaluation",
    ],
    [
      "partial",
      (job) => {
        job.assessment!.fitEvaluation!.status = "partial";
      },
      "Needs AI evaluation",
    ],
    [
      "failed",
      (job) => {
        job.assessment!.fitEvaluation!.status = "partial";
        job.assessment!.fitEvaluation!.failureReason = "Timed out";
      },
      "Evaluation failed",
    ],
    [
      "truncated description",
      (job) => {
        job.descriptionTruncated = true;
      },
      "Incomplete job description",
    ],
    [
      "truncated requirements",
      (job) => {
        job.requirementsTruncated = true;
      },
      "Incomplete requirements",
    ],
    [
      "missing requirements",
      (job) => {
        job.requirements = [];
      },
      "Requirements unavailable",
    ],
  ])("shows an honest status for %s assessments", (_, change, label) => {
    const job = evaluatedJob();
    change(job);
    const html = renderToStaticMarkup(
      <ApplicationsBoard {...props} opportunities={[job]} />,
    );
    expect(html).toContain(label);
    expect(html).not.toContain("87%");
    expect(html).not.toContain("<meter");
  });

  it.each([
    {
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: "year" as const,
      label: "Salary to confirm",
    },
    {
      salaryMin: 4000,
      salaryMax: 6000,
      salaryPeriod: "month" as const,
      label: "$4K–$6K / month",
    },
    {
      salaryMin: 40,
      salaryMax: null,
      salaryPeriod: "hour" as const,
      label: "$40+ / hour",
    },
    {
      salaryMin: null,
      salaryMax: 60000,
      salaryPeriod: "year" as const,
      label: "Up to $60K / year",
    },
    {
      salaryMin: 5000,
      salaryMax: 5000,
      salaryPeriod: "unknown" as const,
      label: "$5K · period unconfirmed",
    },
  ])("keeps compensation honest: $label", ({ label, ...salary }) => {
    const job = { ...evaluatedJob(), ...salary };
    const html = renderToStaticMarkup(
      <ApplicationsBoard {...props} opportunities={[job]} />,
    );
    expect(html).toContain(label);
  });

  it("keeps imported jobs out of the board and gives an empty board guidance", () => {
    const jobs = demoOpportunities().map((op) => ({
      ...op,
      application: undefined,
    }));
    const html = renderToStaticMarkup(
      <ApplicationsBoard {...props} opportunities={jobs} />,
    );
    expect(html).not.toContain("Browse jobs");
    expect(html).not.toContain("Search applications");
    expect(html).not.toContain("Follow-ups due");
    expect(html).not.toContain('class="application-board-count"');
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
