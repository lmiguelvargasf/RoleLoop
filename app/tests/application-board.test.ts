import { describe, expect, it } from "vitest";
import {
  applicationColumn,
  applicationProgressFor,
  isTrackedApplication,
  type ApplicationStatus,
} from "../src/shared/application-board.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { OpportunitySchema } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const job = () => demoOpportunities()[0];

describe("application board membership and moves", () => {
  it("keeps discovered jobs off the board until explicitly selected", () => {
    const discovered = job();
    expect(discovered.application).toBeUndefined();
    expect(isTrackedApplication(discovered)).toBe(false);
    expect(applicationColumn(discovered)).toBeNull();

    const tracked = {
      ...discovered,
      application: applicationProgressFor(discovered, "saved"),
    };
    expect(isTrackedApplication(tracked)).toBe(true);
    expect(applicationColumn(tracked)).toBe("to_apply");
    expect(tracked.application.appliedAt).toBeNull();
    expect(tracked.application.interviewAt).toBeNull();
    expect(tracked.application.offerAt).toBeNull();
    expect(() => OpportunitySchema.parse(tracked)).not.toThrow();
  });

  it.each([
    ["saved", "to_apply"],
    ["applied", "applied"],
    ["interview", "interview"],
    ["offer", "offer"],
    ["rejected", "closed"],
    ["withdrawn", "closed"],
  ] as const)(
    "places %s in %s without losing the outcome",
    (status, column) => {
      const tracked = {
        ...job(),
        application: applicationProgressFor(job(), status),
      };
      expect(applicationColumn(tracked)).toBe(column);
      expect(tracked.application.status).toBe(status);
    },
  );

  it("retains archived tracking history without placing archives on the board", () => {
    const tracked = {
      ...job(),
      stage: "archived" as const,
      application: applicationProgressFor(job(), "interview"),
    };
    expect(isTrackedApplication(tracked)).toBe(true);
    expect(applicationColumn(tracked)).toBeNull();
    expect(applicationColumn({ ...tracked, stage: "new" })).toBe("interview");
  });

  it("never includes startup prospects", () => {
    const startup = {
      ...job(),
      kind: "startup" as const,
      application: applicationProgressFor(job(), "saved"),
    };
    expect(isTrackedApplication(startup)).toBe(false);
    expect(applicationColumn(startup)).toBeNull();
  });

  it("retains a tracked job even when current country and role preferences exclude it", () => {
    const workspace = demoWorkspace();
    const tracked = {
      ...job(),
      title: "Civil Engineer",
      location: "Bangalore, India",
      description: "Candidates must work onsite in Bangalore, India.",
      application: applicationProgressFor(job(), "saved"),
    };
    tracked.assessment = assessOpportunity(
      tracked,
      workspace.profile,
      workspace.preferences,
    );
    expect(tracked.assessment.recommendation).toBe("excluded");
    expect(applicationColumn(tracked)).toBe("to_apply");
  });

  it("preserves every milestone and user field when reopening or moving a job", () => {
    const tracked = {
      ...job(),
      application: {
        status: "offer" as const,
        appliedAt: "2026-11-01T12:00:00.000Z",
        interviewAt: "2026-11-03T12:00:00.000Z",
        offerAt: "2026-11-06T12:00:00.000Z",
        followUpOn: "2026-11-10",
        nextAction: "Discuss compensation",
        notes: "Recruiter call at 10am",
      },
    };
    for (const status of [
      "rejected",
      "withdrawn",
      "saved",
      "interview",
    ] as ApplicationStatus[]) {
      const moved = applicationProgressFor(tracked, status);
      expect(moved).toEqual({ ...tracked.application, status });
      expect(moved).not.toBe(tracked.application);
    }
    expect(tracked.application.status).toBe("offer");
  });
});
