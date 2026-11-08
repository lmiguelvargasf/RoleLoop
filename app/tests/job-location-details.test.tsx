import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JOB_RECOMMENDATION_RULES_VERSION } from "../src/shared/job-recommendations";
import { assessOpportunity } from "../src/domain/rules";
import {
  JobHiringLocation,
  JobLocationDetails,
  JobLocationPreview,
} from "../src/ui/JobLocationDetails";
import { demoOpportunities, demoWorkspace } from "./fixtures";

describe("job location details", () => {
  it("summarizes country lists in job rows and keeps the full list in details", () => {
    const location =
      "Remote: Argentina; Bonaire, Sint Eustatius and Saba; Brazil; Ecuador; United States";
    const $ = load(
      renderToStaticMarkup(
        <button>
          <JobLocationPreview location={location} />
        </button>,
      ),
    );
    expect($("button").text()).toBe("Remote · 5 listed locations");
    expect($("button").text()).not.toContain("Argentina");
    expect($("button").text()).not.toContain("worldwide");
    expect($("button details, button button")).toHaveLength(0);
    const details = load(
      renderToStaticMarkup(<JobLocationDetails location={location} />),
    );
    expect(details(".job-location-full").text()).toBe(location);
    expect(details(".job-location-count").text()).toBe("5 listed locations");
  });

  it.each([
    ["Remote · Ecuador", "Remote · Ecuador"],
    ["Quito, Ecuador", "Quito, Ecuador"],
    ["Remote worldwide", "Remote worldwide"],
    ["", "Location to confirm"],
    ["Quito; Cuenca; Guayaquil; Loja", "Location details · 4 listed locations"],
    ["Remote: Ecuador; Brazil; Mexico; United States; ;", "Remote · 4 listed locations"],
    [
      "Remote, with office access in Quito, Ecuador, subject to team arrangements and the specific project work schedule",
      "Remote · View full location",
    ],
  ])("shows a bounded row preview for %s", (location, expected) => {
    const $ = load(
      renderToStaticMarkup(<JobLocationPreview location={location} />),
    );
    expect($(".job-location-preview").text()).toBe(expected);
  });

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
    expect($(".job-country-eligibility > span").text()).toBe("Location matches the listing");
    expect($(".job-location-reason").text()).toContain(
      "The listing includes Ecuador",
    );
    expect($(".job-timezone-summary").text()).toBe("Mainland Ecuador time is included");
    expect($.text()).not.toContain("Galápagos");
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
    expect($(".job-country-eligibility > span").text()).toBe("Outside the listed hiring area");
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
    expect($(".job-country-eligibility > span").text()).toBe("Check with the employer");
    expect($.text()).not.toContain("The country is supported");
    expect($(".job-timezone-details").attr("open")).toBeUndefined();
    expect($(".job-timezone-details .job-location-full").text()).toBe(
      "UTC−05:00",
    );
    expect($(".job-country-eligibility > .job-location-reason").text()).not.toContain("UTC");
  });

  it.each([
    [[-5], "Mainland Ecuador time is included"],
    [[-6, -5], "Mainland Ecuador time is included"],
    [[-6], "Mainland Ecuador time is not listed"],
    [[0, 5.5, 5.75], "Mainland Ecuador time is not listed"],
    [
      [-11, -10, -9.5, -9, -8, -7, -6, -5, -4, -3.5, -3, -2, -1, 0, 1, 2, 3, 3.5, 4,
        4.5, 5, 5.5, 5.75, 6, 6.5, 7, 8, 8.75, 9, 9.5, 10, 10.5, 11, 12, 12.75, 13, 14],
      "No time-zone restriction listed",
    ],
  ])("summarizes source time zones %j using mainland Ecuador", (offsets, expected) => {
    const workspace = demoWorkspace();
    const job = { ...demoOpportunities()[0], sourceTimezoneRestrictions: offsets };
    job.assessment = assessOpportunity(job, workspace.profile, workspace.preferences);
    const $ = load(renderToStaticMarkup(
      <JobHiringLocation opportunity={job} preferences={workspace.preferences} />,
    ));
    expect($(".job-timezone-summary").text()).toBe(expected);
    expect($(".job-timezone-details summary").text()).toBe("View source time zones");
    expect($(".job-timezone-details").attr("open")).toBeUndefined();
    expect($.text()).not.toContain("Galápagos");
    expect($.text()).toContain("working hours");
    if (offsets.includes(5.75))
      expect($(".job-location-full").text()).toContain("UTC+05:45");
  });

  it("explains compatible location criteria without promising the employer can hire you", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.assessment = assessOpportunity(job, workspace.profile, workspace.preferences);
    const $ = load(renderToStaticMarkup(
      <JobHiringLocation opportunity={job} preferences={workspace.preferences} />,
    ));
    expect($(".job-country-eligibility > small").text()).toBe("Can I apply from Ecuador?");
    expect($(".job-country-eligibility > span").text()).toBe("Location matches the listing");
    expect($(".job-location-reason").text()).toContain("The listing includes Ecuador.");
    expect($(".job-location-reason").text()).toContain("Confirm the hiring arrangement");
    expect($(".job-timezone-requirements")).toHaveLength(0);
  });

  it("does not apply the mainland Ecuador summary to another working country", () => {
    const workspace = demoWorkspace();
    workspace.preferences.country = "Brazil";
    const job = { ...demoOpportunities()[0], sourceTimezoneRestrictions: [-5] };
    job.assessment = assessOpportunity(job, workspace.profile, workspace.preferences);
    const $ = load(renderToStaticMarkup(
      <JobHiringLocation opportunity={job} preferences={workspace.preferences} />,
    ));
    expect($(".job-country-eligibility > small").text()).toBe("Can I apply from Brazil?");
    expect($(".job-timezone-summary").text()).toBe("Confirm that your local time zone is included");
    expect($.text()).not.toContain("Ecuador");
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
      expect($(".job-country-eligibility > span").text()).toBe(
        "Check with the employer",
      );
      expect($(".job-location-reason").text()).toContain("not been checked");
    }
  });
});
