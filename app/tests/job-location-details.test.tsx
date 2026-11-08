import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JOB_RECOMMENDATION_RULES_VERSION } from "../src/shared/job-recommendations";
import { assessOpportunity } from "../src/domain/rules";
import {
  JobHiringLocation,
  JobLocationDetails,
} from "../src/ui/JobLocationDetails";
import { demoOpportunities, demoWorkspace } from "./fixtures";

describe("job location details", () => {
  it("collapses long country lists without dropping or rewriting source text", () => {
    const location =
      "Remote: Argentina; Bonaire, Sint Eustatius and Saba; Brazil; Ecuador; United States";
    const $ = load(
      renderToStaticMarkup(<JobLocationDetails location={location} />),
    );
    expect($("details").attr("open")).toBeUndefined();
    expect($("summary").text()).toBe("Remote5 listed locations");
    expect($("summary").text()).not.toContain("worldwide");
    expect($(".job-location-full").text()).toBe(location);
    expect($(".job-location-full").attr("tabindex")).toBe("0");
  });

  it.each([
    "Remote · Ecuador",
    "Quito, Ecuador",
    "Remote worldwide",
    "Unknown",
  ])("leaves a short location visible: %s", (location) => {
    const $ = load(
      renderToStaticMarkup(<JobLocationDetails location={location} />),
    );
    expect($("details")).toHaveLength(0);
    expect($(".job-location > span").text()).toBe(location);
  });

  it("does not count commas in long unstructured text as separate locations", () => {
    const location =
      "Remote, with office access in Quito, Ecuador, subject to team arrangements and the specific project work schedule";
    const $ = load(
      renderToStaticMarkup(<JobLocationDetails location={location} />),
    );
    expect($("summary").text()).toContain("View full location");
    expect($("summary").text()).not.toMatch(/\d+ listed/);
  });

  it("explains a timezone check separately from supported country coverage", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.location = "Remote: Brazil; Ecuador; Mexico; United States";
    job.description =
      "This position is available for candidates based in EMEA, LATAM or North America.";
    job.sourceTimezoneRestrictions = [-5];
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    const $ = load(
      renderToStaticMarkup(
        <JobHiringLocation
          opportunity={job}
          preferences={workspace.preferences}
        />,
      ),
    );
    expect($(".job-hiring-location > span").text()).toBe("Confirm time zone");
    expect($(".job-location-reason").text()).toContain(
      "The country is supported",
    );
    expect($.text()).not.toContain("Country-specific work authorization");
  });

  it("keeps exclusions visible even when the feed lists Ecuador", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.location = "Remote: Ecuador; Brazil; United States; Mexico";
    job.description = "We can only hire in the United States.";
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    const $ = load(
      renderToStaticMarkup(
        <JobHiringLocation
          opportunity={job}
          preferences={workspace.preferences}
        />,
      ),
    );
    expect($(".job-hiring-location > span").text()).toBe("Outside hiring area");
    expect($(".job-location-reason").text()).toContain("United States");
    expect($.text()).not.toContain("The country is supported");
  });

  it("does not treat a timezone restriction alone as evidence of supported country coverage", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.location = "Remote";
    job.description = "Build software.";
    job.remoteScope = "unknown";
    job.sourceTimezoneRestrictions = [-5];
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    const $ = load(
      renderToStaticMarkup(
        <JobHiringLocation
          opportunity={job}
          preferences={workspace.preferences}
        />,
      ),
    );
    expect($(".job-hiring-location > span").text()).toBe("Needs confirmation");
    expect($.text()).not.toContain("The country is supported");
    expect($(".job-timezone-details").attr("open")).toBeUndefined();
    expect($(".job-timezone-details .job-location-full").text()).toBe(
      "UTC−05:00",
    );
  });

  it("does not present a stale or differently scoped assessment as current eligibility", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    for (const patch of [
      { rulesVersion: JOB_RECOMMENDATION_RULES_VERSION - 1 },
      {
        rulesVersion: JOB_RECOMMENDATION_RULES_VERSION,
        geography: {
          status: "eligible" as const,
          reasons: [],
          workingCountry: "Brazil",
        },
      },
    ]) {
      const $ = load(
        renderToStaticMarkup(
          <JobHiringLocation
            opportunity={{
              ...job,
              assessment: { ...job.assessment, ...patch },
            }}
            preferences={workspace.preferences}
          />,
        ),
      );
      expect($(".job-hiring-location > span").text()).toBe(
        "Needs confirmation",
      );
      expect($(".job-location-reason").text()).toContain("not been checked");
    }
  });
});
