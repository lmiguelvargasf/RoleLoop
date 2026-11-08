import { afterEach, describe, expect, it, vi } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import { applicationProgressFor } from "../src/shared/application-board.js";
import { outreachProgressFor } from "../src/shared/outreach-board.js";
import {
  localDateKey,
  nextRecommendedJobs,
  postingRecency,
  recentMilestones,
  selectedApplications,
  similarJobKey,
  todayActions,
} from "../src/shared/today.js";
import type { Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const now = new Date("2026-11-08T02:00:00Z");
const base = demoOpportunities(now)[0];
const job = (
  id: string,
  status: NonNullable<Opportunity["application"]>["status"],
  followUpOn: string | null = null,
): Opportunity => ({
  ...base,
  id,
  title: `${id} role`,
  application: { ...applicationProgressFor(base, status), followUpOn },
});

afterEach(() => vi.unstubAllEnvs());

describe("Today action queue", () => {
  it("prioritizes ongoing conversations, then overdue follow-ups, without adding closed or archived work", () => {
    vi.stubEnv("TZ", "America/Guayaquil");
    const interview = job("interview", "interview", "2026-11-10");
    const overdue = job("overdue", "applied", "2026-11-06");
    const due = job("due", "applied", "2026-11-07");
    const future = job("future", "applied", "2026-11-08");
    const closed = job("closed", "rejected", "2026-11-01");
    const archived = {
      ...job("archived", "interview"),
      stage: "archived" as const,
    };
    const actions = todayActions(
      [future, due, closed, overdue, archived, interview],
      now,
    );
    expect(actions.map((item) => item.opportunity.id)).toEqual([
      "interview",
      "overdue",
      "due",
    ]);
    expect(actions[1].overdue).toBe(true);
    expect(actions[2].overdue).toBe(false);
    expect(actions[2].due).toBe(true);
  });

  it("combines startup follow-ups and referral next actions without duplicate records", () => {
    vi.stubEnv("TZ", "America/Guayaquil");
    const startup = {
      ...demoOpportunities(now).find((op) => op.kind === "startup")!,
    };
    startup.outreach = {
      ...outreachProgressFor(startup, "conversation"),
      nextAction: "Arrange a call",
      followUpOn: "2026-11-06",
    };
    const referral = job("referral", "saved");
    referral.application!.referralStatus = "to_ask";
    const actions = todayActions([referral, startup, startup], now);
    expect(actions).toHaveLength(2);
    expect(actions[0].nextAction).toBe("Arrange a call");
    expect(actions[1].label).toBe("Referral");
    expect(actions[1].nextAction).toContain("introduction");
  });

  it("uses local dates at UTC midnight and counts exact local calendar boundaries", () => {
    vi.stubEnv("TZ", "America/Guayaquil");
    expect(localDateKey(now)).toBe("2026-11-07");
    const first = job("first", "rejected");
    first.application!.appliedAt = "2026-11-01T05:00:00Z";
    first.application!.repliedAt = "2026-11-07T22:00:00Z";
    first.application!.interviewAt = "2026-11-02T14:00:00Z";
    first.application!.offerAt = "2026-11-08T03:00:00Z"; // Future milestone is not counted.
    first.stage = "archived";
    const old = job("old", "applied");
    old.application!.appliedAt = "2026-11-01T04:59:59Z";
    const startup = {
      ...demoOpportunities(now).find((op) => op.kind === "startup")!,
    };
    startup.outreach = {
      ...outreachProgressFor(startup, "closed", "opportunity"),
      conversationAt: "2026-11-04T12:00:00Z",
    };
    expect(recentMilestones([first, first, old, startup], now)).toEqual({
      submitted: 1,
      replies: 2,
      interviews: 1,
      offers: 0,
    });
  });

  it("retains a tracked application even when preferences or matching no longer recommend it", () => {
    const tracked = job("tracked", "saved");
    tracked.title = "Outside target roles";
    expect(
      selectedApplications([
        tracked,
        { ...tracked, id: "archive", stage: "archived" },
        base,
      ]).map((op) => op.id),
    ).toEqual(["tracked"]);
  });
});

describe("Today recommended shortlist", () => {
  it("prioritizes 0–7 and 8–14 day postings while keeping fit order inside each band", () => {
    vi.stubEnv("TZ", "America/Guayaquil");
    const workspace = demoWorkspace();
    const candidate = (id: string, ageDays: number | null): Opportunity => {
      const published = new Date(now);
      published.setDate(published.getDate() - (ageDays ?? 0));
      const opportunity: Opportunity = {
        ...base,
        id,
        company: id,
        publishedAt: ageDays === null ? null : published.toISOString(),
        sourceUpdatedAt: now.toISOString(),
      };
      opportunity.assessment = assessOpportunity(
        opportunity,
        workspace.profile,
        workspace.preferences,
        now,
      );
      return opportunity;
    };
    const undated = candidate("undated", null);
    const twoWeeks = candidate("fourteen-days", 14);
    const older = candidate("fifteen-days", 15);
    const recent = candidate("seven-days", 7);
    const secondRecent = candidate("today", 0);
    const secondWeek = candidate("eight-days", 8);
    const weakFresh = candidate("weak-fresh", 0);
    weakFresh.requirements = weakFresh.requirements.map((requirement) => ({
      ...requirement,
      skills: ["Rust"],
    }));
    weakFresh.assessment = assessOpportunity(
      weakFresh,
      workspace.profile,
      workspace.preferences,
      now,
    );
    const result = nextRecommendedJobs(
      [undated, weakFresh, twoWeeks, older, recent, secondRecent, secondWeek],
      workspace.preferences,
      10,
      now,
    );
    expect(result.map((op) => op.id)).toEqual([
      "seven-days",
      "today",
      "fourteen-days",
      "eight-days",
      "fifteen-days",
      "undated",
    ]);
    expect(postingRecency(recent, now)).toMatchObject({
      ageDays: 7,
      band: "recent",
    });
    expect(postingRecency(secondWeek, now)).toMatchObject({
      ageDays: 8,
      band: "two_weeks",
    });
    expect(postingRecency(twoWeeks, now)).toMatchObject({
      ageDays: 14,
      band: "two_weeks",
    });
    expect(postingRecency(older, now)).toMatchObject({
      ageDays: 15,
      band: "older",
    });
    expect(postingRecency(undated, now)).toMatchObject({
      ageDays: null,
      band: "unknown",
      label: expect.stringContaining("Posting date unknown · source updated"),
    });
  });

  it("uses local publication dates and never turns an update or future date into a fresh posting", () => {
    vi.stubEnv("TZ", "America/Guayaquil");
    expect(
      postingRecency({ publishedAt: "2026-11-07T04:00:00Z" }, now),
    ).toMatchObject({
      ageDays: 1,
      band: "recent",
      label: expect.stringContaining("Posted yesterday"),
    });
    expect(
      postingRecency(
        { publishedAt: null, sourceUpdatedAt: now.toISOString() },
        now,
      ).label,
    ).not.toContain("Posted today");
    expect(
      postingRecency({ publishedAt: "2026-11-10T12:00:00Z" }, now),
    ).toMatchObject({
      ageDays: null,
      band: "unknown",
      label: expect.stringContaining("in the future"),
    });
  });

  it("keeps a future timestamp in the unknown band even later on the same local day", () => {
    vi.stubEnv("TZ", "America/Guayaquil");
    const laterToday = new Date(now.getTime() + 60 * 60 * 1000);
    expect(localDateKey(laterToday)).toBe(localDateKey(now));
    expect(
      postingRecency({ publishedAt: laterToday.toISOString() }, now),
    ).toMatchObject({
      ageDays: null,
      band: "unknown",
      label: expect.stringContaining("in the future"),
    });
    expect(
      postingRecency({ publishedAt: now.toISOString() }, now),
    ).toMatchObject({
      ageDays: 0,
      band: "recent",
      label: expect.stringContaining("Posted today"),
    });
  });

  it("preserves full-collection production order and gives identical postings only one slot", () => {
    const workspace = demoWorkspace();
    const recommended = (id: string, company: string): Opportunity => {
      const candidate = { ...base, id, company };
      candidate.assessment = assessOpportunity(
        candidate,
        workspace.profile,
        workspace.preferences,
        now,
      );
      return candidate;
    };
    const first = recommended("first", "Same company");
    const copy = {
      ...first,
      id: "copy",
      url: "https://example.com/another-country",
    };
    const rest = Array.from({ length: 6 }, (_, index) =>
      recommended(`next-${index}`, `Company ${index}`),
    );
    const tracked = {
      ...first,
      id: "tracked",
      company: "Another tracked company",
      application: applicationProgressFor(first, "saved"),
    };
    const archive = { ...first, id: "archive", stage: "archived" as const };
    const result = nextRecommendedJobs(
      [tracked, archive, first, copy, ...rest],
      workspace.preferences,
    );
    expect(result.map((op) => op.id)).toEqual([
      "first",
      "next-0",
      "next-1",
      "next-2",
      "next-3",
    ]);
    expect(copy.application).toBeUndefined();
    expect(similarJobKey(first)).toBe(similarJobKey(copy));
    expect(similarJobKey(first)).not.toBe(
      similarJobKey({
        ...first,
        description: `${first.description} Different requirements.`,
      }),
    );
    expect(similarJobKey({ ...first, description: "" })).not.toBe(
      similarJobKey({ ...copy, description: "" }),
    );

    // Selecting the first regional posting must not surface its duplicate as
    // a new action on the next bootstrap refresh.
    const selected = {
      ...first,
      application: applicationProgressFor(first, "saved"),
    };
    const afterSelection = nextRecommendedJobs(
      [selected, copy, ...rest],
      workspace.preferences,
    );
    expect(afterSelection.map((op) => op.id)).toEqual([
      "next-0",
      "next-1",
      "next-2",
      "next-3",
      "next-4",
    ]);
    expect(copy.application).toBeUndefined();
  });
});
