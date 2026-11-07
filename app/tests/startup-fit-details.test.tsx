import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assessOpportunity } from "../src/domain/rules";
import { StartupFitDetails } from "../src/ui/StartupFitDetails";
import { demoOpportunities, demoWorkspace } from "./fixtures";

function setup() {
  const workspace = demoWorkspace();
  const opportunity = demoOpportunities()[3];
  opportunity.assessment = {
    ...assessOpportunity(opportunity, workspace.profile, workspace.preferences),
    score: 80,
    startupFit: { method: "semantic", status: "potential" },
    relevantEvidenceIds: ["demo-e1"],
    fitSummary:
      "Your interface delivery work could help build this collaboration product. Confirm the team's needs.",
  };
  const render = () =>
    load(
      renderToStaticMarkup(
        <StartupFitDetails
          opportunity={opportunity}
          profile={workspace.profile}
        />,
      ),
    );
  return { workspace, opportunity, render };
}

describe("startup contribution details", () => {
  it("shows a supported contribution with only cited and verified current CV examples", () => {
    const { workspace, opportunity, render } = setup();
    workspace.profile.cache!.facts!.evidence.push({
      ...workspace.profile.cache!.facts!.evidence[0],
      id: "unverified",
      text: "Unverified candidate claim",
      verified: false,
    });
    const $ = render();
    expect($("h3").text()).toBe("How you could contribute");
    expect($("section > p").first().text()).toBe(
      opportunity.assessment!.fitSummary,
    );
    expect($("summary").text()).toBe("Supporting CV experience · 1");
    expect($("details").attr("open")).toBeUndefined();
    expect($("li")).toHaveLength(1);
    expect($("li").text()).toContain(
      workspace.profile.cache!.facts!.evidence[0].text,
    );
    expect($("li").text()).toContain("Software engineer · Example Studio");
    expect($("section").text()).not.toContain(
      workspace.profile.cache!.facts!.evidence[1].text,
    );
    expect($("section").text()).not.toContain("Unverified candidate claim");
    expect($("section").text()).not.toContain("80%");
    expect($(".score, .match-number, .match-track")).toHaveLength(0);
  });

  it("presents skill-signal fallback as a connection to explore without a fit percentage", () => {
    const { opportunity, render } = setup();
    opportunity.assessment!.startupFit = {
      method: "signals",
      status: "unconfirmed",
    };
    opportunity.assessment!.fitSummary =
      "TypeScript appears in the company description and your CV work. Confirm how that experience relates to the product.";
    const $ = render();
    expect($("h3").text()).toBe("Connection to explore");
    expect($("section > p").first().text()).toBe(
      opportunity.assessment!.fitSummary,
    );
    expect($("li")).toHaveLength(1);
    expect($("section").text()).not.toContain("80%");
    expect($("small").text()).toContain("needs a conversation");
  });

  it("keeps contribution service failures visible", () => {
    const { opportunity, render } = setup();
    opportunity.assessment!.startupFit = {
      method: "signals",
      status: "unconfirmed",
      failureReason:
        "Reconnect ChatGPT under Account to evaluate your contribution.",
    };
    const $ = render();
    expect($("h3").text()).toBe("Connection to explore");
    expect($(".match-note").text()).toBe(
      opportunity.assessment!.startupFit.failureReason,
    );
    expect($(".match-note").parents("details")).toHaveLength(0);
  });

  it.each(["missing", "processing", "older extractor", "different source"])(
    "hides evidence and unsupported semantic prose when the CV cache is %s",
    (state) => {
      const { workspace, opportunity, render } = setup();
      const oldSummary = opportunity.assessment!.fitSummary!;
      if (state === "missing") workspace.profile.cache = null;
      else if (state === "processing")
        workspace.profile.cache!.status = "processing";
      else if (state === "older extractor")
        workspace.profile.cache!.extractorVersion = 0;
      else
        workspace.profile.cache!.sourceId =
          "33333333-3333-4333-8333-333333333333";
      const $ = render();
      expect($("h3").text()).toBe("Connection to explore");
      expect($("details, li")).toHaveLength(0);
      expect($("section").text()).not.toContain(oldSummary);
      expect($("section > p").first().text()).toMatch(
        /research|re-evaluate|evaluate/i,
      );
    },
  );

  it.each(["missing", "unverified"])(
    "does not treat a partially supported semantic summary as established when a cited example is %s",
    (state) => {
      const { workspace, opportunity, render } = setup();
      opportunity.assessment!.relevantEvidenceIds = ["demo-e1", "demo-e2"];
      const oldSummary = opportunity.assessment!.fitSummary!;
      if (state === "missing")
        workspace.profile.cache!.facts!.evidence =
          workspace.profile.cache!.facts!.evidence.filter(
            (fact) => fact.id !== "demo-e2",
          );
      else
        workspace.profile.cache!.facts!.evidence.find(
          (fact) => fact.id === "demo-e2",
        )!.verified = false;
      const $ = render();
      expect($("h3").text()).toBe("Connection to explore");
      expect($("section").text()).not.toContain(oldSummary);
      expect($("li").text()).not.toContain("PostgreSQL data models");
    },
  );

  it("gives an action when no assessment exists", () => {
    const { opportunity, render } = setup();
    opportunity.assessment = null;
    const $ = render();
    expect($("h3").text()).toBe("Connection to explore");
    expect($("section > p").first().text()).toContain("Research this company");
    expect($("details")).toHaveLength(0);
  });
});
