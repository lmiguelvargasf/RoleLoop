import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import {
  startupIndustries,
  startupSummary,
} from "../src/shared/startup-company";
import {
  StartupCompanyOverview,
  StartupContributionPreview,
} from "../src/ui/StartupCompanyProfile";
import { demoOpportunities, demoWorkspace } from "./fixtures";
import { assessOpportunity } from "../src/domain/rules";

const base = demoOpportunities()[3];
describe("startup company information", () => {
  it("shows the product introduction without appending the scraped navigation or repeating page body", () => {
    const op = {
      ...base,
      description:
        "A TypeScript framework for building content APIs.\n\nHome Login Pricing ## A TypeScript framework for building content APIs.",
    };
    expect(startupSummary(op)).toBe(
      "A TypeScript framework for building content APIs.",
    );
    expect(startupIndustries(op)).toEqual({
      labels: ["Developer tools"],
      listed: false,
    });
    const $ = load(
      renderToStaticMarkup(<StartupCompanyOverview opportunity={op} />),
    );
    expect($(".startup-product-summary").text()).toBe(startupSummary(op));
    expect($.text()).not.toContain("Home Login Pricing");
    expect($("h3").first().text()).toBe("What they do");
  });
  it("uses source-listed sectors over keyword guesses and labels inferred sectors separately", () => {
    const op = {
      ...base,
      title: "Artificial intelligence for clinics",
      description: "Machine learning for healthcare teams",
      signals: ["Seedcamp sector: Health", "Seedcamp sector: Health"],
    };
    expect(startupIndustries(op)).toEqual({ labels: ["Health"], listed: true });
    const inferred = { ...op, signals: [] };
    expect(startupIndustries(inferred)).toEqual({
      labels: ["AI", "Healthcare"],
      listed: false,
    });
    expect(
      renderToStaticMarkup(<StartupCompanyOverview opportunity={inferred} />),
    ).toContain("Industry signals");
    expect(
      startupIndustries({
        ...op,
        title: "Example",
        description: "A new product",
        signals: [],
      }).labels,
    ).toEqual([]);
  });
  it("bounds long source text without making up a summary", () => {
    const op = { ...base, description: "A product for teams. ".repeat(100) };
    const summary = startupSummary(op);
    expect(summary.length).toBeLessThanOrEqual(601);
    expect(summary.endsWith("…")).toBe(true);
    expect(op.description.startsWith(summary.slice(0, -1))).toBe(true);
  });
  it("shows a contribution on rows only while all cited CV work remains current and verified", () => {
    const workspace = demoWorkspace();
    const op = {
      ...base,
      assessment: {
        ...assessOpportunity(base, workspace.profile, workspace.preferences),
        fitSummary:
          "Your React work could help improve the collaborative editor.",
        relevantEvidenceIds: ["demo-e1"],
        startupFit: {
          method: "semantic" as const,
          status: "potential" as const,
        },
      },
    };
    const render = () =>
      renderToStaticMarkup(
        <StartupContributionPreview
          opportunity={op}
          profile={workspace.profile}
        />,
      );
    expect(render()).toContain("collaborative editor");
    workspace.profile.cache!.facts!.evidence[0].verified = false;
    expect(render()).toBe("");
    workspace.profile.cache = null;
    expect(render()).toBe("");
  });
});
