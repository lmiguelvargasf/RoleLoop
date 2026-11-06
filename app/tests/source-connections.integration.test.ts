import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Source } from "../src/shared/types.js";
import type { WorkspaceStore } from "../src/server/store.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

const companyBoard = (board = `company-${randomUUID()}`): Source => ({
  id: randomUUID(),
  provider: "ashby",
  label: "Discovered employer",
  board,
  enabled: true,
  discoveredFrom: "https://example.com/employers/acme",
  discoveredAt: "2026-11-06T17:00:00.000Z",
});

integration("concurrent employer connections and source editing", () => {
  let db: SupabaseClient, app: FastifyInstance;
  const users: string[] = [],
    workspaces: string[] = [];
  async function actor() {
    const { authClient } = await import("../src/server/auth.js");
    const { createWorkspaceStore } = await import("../src/server/store.js");
    const email = `source-connections-${randomUUID()}@example.test`;
    const password = `${randomUUID()}Aa1!`;
    const created = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    users.push(created.data.user.id);
    const session = await authClient().auth.signInWithPassword({
      email,
      password,
    });
    if (session.error) throw session.error;
    const token = session.data.session!.access_token;
    const client = authClient(token);
    const workspace = demoWorkspace();
    const provisioned = await client.rpc("ensure_workspace", {
      initial_payload: {
        ...workspace,
        preferences: { ...workspace.preferences, discoverEmployers: true },
        sources: [],
      },
    });
    if (provisioned.error) throw provisioned.error;
    const workspaceId = provisioned.data[0].id;
    workspaces.push(workspaceId);
    return {
      workspaceId,
      client,
      headers: {
        host: "127.0.0.1:4310",
        authorization: `Bearer ${token}`,
        "x-workspace-id": workspaceId,
        "content-type": "application/json",
      },
      store: createWorkspaceStore({ workspaceId, client }),
      worker: createWorkspaceStore({ workspaceId, client: db }),
    };
  }
  async function replace(store: WorkspaceStore, sources: Source[]) {
    return store.replaceSources(
      sources,
      (await store.getWorkspace()).sourcesRevision!,
    );
  }
  beforeAll(async () => {
    ({ db } = await import("../src/server/store.js"));
  });
  afterAll(async () => {
    for (const id of workspaces) {
      const removed = await db.from("workspace").delete().eq("id", id);
      if (removed.error) throw removed.error;
    }
    for (const id of users) {
      const removed = await db.auth.admin.deleteUser(id);
      if (removed.error) throw removed.error;
    }
    if (app) await app.close();
  }, 30000);

  it("rejects a stale full-list edit after auto-connection and preserves paused boards and provenance", async () => {
    const { store, worker } = await actor();
    const before = await store.getWorkspace();
    const source = companyBoard();
    expect(await worker.connectDiscoveredSource(source)).toEqual({
      status: "added",
      sourceId: source.id,
    });
    await expect(
      store.replaceSources([], before.sourcesRevision!),
    ).rejects.toMatchObject({ statusCode: 409 });
    const added = await store.getWorkspace();
    expect(added.sourcesRevision).toBe(before.sourcesRevision! + 1);
    expect(added.sources).toHaveLength(1);
    const {
      discoveredFrom: _from,
      discoveredAt: _at,
      ...editable
    } = added.sources[0];
    const saved = await replace(store, [{ ...editable, enabled: false }]);
    expect(saved.sources[0]).toMatchObject({
      enabled: false,
      discoveredFrom: source.discoveredFrom,
      discoveredAt: source.discoveredAt,
    });
    expect(
      await worker.connectDiscoveredSource({
        ...source,
        id: randomUUID(),
        board: source.board.toUpperCase(),
      }),
    ).toEqual({ status: "existing", sourceId: source.id });
    const unchanged = await store.getWorkspace();
    expect(unchanged.sourcesRevision).toBe(saved.sourcesRevision);
    expect(unchanged.sources[0].enabled).toBe(false);
  });

  it("serializes a manual edit with an automatic append without losing either connection", async () => {
    const { store, worker } = await actor();
    const first = companyBoard(),
      discovered = companyBoard();
    const initial = await replace(store, [first]);
    const [append, edit] = await Promise.allSettled([
      worker.connectDiscoveredSource(discovered),
      store.replaceSources(
        [
          {
            ...initial.sources[0],
            label: "My edited employer",
            companyName: "My edited employer",
          },
        ],
        initial.sourcesRevision,
      ),
    ]);
    expect(append.status).toBe("fulfilled");
    const current = await store.getWorkspace();
    expect(current.sources.map((s) => s.id).sort()).toEqual(
      [first.id, discovered.id].sort(),
    );
    if (edit.status === "rejected")
      expect(edit.reason).toMatchObject({ statusCode: 409 });
    else
      expect(current.sources.find((s) => s.id === first.id)?.label).toBe(
        "My edited employer",
      );
    const duplicate = companyBoard();
    const simultaneous = await Promise.all([
      worker.connectDiscoveredSource(duplicate),
      worker.connectDiscoveredSource({ ...duplicate, id: randomUUID() }),
    ]);
    expect(simultaneous.map((r) => r.status).sort()).toEqual([
      "added",
      "existing",
    ]);
    expect((await store.getWorkspace()).sources).toHaveLength(3);
  });

  it("remembers removed boards until an explicit manual re-add", async () => {
    const { store, worker } = await actor();
    const source = companyBoard();
    await worker.connectDiscoveredSource(source);
    const before = await store.getWorkspace();
    await replace(store, []);
    expect(await store.ignoredDiscoveryIdentities()).toEqual([
      `ashby:${source.board}`,
    ]);
    expect(
      await worker.connectDiscoveredSource({
        ...source,
        board: source.board.toUpperCase(),
      }),
    ).toEqual({ status: "ignored" });
    expect((await store.getWorkspace()).companies).toEqual(before.companies);
    const manual = {
      ...source,
      id: randomUUID(),
      discoveredFrom: undefined,
      discoveredAt: undefined,
    };
    await replace(store, [manual]);
    expect(await store.ignoredDiscoveryIdentities()).toEqual([]);
    expect(await worker.connectDiscoveredSource(source)).toEqual({
      status: "existing",
      sourceId: manual.id,
    });
  });

  it("checks the discovery preference atomically and keeps concurrent appends under the source limit", async () => {
    const { store, worker } = await actor();
    const before = await store.getWorkspace();
    await store.updateWorkspace({
      preferences: { ...before.preferences, discoverEmployers: false },
    });
    expect((await store.getWorkspace()).sourcesRevision).toBe(
      before.sourcesRevision,
    );
    expect(await worker.connectDiscoveredSource(companyBoard())).toEqual({
      status: "ignored",
    });
    await store.updateWorkspace({
      preferences: { ...before.preferences, discoverEmployers: true },
    });
    await replace(
      store,
      Array.from({ length: 49 }, () => companyBoard()),
    );
    const results = await Promise.all([
      worker.connectDiscoveredSource(companyBoard()),
      worker.connectDiscoveredSource(companyBoard()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["added", "limit"]);
    expect((await store.getWorkspace()).sources).toHaveLength(50);
  });

  it("links an existing company without replacing its evidence and rejects a foreign company ID", async () => {
    const alice = await actor(),
      bob = await actor();
    const known = {
      ...companyBoard(),
      label: "Verified employer",
      companyCountry: "United States",
      countrySource: "https://example.com/legal",
    };
    const initial = await replace(alice.store, [known]);
    const companyId = initial.sources[0].companyId!;
    const anotherBoard = {
      ...companyBoard(),
      companyId,
      companyCountry: "Unknown",
      companyName: "Unverified feed name",
    };
    expect(
      (await alice.worker.connectDiscoveredSource(anotherBoard)).status,
    ).toBe("added");
    const current = await alice.store.getWorkspace();
    expect(current.companies).toHaveLength(1);
    expect(current.companies![0]).toMatchObject({
      id: companyId,
      name: "Verified employer",
      country: "United States",
      countrySource: known.countrySource,
    });
    await expect(
      bob.worker.connectDiscoveredSource(anotherBoard),
    ).rejects.toThrow(/Company not found/);
    expect((await bob.store.getWorkspace()).sources).toEqual([]);
  });

  it("enforces source revisions at the API and isolates suppressions and worker RPCs", async () => {
    const { buildServer } = await import("../src/server/index.js");
    app = await buildServer();
    const alice = await actor(),
      bob = await actor();
    const source = companyBoard();
    const initial = await alice.store.getWorkspace();
    const missingRevision = await app.inject({
      method: "PUT",
      url: "/api/sources",
      headers: alice.headers,
      payload: { sources: [source] },
    });
    expect(missingRevision.statusCode).toBe(400);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/sources",
      headers: alice.headers,
      payload: { sources: [source], expectedRevision: initial.sourcesRevision },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().sources).toHaveLength(1);
    expect(saved.json().sourcesRevision).toBe(initial.sourcesRevision! + 1);
    const stale = await app.inject({
      method: "PUT",
      url: "/api/sources",
      headers: alice.headers,
      payload: { sources: [], expectedRevision: initial.sourcesRevision },
    });
    expect(stale.statusCode).toBe(409);
    await replace(alice.store, []);
    expect(await alice.store.ignoredDiscoveryIdentities()).toEqual([
      `ashby:${source.board}`,
    ]);
    const hidden = await bob.client
      .from("discovery_source_suppressions")
      .select("board")
      .eq("workspace_id", alice.workspaceId);
    expect(hidden.error).toBeNull();
    expect(hidden.data).toEqual([]);
    const denied = await bob.client
      .from("discovery_source_suppressions")
      .insert({
        workspace_id: alice.workspaceId,
        provider: "ashby",
        board: "intrusion",
      });
    expect(denied.error).not.toBeNull();
    const autoDenied = await alice.client.rpc("connect_discovered_source", {
      target_workspace: alice.workspaceId,
      source_payload: companyBoard(),
    });
    expect(autoDenied.error?.code).toBe("42501");
    const foreignEdit = await bob.client.rpc("replace_discovery_sources", {
      target_workspace: alice.workspaceId,
      expected_revision: saved.json().sourcesRevision,
      source_payload: [],
    });
    expect(foreignEdit.error?.code).toBe("42501");
    const revisionTamper = await alice.client
      .from("workspace")
      .update({ sources_revision: 0 })
      .eq("id", alice.workspaceId);
    expect(revisionTamper.error?.code).toBe("42501");
  });

  it.each(["approved", "tested"] as const)(
    "preserves a %s draft and skips reassessment when only employer discovery changes",
    async (status) => {
      const alice = await actor();
      const service = await import("../src/server/service.js");
      if (!app) {
        const { buildServer } = await import("../src/server/index.js");
        app = await buildServer();
      }
      const workspace = await alice.store.getWorkspace();
      const opportunity = {
        ...demoOpportunities()[0],
        id: randomUUID(),
        sourceKey: `discovery-toggle:${randomUUID()}`,
        stage: status,
      };
      opportunity.assessment = assessOpportunity(
        opportunity,
        workspace.profile,
        workspace.preferences,
      );
      const saved = await alice.store.save("opportunities", opportunity);
      const draft = {
        ...createDraft(
          saved,
          workspace.profile,
          workspace.preferences,
          saved.assessment!,
        ),
        status,
        testReceipt:
          status === "tested" ? "Preserve the existing local test" : null,
      };
      await alice.store.save("drafts", draft);
      const invalidate = vi.spyOn(service, "invalidateDrafts");
      const reassess = vi.spyOn(service, "refreshAssessments");
      try {
        const response = await app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: alice.headers,
          payload: { ...workspace.preferences, discoverEmployers: false },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(invalidate).not.toHaveBeenCalled();
        expect(reassess).not.toHaveBeenCalled();
        expect(await alice.store.get("drafts", draft.id)).toEqual(draft);
        expect(await alice.store.get("opportunities", saved.id)).toEqual(saved);
        expect(
          (await alice.store.getWorkspace()).preferences.discoverEmployers,
        ).toBe(false);
      } finally {
        invalidate.mockRestore();
        reassess.mockRestore();
      }
    },
  );

  it("uses current salary preferences when they change while an assessment is running", async () => {
    const alice = await actor();
    const { analyze } = await import("../src/server/service.js");
    const fit = await import("../src/server/fit.js");
    const workspace = await alice.store.getWorkspace();
    const opportunity = await alice.store.save("opportunities", {
      ...demoOpportunities()[0],
      id: randomUUID(),
      sourceKey: `assessment-race:${randomUUID()}`,
    });
    const assessment = assessOpportunity(
      opportunity,
      workspace.profile,
      workspace.preferences,
    );
    expect(assessment.blockers).toEqual([]);
    const ai = vi.spyOn(fit, "assessWithAI").mockImplementation(async () => {
      await alice.store.updateWorkspace({
        preferences: {
          ...workspace.preferences,
          minimumSalary: 300000,
          targetSalary: 350000,
        },
      });
      return assessment;
    });
    try {
      const result = await analyze(alice.store, opportunity, workspace);
      expect(result.assessment?.recommendation).toBe("excluded");
      expect(result.assessment?.blockers).toContain(
        "The advertised salary maximum is below your required floor.",
      );
      expect(
        (await alice.store.get("opportunities", result.id)).assessment,
      ).toEqual(result.assessment);
    } finally {
      ai.mockRestore();
    }
  });
});
