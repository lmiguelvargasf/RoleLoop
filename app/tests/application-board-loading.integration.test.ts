import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ASSESSMENT_RULES_VERSION,
  assessOpportunity,
} from "../src/domain/rules.js";
import { REQUIREMENT_EXTRACTION_VERSION } from "../src/domain/connectors.js";
import { applicationProgressFor } from "../src/shared/application-board.js";
import { OpportunitySchema, type Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("application board loading", () => {
  it("ranks the full saved collection before pagination and refreshes an older strong candidate only once", async () => {
    const { db, createWorkspaceStore } = await import("../src/server/store.js");
    const { bootstrap } = await import("../src/server/service.js");
    const workspaceId = `application-loading-${randomUUID()}`;
    const otherWorkspaceId = `application-loading-other-${randomUUID()}`;
    let workspace = demoWorkspace();
    workspace.sources = [];
    const created = await db.from("workspace").insert([
      { id: workspaceId, payload: workspace },
      { id: otherWorkspaceId, payload: workspace },
    ]);
    expect(created.error).toBeNull();
    const store = createWorkspaceStore({ workspaceId, client: db });
    workspace = await store.getWorkspace();
    const save = vi.spyOn(store, "saveDerivedOpportunity");
    const job = (updatedAt: string): Opportunity => {
      const id = randomUUID();
      const op = OpportunitySchema.parse({
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
        requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
      });
      op.assessment = assessOpportunity(
        op,
        workspace.profile,
        workspace.preferences,
      );
      return op;
    };
    const recent = Array.from({ length: 301 }, () =>
      job("2026-11-07T12:00:00.000Z"),
    );
    // Both discovery records and existing applications belong in the collection.
    recent[0].application = applicationProgressFor(recent[0], "applied");
    const olderTracked = Array.from({ length: 201 }, () => {
      const opportunity = job("2026-10-01T12:00:00.000Z");
      opportunity.application = applicationProgressFor(opportunity, "saved");
      return opportunity;
    });
    olderTracked[0].stage = "archived";
    const oldUntracked = {
      ...demoOpportunities()[0],
      id: randomUUID(),
      sourceKey: `old-strong:${randomUUID()}`,
      firstSeenAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    };
    const startup = {
      ...job("2026-09-01T12:00:00.000Z"),
      kind: "startup" as const,
    };
    startup.assessment = assessOpportunity(
      startup,
      workspace.profile,
      workspace.preferences,
    );
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
          row(startup),
          row(otherTracked, otherWorkspaceId),
        ]);
      expect(inserted.error).toBeNull();
      const tracked = await store.listTrackedApplications();
      expect(tracked).toHaveLength(202);
      expect(tracked.some((op) => op.id === otherTracked.id)).toBe(false);
      const result = await bootstrap(store);
      const loaded = new Set(result.opportunities.map((op) => op.id));
      expect(loaded.size).toBe(result.opportunities.length);
      for (const tracked of olderTracked)
        expect(loaded.has(tracked.id)).toBe(true);
      expect(loaded.has(recent[0].id)).toBe(true);
      expect(loaded.has(oldUntracked.id)).toBe(true);
      expect(loaded.has(startup.id)).toBe(true);
      expect(result.opportunities.filter((op) => op.kind === "job")[0].id).toBe(
        oldUntracked.id,
      );
      expect(loaded.size).toBe(504);
      expect(loaded.has(otherTracked.id)).toBe(false);
      expect(recent.filter((op) => loaded.has(op.id))).toHaveLength(301);
      expect(save).toHaveBeenCalledTimes(1);
      const refreshed = await store.get("opportunities", oldUntracked.id);
      expect(refreshed.assessment?.rulesVersion).toBe(ASSESSMENT_RULES_VERSION);
      expect(refreshed.requirementsVersion).toBe(
        REQUIREMENT_EXTRACTION_VERSION,
      );
      save.mockClear();
      const again = await bootstrap(store);
      expect(again.opportunities).toHaveLength(504);
      expect(save).not.toHaveBeenCalled();
      expect(
        (await store.get("opportunities", oldUntracked.id)).assessment
          ?.evaluatedAt,
      ).toBe(refreshed.assessment?.evaluatedAt);
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
