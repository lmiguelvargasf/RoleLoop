import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayPage } from "../src/ui/TodayPage";
import { assessOpportunity } from "../src/domain/rules";
import { applicationProgressFor } from "../src/shared/application-board";
import type { Bootstrap, Opportunity, Run } from "../src/shared/types";
import { demoOpportunities, demoWorkspace } from "./fixtures";

const now = new Date("2026-11-07T17:00:00Z");
const props = {
  busy: false,
  perform: async () => true,
  onOpenOpportunity: () => {},
  now,
};
const data = (
  opportunities: Opportunity[] = [],
  runs: Run[] = [],
): Bootstrap => ({
  ...demoWorkspace(),
  opportunities,
  drafts: [],
  runs,
  events: [],
  status: {
    database: true,
    worker: true,
    testMode: true,
    openaiConfigured: false,
    openaiModel: "",
    studioUrl: "",
    mailpitUrl: "",
  },
});

describe("Today interface", () => {
  it("offers actionable empty states without suggesting an interview probability or arbitrary target", () => {
    const html = renderToStaticMarkup(<TodayPage {...props} data={data()} />);
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("Last 7 days");
    expect(html).not.toContain('id="today-applications-title"');
    expect(html).toContain("No recommended jobs yet.");
    expect(html).toContain("Browse jobs");
    expect(html).toContain('href="#jobs"');
    expect(html).not.toContain("%");
  });

  it("keeps document preparation status directly alongside a selected application", () => {
    const job = { ...demoOpportunities(now)[0] };
    job.application = {
      ...applicationProgressFor(job, "saved"),
      nextAction: "Review the most relevant achievements",
    };
    const runs: Run[] = [
      {
        id: "prepare",
        action: "draft",
        opportunityId: job.id,
        status: "running",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        progress: 30,
        message: "Preparing",
      },
    ];
    const html = renderToStaticMarkup(
      <TodayPage {...props} data={data([job], runs)} />,
    );
    expect(html).toContain("To apply");
    expect(html).toContain("Preparing application…");
    expect(html).toContain('role="status"');
    expect(html).toContain(job.company);
  });

  it("keeps source attribution and stated contract hours beside a suggested job", () => {
    const workspace = demoWorkspace();
    const job = {
      ...demoOpportunities(now)[0],
      source: "himalayas",
      publishedAt: null,
      sourceUpdatedAt: now.toISOString(),
      sourceAttributionUrl:
        "https://himalayas.app/companies/example/jobs/engineer",
    };
    job.description += "\nEmployment type: Contract\n10–20 hours per week.";
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
      now,
    );
    const html = renderToStaticMarkup(
      <TodayPage {...props} data={data([job])} />,
    );
    expect(html).toContain(
      'href="https://himalayas.app/companies/example/jobs/engineer"',
    );
    expect(html).toContain("Himalayas");
    expect(html).toContain("Contract");
    expect(html).toContain("10–20 h/week");
    expect(html).not.toContain("Full-time");
    expect(html).toContain("Posting date unconfirmed");
    expect(html).not.toContain("Posted today");
    expect(html).toContain("Review job");
    expect(html).not.toContain("Your experience supports:");
  });

  it("reveals a due follow-up while leaving future follow-ups on the board", () => {
    const [first] = demoOpportunities(now);
    const due = {
      ...first,
      application: {
        ...applicationProgressFor(first, "applied"),
        followUpOn: "2026-11-06",
        nextAction: "Ask about the interview schedule",
      },
    };
    const future = {
      ...due,
      id: "future",
      company: "Future company",
      application: { ...due.application, followUpOn: "2026-11-20" },
    };
    const html = renderToStaticMarkup(
      <TodayPage {...props} data={data([due, future])} />,
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("Ask about the interview schedule");
    expect(html).toContain("Overdue");
    expect(html).not.toContain("Future company");
  });
});
