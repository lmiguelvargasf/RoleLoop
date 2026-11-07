import { describe, expect, it } from "vitest";
import type { Activity, Bootstrap, Run } from "../src/shared/types";
import { buildActivityItems } from "../src/ui/activity-model";
import { demoOpportunities } from "./fixtures";
import { outreachProgressFor } from "../src/shared/outreach-board";

const at = "2026-11-07T18:20:00.000Z";
const run = (patch: Partial<Run> = {}): Run => ({
  id: "search-1",
  action: "discover",
  status: "completed",
  progress: 100,
  message: "Evaluated 30 opportunities",
  createdAt: at,
  updatedAt: at,
  ...patch,
});
const event = (patch: Partial<Activity> = {}): Activity => ({
  id: "event-1",
  message: "Search and automation preferences saved.",
  kind: "info",
  createdAt: at,
  ...patch,
});
const build = (
  data: Partial<Pick<Bootstrap, "runs" | "events" | "opportunities">>,
) => buildActivityItems({ runs: [], events: [], opportunities: [], ...data });
const visible = (item: ReturnType<typeof build>[number]) =>
  [item.title, item.description, item.nextStep, item.action?.label].join(" ");

describe("user-facing activity", () => {
  it("routes outreach progress and draft recovery to the tracked startup board", () => {
    const startup = demoOpportunities().find((op) => op.kind === "startup")!;
    const tracked = {
      ...startup,
      outreach: outreachProgressFor(startup, "contacted"),
    };
    const [item] = build({
      opportunities: [tracked],
      events: [
        event({
          category: "outreach",
          opportunityId: tracked.id,
          message: `Outreach status updated for ${tracked.company}: To contact → Contacted.`,
        }),
      ],
    });
    expect(item.category).toBe("outreach");
    expect(item.action).toEqual({
      label: "View startup outreach",
      page: "outreach",
      opportunityId: tracked.id,
    });
    const [failure] = build({
      opportunities: [tracked],
      runs: [
        run({
          action: "draft",
          status: "failed",
          opportunityId: tracked.id,
          message: "Could not prepare outreach.",
        }),
      ],
    });
    expect(failure.action?.page).toBe("outreach");
    const [archived] = build({
      opportunities: [{ ...tracked, stage: "archived" }],
      events: [
        event({
          category: "outreach",
          opportunityId: tracked.id,
          message: `Archived ${tracked.company}.`,
        }),
      ],
    });
    expect(archived.action?.page).toBe("startups");
  });

  it("explains the historic scheduled-search JSON without requesting retired profile fields", () => {
    const message = `Scheduled discovery: ${JSON.stringify([
      {
        expected: "string",
        code: "invalid_type",
        path: ["profile", "headline"],
        message: "Invalid input: expected string, received undefined",
      },
      {
        expected: "string",
        code: "invalid_type",
        path: ["profile", "email"],
        message: "Invalid input: expected string, received undefined",
      },
      {
        expected: "string",
        code: "invalid_type",
        path: ["profile", "summary"],
        message: "Invalid input: expected string, received undefined",
      },
      {
        expected: "array",
        code: "invalid_type",
        path: ["profile", "skills"],
        message: "Invalid input: expected array, received undefined",
      },
    ])}`;
    const [item] = build({ events: [event({ message, kind: "error" })] });
    expect(item.title).toBe("Scheduled search couldn’t start");
    expect(item.description).toBe(
      "RoleLoop couldn’t read some saved resume information.",
    );
    expect(item.action).toEqual({ label: "Open Resume", page: "profile" });
    expect(item.nextStep).toContain("restart RoleLoop");
    expect(item.technicalDetails).toBe(message);
    expect(visible(item)).not.toMatch(
      /invalid_type|undefined|headline|email|skills|"path"|missing/,
    );
    expect(item.createdAt).toBe(at);
  });

  it.each([
    "TypeError: Cannot read properties of undefined\n at processRun (/app/service.ts:42:7)",
    'SQLSTATE 23505: duplicate key value violates unique constraint "events_pkey"',
    'relation "public.workspace" does not exist',
    "HTTP 404: GET https://example.com/api/private",
    "<html><body>Server error</body></html>",
    JSON.stringify({ code: "unrecognized", details: ["internal"] }),
    "Internal failure ".repeat(100),
  ])(
    "keeps unexpected technical content out of the main message: %s",
    (message) => {
      const [item] = build({ events: [event({ kind: "error", message })] });
      expect(item.description).toBe(
        "RoleLoop couldn’t finish this action. The detailed error is available below.",
      );
      expect(item.technicalDetails).toBe(message);
      expect(visible(item)).not.toContain(message);
    },
  );

  it("preserves a readable error rather than inventing its cause", () => {
    const [item] = build({
      events: [
        event({
          kind: "error",
          message: "The company did not provide a readable job description.",
        }),
      ],
    });
    expect(item.description).toBe(
      "The company did not provide a readable job description.",
    );
    expect(item.nextStep).toContain("try again");
  });

  it("gives useful destinations for known error classes", () => {
    const messages = [
      ["OPENAI_API_KEY is not configured", "account"],
      ["OpenAI rate limit reached (429)", "account"],
      ["Daily draft limit reached.", "settings"],
      [
        "Master CV processing failed. Retry processing or replace the CV.",
        "profile",
      ],
      ["Startup research is paused.", "startups"],
    ] as const;
    for (const [message, page] of messages) {
      const [item] = build({ events: [event({ kind: "error", message })] });
      expect(item.action?.page).toBe(page);
      expect(item.nextStep).toBeTruthy();
    }
  });

  it("does not send source access restrictions to the unrelated AI account settings", () => {
    for (const message of [
      "Acme jobs: HTTP 403",
      "Acme jobs: rate limit reached (429)",
    ]) {
      const [item] = build({
        events: [event({ kind: "error", category: "search", message })],
      });
      expect(item.action?.page).toBe("jobs");
      expect(item.nextStep).not.toContain("Account");
      expect(item.description).not.toContain("HTTP");
      expect(item.title).toBe("Search issue · Acme jobs");
    }
  });

  it("keeps fixed company limits separate from preferences the user can change", () => {
    for (const message of [
      "Company discovery has reached its current limit. New companies cannot be added in this search.",
      "1 new company connected from 5 employers found. Your 50-source limit is reached.",
    ]) {
      const [item] = build({
        events: [event({ category: "search", kind: "warning", message })],
      });
      expect(item.title).toBe("Company discovery limit reached");
      expect(item.action?.page).toBe("jobs");
      expect(item.nextStep).toContain("Existing company searches can continue");
      expect(item.nextStep).not.toContain("preferences");
    }
    const [missing] = build({
      events: [
        event({
          category: "search",
          kind: "warning",
          message:
            "Set your target roles and working country in Settings to find new companies.",
        }),
      ],
    });
    expect(missing.action?.page).toBe("settings");
    expect(missing.nextStep).toContain("preferences");
  });

  it("does not mistake source keys and quotas for AI account problems", () => {
    for (const message of [
      "Employer discovery: Himalayas API key has an invalid format. Update the server configuration.",
      "New-company discovery was unavailable. Himalayas API key has an invalid format. Update the server configuration.",
      "Employer discovery: Source quota exceeded.",
    ]) {
      const [item] = build({
        events: [event({ category: "search", kind: "warning", message })],
      });
      expect(item.action?.page).toBe("jobs");
      expect(item.nextStep).not.toContain("Account");
      expect(item.description).not.toMatch(/API key|server configuration/);
      expect(item.technicalDetails).toBe(message);
    }
  });

  it("preserves a safe source label while keeping its technical failure collapsed", () => {
    const [item] = build({
      events: [
        event({
          category: "search",
          kind: "error",
          message: "GitLab: TypeError: Cannot read properties of undefined",
        }),
      ],
    });
    expect(item.title).toBe("Search issue · GitLab");
    expect(visible(item)).not.toContain("TypeError");
    const [unsafe] = build({
      events: [
        event({
          category: "search",
          kind: "error",
          message: '{"code":"invalid_type"}: failure',
        }),
      ],
    });
    expect(visible(unsafe)).not.toContain("invalid_type");
    const [scheduled] = build({
      events: [
        event({
          category: "search",
          kind: "error",
          message: "Scheduled discovery: fetch failed",
        }),
      ],
    });
    expect(scheduled.title).toBe("Scheduled search couldn’t start");
  });

  it("uses profile validation recovery for failed runs as well as legacy events", () => {
    const [item] = build({
      runs: [
        run({
          status: "failed",
          message: "ZodError: profile cache invalid_type",
        }),
      ],
    });
    expect(item.action?.page).toBe("profile");
    expect(item.status).toBe("error");
    expect(item.description).toContain("saved resume information");
  });

  it("does not report existing legacy evaluations as new opportunities", () => {
    const [item] = build({ runs: [run()] });
    expect(item.description).toContain("30 opportunities evaluated");
    expect(item.description).toContain("already in your workspace");
    expect(item.summary).toBeUndefined();
    expect(item.description).not.toContain("new");
  });

  it("makes legacy partial searches visible despite a completed or green status", () => {
    const items = build({
      runs: [
        run({ message: "Evaluated 30 opportunities; 1 source(s) failed" }),
      ],
      events: [
        event({
          kind: "success",
          message: "Discovery evaluated 30 opportunities; 1 source(s) failed.",
        }),
      ],
    });
    for (const item of items) {
      expect(item.status).toBe("partial");
      expect(item.description).toContain(
        "1 source did not finish successfully",
      );
    }
  });

  it("preserves structured outcomes and keeps count labels out of duplicate prose", () => {
    const summary = {
      evaluated: 10,
      newOpportunities: 4,
      existingOpportunities: 6,
      draftsCreated: 2,
      sourcesChecked: 5,
      sourcesFailed: 0,
      companiesConnected: 1,
      draftFailures: 1,
    };
    const [item] = build({ runs: [run({ outcome: "partial", summary })] });
    expect(item.status).toBe("partial");
    expect(item.summary).toEqual(summary);
    expect(item.description).toContain(
      "Some parts of the search could not finish",
    );
    expect(item.description).not.toMatch(/4 newly|6 already|2 drafts/);
  });

  it("does not imply failed sources saved no results", () => {
    const summary = {
      evaluated: 2,
      newOpportunities: 3,
      existingOpportunities: 0,
      draftsCreated: 0,
      sourcesChecked: 1,
      sourcesFailed: 1,
      companiesConnected: 0,
      draftFailures: 0,
    };
    const [partial] = build({ runs: [run({ summary, outcome: "partial" })] });
    expect(partial.description).toContain(
      "1 source did not finish successfully",
    );
    expect(partial.description).not.toContain("could not be checked");
    const [failed] = build({
      runs: [
        run({
          summary,
          status: "failed",
          message:
            "All selected sources failed. See Activity for source errors.",
        }),
      ],
    });
    expect(failed.description).toContain(
      "None of the selected sources finished successfully",
    );
    expect(failed.description).toContain(
      "results already saved remain available",
    );
    expect(failed.summary?.newOpportunities).toBe(3);
  });

  it("shows incomplete AI evaluations even when every source succeeded", () => {
    const [item] = build({
      runs: [
        run({
          summary: {
            evaluated: 3,
            newOpportunities: 3,
            existingOpportunities: 0,
            draftsCreated: 0,
            sourcesChecked: 2,
            sourcesFailed: 0,
            companiesConnected: 0,
            draftFailures: 0,
            evaluationFailures: 2,
          },
        }),
      ],
    });
    expect(item.status).toBe("partial");
    expect(item.description).toContain("2 AI evaluations could not finish");
    expect(item.description).not.toContain("source did not finish");
  });

  it.each([
    [
      "Application status updated for Engineer at Acme: Saved → Applied.",
      "Application marked as applied",
    ],
    [
      "Application status updated for Engineer at Acme: Applied → Interview.",
      "Application marked as interview",
    ],
    ["Archived Engineer at Acme.", "Opportunity archived"],
    ["Restored Engineer at Acme from the archive.", "Opportunity restored"],
    ["Added job: Engineer at Acme.", "Job added"],
    ["Added startup prospect: Founder at Acme.", "Startup prospect added"],
  ])("makes the user decision scannable: %s", (message, title) => {
    const [item] = build({
      events: [event({ category: "application", message })],
    });
    expect(item.title).toBe(title);
    expect(item.description).toContain("Acme");
    if (message.startsWith("Added startup"))
      expect(item.action?.page).toBe("startups");
  });

  it("groups only explicitly linked events and retains orphaned or legacy entries", () => {
    const items = build({
      runs: [run()],
      events: [
        event({
          id: "linked",
          runId: "search-1",
          kind: "error",
          message: "Acme: fetch failed",
        }),
        event({ id: "legacy" }),
        event({ id: "orphan", runId: "not-loaded" }),
      ],
    });
    expect(items).toHaveLength(3);
    const group = items.find((item) => item.id === "run:search-1")!;
    expect(group.events?.map((item) => item.id)).toEqual(["event:linked"]);
    expect(group.status).toBe("partial");
    expect(items.map((item) => item.id)).toContain("event:orphan");
    expect(items.map((item) => item.id)).toContain("event:legacy");
    expect(items.map((item) => item.id)).not.toContain("event:linked");
  });

  it("uses company context and useful destinations without assuming a deleted opportunity exists", () => {
    const op = demoOpportunities()[0];
    const [item] = build({
      runs: [run({ action: "analyze", opportunityId: op.id })],
      opportunities: [op],
    });
    expect(item.title).toContain(op.company);
    expect(item.action).toMatchObject({ page: "jobs", opportunityId: op.id });
    const [missing] = build({
      runs: [run({ action: "analyze", opportunityId: "missing" })],
    });
    expect(missing.action).toEqual({
      page: "jobs",
      label: "View opportunities",
    });
    const [startup] = build({ runs: [run({ discoveryScope: "startups" })] });
    expect(startup.title).toBe("Startup search");
    expect(startup.action?.page).toBe("startups");
    const [research] = build({
      runs: [run({ action: "research", opportunityId: "missing" })],
    });
    expect(research.action?.page).toBe("startups");
  });

  it("makes draft navigation and historical local tests explicit", () => {
    const op = demoOpportunities()[0];
    const [draft] = build({
      runs: [run({ action: "draft", opportunityId: op.id })],
      opportunities: [op],
    });
    expect(draft.action).toEqual({
      label: "View drafts",
      page: "drafts",
      opportunityId: op.id,
    });
    expect(draft.description).toContain("Nothing was sent");
    const [test] = build({
      events: [
        event({
          kind: "success",
          message:
            "Mock application accepted locally • 2026-11-05 • no employer contacted",
        }),
      ],
    });
    expect(test.title).toBe("Local test completed");
    expect(test.description).toContain("No employer was contacted");
  });

  it("routes failed draft preparation to the opportunity rather than a draft that may not exist", () => {
    const op = demoOpportunities()[0];
    const [failed] = build({
      runs: [
        run({
          action: "draft",
          status: "failed",
          opportunityId: op.id,
          message: "Draft could not be prepared.",
        }),
      ],
      opportunities: [op],
    });
    expect(failed.action).toEqual({
      label: "View opportunity",
      page: "jobs",
      opportunityId: op.id,
    });
    const [failedEvent] = build({
      events: [
        event({
          category: "draft",
          kind: "error",
          opportunityId: op.id,
          message: `Draft for ${op.company}: fetch failed`,
        }),
      ],
      opportunities: [op],
    });
    expect(failedEvent.action).toEqual(failed.action);
  });

  it("humanizes running and queued tasks and clamps invalid progress", () => {
    const [queued] = build({
      runs: [
        run({
          status: "queued",
          message: "Waiting for the local worker",
          progress: -10,
        }),
      ],
    });
    expect(queued.progress).toBe(0);
    expect(queued.description).not.toContain("worker");
    const [running] = build({
      runs: [
        run({ status: "running", message: "Worker started", progress: 120 }),
      ],
    });
    expect(running.progress).toBe(100);
    expect(running.description).toBe("Getting started…");
    const [invalid] = build({
      runs: [
        run({
          status: "running",
          message: "invalid_type undefined",
          progress: NaN,
        }),
      ],
    });
    expect(invalid.progress).toBe(0);
    expect(invalid.description).toBe("Working on this task…");
  });

  it("sorts records by when they started and preserves completion time separately", () => {
    const items = build({
      runs: [
        run({
          createdAt: "2026-11-06T10:00:00Z",
          updatedAt: "2026-11-07T20:00:00Z",
        }),
      ],
      events: [event()],
    });
    expect(items[0].id).toBe("event:event-1");
    expect(items[1].updatedAt).toBe("2026-11-07T20:00:00Z");
  });

  it("does not let malformed labels or very long diagnostics dominate the feed", () => {
    const op = {
      ...demoOpportunities()[0],
      company: '{"internal":"invalid_type"}',
    };
    const [item] = build({
      runs: [run({ action: "draft", opportunityId: op.id })],
      opportunities: [op],
    });
    expect(item.title).toContain("this company");
    expect(visible(item)).not.toContain("invalid_type");
    const [error] = build({
      events: [event({ kind: "error", message: "a".repeat(20000) })],
    });
    expect(error.description.length).toBeLessThan(200);
    expect(error.technicalDetails!.length).toBeLessThan(12100);
  });

  it("handles unknown historic actions and empty messages without inventing results", () => {
    const [item] = build({
      runs: [run({ action: "retired" as Run["action"], message: "" })],
    });
    expect(item.title).toBe("Background task");
    expect(item.description).toBe("The task finished.");
    expect(item.action).toBeUndefined();
    expect(
      build({ events: [event({ message: "" })] })[0].description,
    ).toBeTruthy();
  });
});
