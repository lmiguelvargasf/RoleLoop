import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoWorkspace } from "./fixtures.js";
import type { Run } from "../src/shared/types.js";

const integration = process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
afterEach(() => vi.restoreAllMocks());

integration("Himalayas persisted discovery cursors", () => {
  it("persists and reloads both cursor objects through the real workspace-runtime constraints", async () => {
    const { db, createWorkspaceStore } = await import("../src/server/store.js");
    const connectors = await import("../src/domain/connectors.js");
    const { processRun } = await import("../src/server/service.js");
    const read = vi.spyOn(connectors, "discover").mockResolvedValue([]);
    const workspaceId = `himalayas-runtime-${randomUUID()}`;
    const workspace = demoWorkspace();
    workspace.preferences.roles = ["Software Engineer", "Backend Engineer", "AI Engineer", "Full Stack Engineer"];
    workspace.sources = [{ id: "himalayas", provider: "himalayas", label: "Himalayas", board: "", enabled: true }];
    const inserted = await db.from("workspace").insert({ id: workspaceId, payload: workspace });
    if (inserted.error) throw inserted.error;
    const store = createWorkspaceStore({ workspaceId, client: db });
    const now = new Date().toISOString();
    const run: Run = { id: randomUUID(), workspaceId, action: "discover", discoveryScope: "jobs", status: "running", progress: 0, message: "Isolated cursor regression", createdAt: now, updatedAt: now };
    try {
      await processRun(store, run, async () => {});
      expect(await store.runtime("himalayas-status-offset:himalayas")).toEqual({ offset: 0 });
      expect(await store.runtime("himalayas-role-offset:himalayas")).toEqual({ offset: 3 });
      expect((await store.get("runs", run.id)).outcome).toBe("success");
      await processRun(store, run, async () => {});
      expect(read.mock.calls[1][2]?.roleOffset).toBe(3);
      expect(await store.runtime("himalayas-role-offset:himalayas")).toEqual({ offset: 2 });
    } finally {
      for (const table of ["runs", "events", "opportunities", "workspace_runtime"])
        await db.from(table).delete().eq("workspace_id", workspaceId);
      const removed = await db.from("workspace").delete().eq("id", workspaceId);
      if (removed.error) throw removed.error;
    }
  });
});
