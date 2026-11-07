import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityPage, activityMatches } from "../src/ui/ActivityPage";
import { buildActivityItems } from "../src/ui/activity-model";
import type { Bootstrap } from "../src/shared/types";
import { demoOpportunities, demoWorkspace } from "./fixtures";

function data(): Bootstrap {
  return {
    ...demoWorkspace(),
    opportunities: demoOpportunities(),
    drafts: [],
    runs: [],
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
  };
}

describe("Activity reading and recovery", () => {
  it("matches category and query on the same nested update", () => {
    const bootstrap = data();
    const createdAt = "2026-11-07T12:00:00Z";
    bootstrap.runs = [
      {
        id: "search",
        action: "discover",
        status: "completed",
        progress: 100,
        message: "Evaluated 5 opportunities",
        createdAt,
        updatedAt: createdAt,
      },
    ];
    bootstrap.events = [
      {
        id: "draft",
        runId: "search",
        category: "draft",
        kind: "success",
        createdAt,
        message: "Prepared application draft for Northstar Tools.",
      },
      {
        id: "error",
        runId: "search",
        category: "search",
        kind: "error",
        createdAt,
        message: "GitLab: HTTP 503 Service unavailable",
      },
    ];
    const [group] = buildActivityItems(bootstrap);
    expect(activityMatches(group, "drafts", "Northstar")).toBe(true);
    expect(activityMatches(group, "drafts", "GitLab")).toBe(false);
    expect(activityMatches(group, "issues", "GitLab")).toBe(true);
    expect(activityMatches(group, "all", "GitLab")).toBe(true);
  });
  it("keeps historical validation JSON inside collapsed diagnostics with a visible recovery action", () => {
    const bootstrap = data();
    bootstrap.events = [
      {
        id: "old-error",
        kind: "error",
        createdAt: "2026-11-05T12:00:00Z",
        message:
          'Scheduled discovery: [{"code":"invalid_type","path":["profile","headline"],"message":"Invalid input: expected string, received undefined"}]',
      },
    ];
    const html = renderToStaticMarkup(<ActivityPage data={bootstrap} />);
    expect(html).toContain("Scheduled search couldn’t start");
    expect(html).toContain("Open Resume to check your details");
    expect(html).toMatch(
      /<a class="activity-action" href="#profile">Open Resume/,
    );
    expect(html).toMatch(
      /<details class="activity-technical"><summary>Technical details<\/summary>/,
    );
    expect(html.replace(/<pre>[\s\S]*?<\/pre>/g, "")).not.toContain(
      "invalid_type",
    );
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Happening now");
  });

  it("groups explicit task updates, exposes partial status and distinguishes new from existing opportunities", () => {
    const bootstrap = data();
    const createdAt = "2026-11-07T12:00:00Z";
    bootstrap.runs = [
      {
        id: "search",
        action: "discover",
        status: "completed",
        outcome: "partial",
        progress: 100,
        message: "Evaluated 5 opportunities; 1 source(s) failed",
        createdAt,
        updatedAt: createdAt,
        summary: {
          evaluated: 5,
          newOpportunities: 2,
          existingOpportunities: 3,
          draftsCreated: 1,
          sourcesChecked: 4,
          sourcesFailed: 1,
          companiesConnected: 0,
          draftFailures: 0,
        },
      },
    ];
    bootstrap.events = [
      {
        id: "draft",
        runId: "search",
        category: "draft",
        kind: "success",
        createdAt,
        opportunityId: bootstrap.opportunities[0].id,
        message: "Prepared application draft for Northstar Tools.",
      },
    ];
    const html = renderToStaticMarkup(<ActivityPage data={bootstrap} />);
    expect(html.match(/Application draft prepared/g)).toHaveLength(1);
    expect(html).toContain("Partial results");
    expect(html).toContain("new opportunities</dt><dd>2");
    expect(html).toContain("already saved</dt><dd>3");
    expect(html).toContain("#drafts?opportunity=demo-job-northstar");
    expect(html).toContain("Search details");
    expect(html).toContain("Started ");
    expect(html).toContain("Finished ");
  });

  it("identifies live tasks and offline processing without turning historical failures into alerts", () => {
    const bootstrap = data();
    bootstrap.status.worker = false;
    bootstrap.runs = [
      {
        id: "waiting",
        action: "discover",
        status: "queued",
        progress: 0,
        message: "Waiting for the local worker",
        createdAt: "2026-11-07T12:00:00Z",
        updatedAt: "2026-11-07T12:00:00Z",
      },
    ];
    const html = renderToStaticMarkup(<ActivityPage data={bootstrap} />);
    expect(html).toContain("Happening now");
    expect(html).toContain("Background processing is offline");
    expect(html).toContain('aria-label="Job search progress"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Waiting for the local worker");
  });

  it("offers a useful starting action and states the history coverage", () => {
    const html = renderToStaticMarkup(<ActivityPage data={data()} />);
    expect(html).toContain("Your activity will appear here");
    expect(html).toContain('href="#jobs"');
    expect(html).toContain("up to 100 tasks and 60 workspace events");
    expect(html).toContain("individual text edits are not recorded");
    expect(html).toContain('aria-label="Filter activity"');
    expect(html).toContain('aria-pressed="true"');
  });
});
