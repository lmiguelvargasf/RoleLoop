import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutreachBoard } from "../src/ui/OutreachBoard";
import { OutreachProgress } from "../src/ui/OutreachProgress";
import { outreachProgressFor } from "../src/shared/outreach-board";
import { demoOpportunities } from "./fixtures";

const props = { busy: false, perform: async () => true, onSelect: () => {} };
const startup = () => demoOpportunities().find((op) => op.kind === "startup")!;

describe("startup outreach interface", () => {
  it("shows the four outreach stages but keeps discovery results out until explicitly selected", () => {
    const $ = load(
      renderToStaticMarkup(
        <OutreachBoard {...props} opportunities={demoOpportunities()} />,
      ),
    );
    expect(
      $(".application-column-heading h2")
        .map((_, node) => $(node).text())
        .get(),
    ).toEqual(["To contact", "Contacted", "In conversation", "Closed"]);
    expect($(".application-card")).toHaveLength(0);
    expect($("input")).toHaveLength(0);
    expect($.text()).toContain(
      "Add a company from Startup prospects to start in To contact.",
    );
  });

  it("keeps jobs and archives out, and preserves distinct closed outcomes", () => {
    const base = startup();
    const opportunities = [
      {
        ...base,
        id: "selected",
        company: "Selected startup",
        outreach: outreachProgressFor(base, "saved"),
      },
      {
        ...base,
        id: "opened",
        company: "New opportunity",
        outreach: outreachProgressFor(base, "closed", "opportunity"),
      },
      {
        ...base,
        id: "no-response",
        company: "Unanswered startup",
        outreach: outreachProgressFor(base, "closed", "no_response"),
      },
      {
        ...base,
        id: "archived",
        company: "Archived startup",
        stage: "archived" as const,
        outreach: outreachProgressFor(base, "contacted"),
      },
      {
        ...base,
        id: "job",
        kind: "job" as const,
        company: "Job company",
        outreach: outreachProgressFor(base, "saved"),
      },
    ];
    const $ = load(
      renderToStaticMarkup(
        <OutreachBoard {...props} opportunities={opportunities} />,
      ),
    );
    expect($(".application-card")).toHaveLength(3);
    expect($.text()).not.toContain("Archived startup");
    expect($.text()).not.toContain("Job company");
    expect($(".application-card-title").first().text()).toBe(
      "Selected startup",
    );
    expect(
      $(".application-outcome")
        .map((_, node) => $(node).text())
        .get(),
    ).toEqual(["Opportunity opened", "No response"]);
  });

  it("shows due follow-ups only for open outreach and keeps next steps on the card", () => {
    const base = startup();
    const opportunities = [
      {
        ...base,
        id: "waiting",
        outreach: {
          ...outreachProgressFor(base, "contacted"),
          followUpOn: "2000-01-01",
          nextAction: "Ask about the API team",
        },
      },
      {
        ...base,
        id: "closed",
        outreach: {
          ...outreachProgressFor(base, "closed", "withdrawn"),
          followUpOn: "2000-01-01",
        },
      },
    ];
    const $ = load(
      renderToStaticMarkup(
        <OutreachBoard {...props} opportunities={opportunities} />,
      ),
    );
    expect($(".application-due-filter span").text()).toBe("1");
    expect($(".application-follow-up")).toHaveLength(1);
    expect($(".application-next-action").text()).toBe("Ask about the API team");
    expect($("[aria-label='Search outreach']")).toHaveLength(1);
  });

  it("offers keyboard-accessible status and outcome editing with saved notes and milestones", () => {
    const base = startup();
    const opportunity = {
      ...base,
      outreach: {
        ...outreachProgressFor(base, "closed", "not_interested"),
        notes: "Reached Priya via email",
        nextAction: "Check back next quarter",
        contactedAt: "2026-11-01T12:00:00Z",
        conversationAt: "2026-11-02T12:00:00Z",
        closedAt: "2026-11-03T12:00:00Z",
      },
    };
    const $ = load(
      renderToStaticMarkup(
        <OutreachProgress {...props} opportunity={opportunity} />,
      ),
    );
    expect($("select")).toHaveLength(2);
    expect($("select").first().find("option[selected]").text()).toBe("Closed");
    expect($("select[required] option[selected]").text()).toBe(
      "Not interested",
    );
    expect($("textarea").text()).toBe("Reached Priya via email");
    expect($("input[maxLength=1000]").attr("value")).toBe(
      "Check back next quarter",
    );
    expect($(".outreach-milestones").text()).toContain("First contacted");
    expect($(".outreach-milestones").text()).toContain("Conversation started");
    expect($(".outreach-milestones").text()).toContain("First closed");
    expect($.text()).toContain("RoleLoop does not send it.");
  });
});
