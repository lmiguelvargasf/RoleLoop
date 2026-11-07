import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutreachPreparation } from "../src/ui/OutreachPreparation";
import { outreachProgressFor } from "../src/shared/outreach-board";
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
const startup = () => {
  const op = demoOpportunities().find((item) => item.kind === "startup")!;
  return { ...op, outreach: outreachProgressFor(op, "saved") };
};
const task = (opportunityId: string, status: Run["status"]): Run => ({
  id: "outreach-run",
  action: "draft",
  opportunityId,
  status,
  progress: 0,
  message: "Task state",
  createdAt: "2026-11-07T12:00:00Z",
  updatedAt: "2026-11-07T12:01:00Z",
});

describe("explicit outreach preparation", () => {
  it("prepares drafts only from active To contact startups", () => {
    const op = startup();
    expect(
      renderToStaticMarkup(<OutreachPreparation {...props} opportunity={op} />),
    ).toContain("Prepare outreach");
    for (const opportunity of [
      { ...op, outreach: undefined },
      { ...op, stage: "archived" as const },
      { ...op, kind: "job" as const },
      ...(["contacted", "conversation", "closed"] as const).map((status) => ({
        ...op,
        outreach: outreachProgressFor(op, status),
      })),
    ])
      expect(
        renderToStaticMarkup(
          <OutreachPreparation {...props} opportunity={opportunity} />,
        ),
      ).toBe("");
  });

  it.each(["queued", "running"] as const)(
    "shows %s preparation without a duplicate action",
    (status) => {
      const op = startup();
      const $ = load(
        renderToStaticMarkup(
          <OutreachPreparation
            {...props}
            opportunity={op}
            runs={[task(op.id, status)]}
          />,
        ),
      );
      expect($("[role=status]").text()).toContain("Preparing outreach");
      expect($("button")).toHaveLength(0);
    },
  );

  it("keeps drafts reviewable after contact without offering a new preparation", () => {
    const op = startup(),
      workspace = demoWorkspace();
    const draft = createDraft(
      op,
      workspace.profile,
      workspace.preferences,
      assessOpportunity(op, workspace.profile, workspace.preferences),
    );
    const $ = load(
      renderToStaticMarkup(
        <OutreachPreparation
          {...props}
          opportunity={{
            ...op,
            outreach: outreachProgressFor(op, "contacted"),
          }}
          drafts={[draft]}
        />,
      ),
    );
    expect($("a").text()).toBe("Review outreach");
    expect($("a").attr("href")).toBe(`#drafts?opportunity=${op.id}`);
    expect($("button")).toHaveLength(0);
  });

  it("offers retry after failure and routes excluded companies to their findings", () => {
    const op = startup(),
      workspace = demoWorkspace();
    const failed = renderToStaticMarkup(
      <OutreachPreparation
        {...props}
        opportunity={op}
        runs={[task(op.id, "failed")]}
      />,
    );
    expect(failed).toContain("Retry preparation");
    expect(failed).toContain("View error");
    const excluded = renderToStaticMarkup(
      <OutreachPreparation
        {...props}
        opportunity={{
          ...op,
          assessment: {
            ...assessOpportunity(op, workspace.profile, workspace.preferences),
            recommendation: "excluded",
          },
        }}
      />,
    );
    expect(excluded).toContain("Review fit before preparing");
    expect(excluded).not.toContain("Prepare outreach");
  });
});
