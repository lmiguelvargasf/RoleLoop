import { describe, expect, it } from "vitest";
import {
  outreachColumn,
  outreachFollowUpDue,
  outreachProgressFor,
  isTrackedOutreach,
} from "../src/shared/outreach-board.js";
import { demoOpportunities } from "./fixtures.js";

describe("outreach board membership", () => {
  it("requires explicit startup tracking, with archives retained but hidden", () => {
    const startup = demoOpportunities()[3];
    expect(outreachColumn(startup)).toBeNull();
    startup.outreach = outreachProgressFor(startup, "saved");
    expect(outreachColumn(startup)).toBe("to_contact");
    expect(outreachColumn({ ...startup, kind: "job" })).toBeNull();
    startup.stage = "archived";
    expect(outreachColumn(startup)).toBeNull();
    expect(isTrackedOutreach(startup)).toBe(true);
  });
  it("preserves milestone history, follow-up and notes across moves", () => {
    const startup = demoOpportunities()[3];
    startup.outreach = {
      ...outreachProgressFor(startup, "contacted"),
      contactedAt: "2026-11-07T12:00:00Z",
      nextAction: "Follow up",
      followUpOn: "2026-11-08",
      notes: "Met the team",
    };
    expect(outreachProgressFor(startup, "closed", "opportunity")).toEqual({
      ...startup.outreach,
      status: "closed",
      outcome: "opportunity",
    });
    expect(outreachFollowUpDue(startup, "2026-11-08")).toBe(true);
    expect(outreachFollowUpDue(startup, "2026-11-07")).toBe(false);
    expect(
      outreachFollowUpDue(
        {
          ...startup,
          outreach: outreachProgressFor(startup, "closed", "opportunity"),
        },
        "2026-11-08",
      ),
    ).toBe(false);
  });
});
