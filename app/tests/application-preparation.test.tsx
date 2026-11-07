import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationPreparation } from "../src/ui/ApplicationPreparation";
import { applicationProgressFor } from "../src/shared/application-board";
import { assessOpportunity } from "../src/domain/rules";
import { createDraft } from "../src/domain/templates";
import type { Run } from "../src/shared/types";
import { demoOpportunities, demoWorkspace } from "./fixtures";

const props = {
  busy: false,
  perform: async () => true,
  onReviewFit: () => {},
  drafts: [],
  runs: [],
};
const job = () => {
  const op = demoOpportunities()[0];
  return { ...op, application: applicationProgressFor(op, "saved") };
};
const task = (opportunityId: string, status: Run["status"]): Run => ({
  id: "preparation-run",
  action: "draft",
  opportunityId,
  status,
  progress: 0,
  message: "Task state",
  createdAt: "2026-11-07T12:00:00Z",
  updatedAt: "2026-11-07T12:01:00Z",
});

describe("application preparation on the board", () => {
  it("offers preparation only for active To apply jobs", () => {
    const op = job();
    expect(
      renderToStaticMarkup(
        <ApplicationPreparation {...props} opportunity={op} />,
      ),
    ).toContain("Prepare application");
    for (const opportunity of [
      { ...op, application: undefined },
      { ...op, stage: "archived" as const },
      { ...op, application: applicationProgressFor(op, "applied") },
      { ...op, application: applicationProgressFor(op, "interview") },
      { ...op, application: applicationProgressFor(op, "offer") },
      { ...op, application: applicationProgressFor(op, "rejected") },
      { ...op, kind: "startup" as const },
    ])
      expect(
        renderToStaticMarkup(
          <ApplicationPreparation {...props} opportunity={opportunity} />,
        ),
      ).toBe("");
  });

  it.each(["queued", "running"] as const)(
    "shows %s work without a duplicate preparation control",
    (status) => {
      const op = job();
      const $ = load(
        renderToStaticMarkup(
          <ApplicationPreparation
            {...props}
            opportunity={op}
            runs={[task(op.id, status)]}
          />,
        ),
      );
      expect($("[role=status]").text()).toContain("Preparing application");
      expect($("button")).toHaveLength(0);
    },
  );

  it("opens the job's existing documents without silently preparing another package", () => {
    const op = job(),
      workspace = demoWorkspace();
    const draft = createDraft(
      op,
      workspace.profile,
      workspace.preferences,
      assessOpportunity(op, workspace.profile, workspace.preferences),
    );
    const $ = load(
      renderToStaticMarkup(
        <ApplicationPreparation {...props} opportunity={op} drafts={[draft]} />,
      ),
    );
    expect($("a").text()).toBe("Review application");
    expect($("a").attr("href")).toBe(`#drafts?opportunity=${op.id}`);
    expect($("button").attr("aria-label")).toBe("Prepare application again");
  });

  it("offers a retry after a failure and keeps fit exclusions actionable", () => {
    const op = job(),
      workspace = demoWorkspace();
    const failed = renderToStaticMarkup(
      <ApplicationPreparation
        {...props}
        opportunity={op}
        runs={[task(op.id, "failed")]}
      />,
    );
    expect(failed).toContain("Retry preparation");
    expect(failed).toContain("View error");
    op.assessment = {
      ...assessOpportunity(op, workspace.profile, workspace.preferences),
      recommendation: "excluded",
    };
    const excluded = renderToStaticMarkup(
      <ApplicationPreparation {...props} opportunity={op} />,
    );
    expect(excluded).toContain("Review fit before preparing");
    expect(excluded).not.toContain("Prepare application");
  });
});
