import { describe, expect, it } from "vitest";
import { assessOpportunity, orderOpportunities } from "../src/domain/rules.js";
import {
  isPotentialJobMatch,
  jobLocationStatus,
  needsLocationReview,
} from "../src/shared/job-matches.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import type { Opportunity } from "../src/shared/types.js";

function assessed(patch: Partial<Opportunity> = {}, country = "Ecuador") {
  const workspace = demoWorkspace();
  workspace.preferences.country = country;
  const job = { ...demoOpportunities()[0], ...patch };
  job.assessment = assessOpportunity(
    job,
    workspace.profile,
    workspace.preferences,
  );
  return { job, preferences: workspace.preferences };
}

describe("country-specific job shortlist", () => {
  it.each(["Bangalore", "Bengaluru, India", "Remote India", "APAC Remote"])(
    "keeps %s out of Ecuador matches even with a perfect skills score",
    (location) => {
      const { job, preferences } = assessed({
        location,
        description: "Build TypeScript and React applications.",
        remoteScope: "unknown",
      });
      expect(job.assessment?.essentialScore).toBe(100);
      expect(isPotentialJobMatch(job, preferences)).toBe(false);
      expect(jobLocationStatus(job, preferences)).not.toBe("eligible");
    },
  );

  it("keeps unspecified remote locations in review instead of treating remote as worldwide", () => {
    const { job, preferences } = assessed({
      location: "Remote",
      description: "Build software for our global customers.",
      remoteScope: "worldwide",
    });
    expect(isPotentialJobMatch(job, preferences)).toBe(false);
    expect(needsLocationReview(job, preferences)).toBe(true);
  });

  it.each(["Remote Ecuador", "Remote LATAM", "Remote worldwide"])(
    "retains %s and keeps non-location questions visible",
    (location) => {
      const { job, preferences } = assessed({
        location,
        description: "Build software remotely.",
        remoteScope: "unknown",
        salaryMin: null,
        salaryMax: null,
      });
      expect(isPotentialJobMatch(job, preferences)).toBe(true);
      expect(job.assessment?.recommendation).toBe("review");
      expect(needsLocationReview(job, preferences)).toBe(false);
    },
  );

  it("uses the selected working country rather than a country blacklist", () => {
    const { job, preferences } = assessed(
      {
        location: "Remote India",
        description: "Candidates must be based in India. Fully remote role.",
        remoteScope: "unknown",
      },
      "India",
    );
    expect(isPotentialJobMatch(job, preferences)).toBe(true);
    expect(
      isPotentialJobMatch(job, { ...preferences, country: "Ecuador" }),
    ).toBe(false);
    expect(
      needsLocationReview(job, { ...preferences, country: "Ecuador" }),
    ).toBe(true);
  });

  it("does not promote unevaluated or legacy records until their location is checked", () => {
    const { job, preferences } = assessed();
    job.assessment = null;
    expect(isPotentialJobMatch(job, preferences)).toBe(false);
    expect(needsLocationReview(job, preferences)).toBe(true);
  });

  it("preserves role, exclusion and archive filtering", () => {
    const { job, preferences } = assessed();
    expect(isPotentialJobMatch(job, preferences)).toBe(true);
    expect(
      isPotentialJobMatch({ ...job, stage: "archived" }, preferences),
    ).toBe(false);
    expect(
      isPotentialJobMatch({ ...job, title: "Civil Engineer" }, preferences),
    ).toBe(false);
    expect(
      isPotentialJobMatch(
        {
          ...job,
          assessment: { ...job.assessment!, recommendation: "excluded" },
        },
        preferences,
      ),
    ).toBe(false);
  });

  it("ranks a location-compatible review ahead of an unresolved high score", () => {
    const compatible = assessed({
      id: "compatible",
      salaryMin: null,
      salaryMax: null,
    });
    const unresolved = assessed({
      id: "unresolved",
      location: "Remote",
      description: "Build software.",
      remoteScope: "unknown",
    });
    compatible.job.assessment!.score = 40;
    unresolved.job.assessment!.score = 100;
    expect(
      orderOpportunities(
        [unresolved.job, compatible.job],
        compatible.preferences,
      )[0].id,
    ).toBe("compatible");
  });
});
