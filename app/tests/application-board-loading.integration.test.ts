import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import { applicationProgressFor } from "../src/shared/application-board.js";
import { OpportunitySchema, type Opportunity } from "../src/shared/types.js";
import { demoWorkspace } from "./fixtures.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("application board loading", () => {
  it("loads all tracked jobs beyond the discovery window without scanning or reassessing untracked history", async () => {
    const { db, createWorkspaceStore } = await import("../src/server/store.js");
    const { bootstrap } = await import("../src/server/service.js");
    const workspaceId = `application-loading-${randomUUID()}`;
    const otherWorkspaceId = `application-loading-other-${randomUUID()}`;
    const workspace = demoWorkspace();
    workspace.sources = [];
    const created = await db.from("workspace").insert([
      { id: workspaceId, payload: workspace },
      { id: otherWorkspaceId, payload: workspace },
    ]);
    expect(created.error).toBeNull();
    const store = createWorkspaceStore({ workspaceId, client: db });
    const save = vi.spyOn(store, "save");
    const job = (updatedAt: string): Opportunity => {
      const id = randomUUID();
      return OpportunitySchema.parse({
        id,
        kind: "job",
        source: "Isolated board loading test",
        sourceKey: `board-loading:${id}`,
        company: "Example employer",
        title: "Software Engineer",
        url: "https://example.com/job",
        description: "An isolated fixture.",
        firstSeenAt: updatedAt,
        updatedAt,
      });
    };
    const recent = Array.from({ length: 301 }, () =>
      job("2026-11-07T12:00:00.000Z"),
    );
    // Overlap in the two queries must not duplicate an application card.
    recent[0].application = applicationProgressFor(recent[0], "applied");
    const olderTracked = Array.from({ length: 501 }, () => {
      const opportunity = job("2026-10-01T12:00:00.000Z");
      opportunity.application = applicationProgressFor(opportunity, "saved");
      return opportunity;
    });
    olderTracked[0].stage = "archived";
    const oldUntracked = job("2026-09-01T12:00:00.000Z");
    oldUntracked.assessment = {
      ...assessOpportunity(
        oldUntracked,
        workspace.profile,
        workspace.preferences,
      ),
      rulesVersion: 0,
    };
    const otherTracked = job("2026-08-01T12:00:00.000Z");
    otherTracked.application = applicationProgressFor(
      otherTracked,
      "interview",
    );
    const row = (opportunity: Opportunity, scope = workspaceId) => ({
      id: opportunity.id,
      workspace_id: scope,
      kind: opportunity.kind,
      source_key: opportunity.sourceKey,
      payload: opportunity,
      updated_at: opportunity.updatedAt,
    });
    try {
      const inserted = await db
        .from("opportunities")
        .insert([
          ...recent.map((op) => row(op)),
          ...olderTracked.map((op) => row(op)),
          row(oldUntracked),
          row(otherTracked, otherWorkspaceId),
        ]);
      expect(inserted.error).toBeNull();
      const tracked = await store.listTrackedApplications();
      expect(tracked).toHaveLength(502);
      expect(tracked.some((op) => op.id === otherTracked.id)).toBe(false);
      const result = await bootstrap(store);
      const loaded = new Set(result.opportunities.map((op) => op.id));
      expect(loaded.size).toBe(result.opportunities.length);
      for (const tracked of olderTracked)
        expect(loaded.has(tracked.id)).toBe(true);
      expect(loaded.has(recent[0].id)).toBe(true);
      expect(loaded.has(oldUntracked.id)).toBe(false);
      expect(loaded.has(otherTracked.id)).toBe(false);
      expect(
        recent.filter((op) => loaded.has(op.id)).length,
      ).toBeGreaterThanOrEqual(300);
      expect(
        recent.filter((op) => loaded.has(op.id)).length,
      ).toBeLessThanOrEqual(301);
      expect(save).not.toHaveBeenCalled();
      expect(
        (await store.get("opportunities", oldUntracked.id)).assessment
          ?.rulesVersion,
      ).toBe(0);
      expect(
        result.opportunities.find((op) => op.id === olderTracked[1].id)
          ?.application,
      ).toEqual(olderTracked[1].application);
    } finally {
      save.mockRestore();
      for (const table of [
        "drafts",
        "runs",
        "events",
        "opportunities",
        "workspace_runtime",
      ]) {
        const removed = await db
          .from(table)
          .delete()
          .in("workspace_id", [workspaceId, otherWorkspaceId]);
        expect(removed.error).toBeNull();
      }
      const removed = await db
        .from("workspace")
        .delete()
        .in("id", [workspaceId, otherWorkspaceId]);
      expect(removed.error).toBeNull();
    }
  });
});
