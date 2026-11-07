import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { assertApproved, assertFresh } from "../src/server/guards.js";
import type { Opportunity } from "../src/shared/types.js";

// Opt in against the configured local Supabase stack; the ordinary test suite stays offline.
const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

function isolatedOpportunity(): Opportunity {
  const id = randomUUID();
  return {
    ...demoOpportunities()[0],
    id,
    company: `Integration sample ${id}`,
    sourceKey: `integration:${id}`,
  };
}

async function makeStore(owned = false) {
  const module = await import("../src/server/store.js");
  const workspaceId = "integration-" + randomUUID();
  let ownerId: string | null = null;
  if (owned) {
    const account = await module.db.auth.admin.createUser({
      email: `integration-${randomUUID()}@example.test`,
      password: `${randomUUID()}Aa1!`,
      email_confirm: true,
    });
    if (account.error) throw new Error(account.error.message);
    ownerId = account.data.user.id;
  }
  const result = await module.db.from("workspace").insert({
    id: workspaceId,
    name: "Integration workspace",
    owner_user_id: ownerId,
    payload: demoWorkspace(),
  });
  if (result.error) {
    if (ownerId) await module.db.auth.admin.deleteUser(ownerId);
    throw new Error(result.error.message);
  }
  return module.createWorkspaceStore({ workspaceId, client: module.db });
}
async function cleanup(store: import("../src/server/store.js").WorkspaceStore) {
  const errors: string[] = [];
  const ownership = await store.db
    .from("workspace")
    .select("owner_user_id")
    .eq("id", store.workspaceId)
    .maybeSingle();
  for (const table of [
    "drafts",
    "runs",
    "events",
    "opportunities",
    "workspace_runtime",
    "workspace_members",
  ]) {
    const result = await store.db
      .from(table)
      .delete()
      .eq("workspace_id", store.workspaceId);
    if (result.error) errors.push(result.error.message);
  }
  const result = await store.db
    .from("workspace")
    .delete()
    .eq("id", store.workspaceId);
  if (result.error) errors.push(result.error.message);
  if (ownership.data?.owner_user_id) {
    const removed = await store.db.auth.admin.deleteUser(
      ownership.data.owner_user_id,
    );
    if (removed.error) errors.push(removed.error.message);
  }
  if (errors.length)
    throw new Error("Integration cleanup failed: " + errors.join("; "));
}

integration("local Supabase source refresh and lifecycle", () => {
  it("normalizes companies and connections atomically and preserves jobs when a connection is removed", async () => {
    const store = await makeStore();
    try {
      const companyId = "company:integration-acme";
      const first = {
        id: "acme-primary",
        provider: "ashby" as const,
        label: "Acme",
        board: "acme",
        enabled: true,
        companyId,
        companyName: "Acme",
        companyCountry: "United States",
      };
      const second = {
        ...first,
        id: "acme-second",
        provider: "lever" as const,
      };
      await store.updateWorkspace({ sources: [first, second] });
      const workspace = await store.getWorkspace();
      expect(workspace.companies).toHaveLength(1);
      expect(workspace.sources.map((s) => s.kind)).toEqual([
        "company_board",
        "company_board",
      ]);
      const stored = await store.db
        .from("workspace")
        .select("payload")
        .eq("id", store.workspaceId)
        .single();
      expect(stored.data!.payload).not.toHaveProperty("sources");
      const op = await store.importOpportunity({
        ...isolatedOpportunity(),
        sourceId: first.id,
        company: "Acme",
        application: {
          status: "applied",
          appliedAt: new Date().toISOString(),
          nextAction: "Follow up",
          followUpOn: null,
          notes: "Applied",
        },
      });
      expect(op.companyId).toBe(companyId);
      await store.updateWorkspace({
        sources: [{ ...first, companyCountry: "Canada" }, second],
      });
      expect((await store.getWorkspace()).companies![0].country).toBe("Canada");
      await expect(
        store.updateWorkspace({
          sources: [
            { ...first, id: "duplicate-one", companyId: "company:rollback" },
            { ...first, id: "duplicate-two", companyId: "company:rollback" },
          ],
        }),
      ).rejects.toThrow();
      expect((await store.getWorkspace()).sources).toHaveLength(2);
      expect((await store.getWorkspace()).companies).toHaveLength(1);
      await store.updateWorkspace({ sources: [second] });
      const saved = await store.get("opportunities", op.id);
      expect(saved.companyId).toBe(companyId);
      expect(saved.application?.status).toBe("applied");
      const reference = await store.db
        .from("opportunities")
        .select("discovery_source_id")
        .eq("workspace_id", store.workspaceId)
        .eq("id", op.id)
        .single();
      expect(reference.data!.discovery_source_id).toBeNull();
    } finally {
      await cleanup(store);
    }
  });
  it("imports one shared feed snapshot into two workspaces without reusing database IDs", async () => {
    const first = await makeStore(),
      second = await makeStore();
    const { freshFeedRecords } = await import("../src/domain/connectors.js");
    try {
      const cached = [
        {
          ...isolatedOpportunity(),
          source: "jobicy",
          sourceKey: "jobicy:shared-cache-regression",
        },
      ];
      const a = await first.importOpportunity(
        freshFeedRecords(cached, "first-feed")[0],
      );
      const b = await second.importOpportunity(
        freshFeedRecords(cached, "second-feed")[0],
      );
      expect(a.id).not.toBe(b.id);
      expect(a.sourceKey).toBe(b.sourceKey);
      expect(
        (
          await first.importOpportunity(
            freshFeedRecords(cached, "first-feed")[0],
          )
        ).id,
      ).toBe(a.id);
      expect(cached[0].id).not.toBe(a.id);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  });
  it("keeps job discovery and startup research in separate execution scopes", async () => {
    const store = await makeStore();
    const connectors = await import("../src/domain/connectors.js");
    const { processRun } = await import("../src/server/service.js");
    const spy = vi.spyOn(connectors, "discover").mockResolvedValue([]);
    try {
      await store.updateWorkspace({
        sources: [
          {
            id: "jobs",
            provider: "ashby",
            label: "Acme",
            board: "acme",
            enabled: true,
          },
          {
            id: "startups",
            provider: "hackernews",
            label: "Show HN",
            board: "",
            enabled: true,
          },
        ],
      });
      const run = {
        id: randomUUID(),
        workspaceId: store.workspaceId,
        action: "discover" as const,
        status: "running" as const,
        progress: 0,
        message: "Isolated",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await processRun(store, run, async () => {});
      expect(spy.mock.calls.map(([source]) => source.id)).toEqual(["jobs"]);
      spy.mockClear();
      await processRun(
        store,
        { ...run, discoveryScope: "startups" },
        async () => {},
      );
      expect(spy.mock.calls.map(([source]) => source.id)).toEqual(["startups"]);
    } finally {
      spy.mockRestore();
      await cleanup(store);
    }
  });

  it("imports startup leads from the internal feed without rewriting workspace sources", async () => {
    const store = await makeStore();
    const connectors = await import("../src/domain/connectors.js");
    const { processRun } = await import("../src/server/service.js");
    const startup = demoOpportunities().find((op) => op.kind === "startup")!;
    const spy = vi
      .spyOn(connectors, "discover")
      .mockImplementation(async (source) => [
        {
          ...startup,
          id: randomUUID(),
          source: source.provider,
          sourceId: source.id,
          sourceKey: "hackernews:internal-startup-regression",
          isDemo: false,
        },
      ]);
    try {
      await store.updateWorkspace({ sources: [] });
      const before = await store.getWorkspace();
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(),
        workspaceId: store.workspaceId,
        action: "discover" as const,
        discoveryScope: "startups" as const,
        status: "running" as const,
        progress: 0,
        message: "Isolated startup research",
        createdAt: now,
        updatedAt: now,
      };
      await processRun(store, run, async () => {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].provider).toBe("hackernews");
      const after = await store.getWorkspace();
      expect(after.sources).toEqual([]);
      expect(after.sourcesRevision).toBe(before.sourcesRevision);
      const [saved] = await store.list("opportunities");
      const feedId = spy.mock.calls[0][0].id;
      expect(saved.sourceId).toBe(feedId);
      const reference = await store.db
        .from("opportunities")
        .select("discovery_source_id")
        .eq("workspace_id", store.workspaceId)
        .eq("id", saved.id)
        .single();
      expect(reference.error).toBeNull();
      expect(reference.data!.discovery_source_id).toBeNull();
      expect(await store.runtime("source-health")).toMatchObject({
        [feedId]: { status: "success", found: 1, evaluated: 1 },
      });
      await processRun(store, run, async () => {});
      expect(await store.list("opportunities")).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await cleanup(store);
    }
  });

  it("loads the removed missing-salary setting as review and refreshes cached ready jobs", async () => {
    const store = await makeStore();
    const workspace = demoWorkspace();
    const op = isolatedOpportunity();
    op.salaryMin = op.salaryMax = null;
    op.stage = "ready";
    op.assessment = {
      ...assessOpportunity(op, workspace.profile, workspace.preferences),
      recommendation: "ready",
      unknowns: [],
      reasons: ["Undisclosed salary retained by your search policy."],
    };
    try {
      const legacy = await store.db
        .from("workspace")
        .update({
          payload: {
            ...workspace,
            preferences: { ...workspace.preferences, missingSalary: "include" },
          },
        })
        .eq("id", store.workspaceId);
      expect(legacy.error).toBeNull();
      await store.save("opportunities", op);
      const { bootstrap } = await import("../src/server/service.js");
      const state = await bootstrap(store);
      expect(state.preferences.missingSalary).toBe("review");
      expect(state.opportunities[0].stage).toBe("review");
      expect(state.opportunities[0].assessment?.recommendation).toBe("review");
      expect(state.opportunities[0].assessment?.unknowns).toContain(
        "Salary is undisclosed.",
      );
      expect((await store.get("opportunities", op.id)).stage).toBe("review");
      await store.updateWorkspace({ preferences: state.preferences });
      const saved = await store.db
        .from("workspace")
        .select("payload")
        .eq("id", store.workspaceId)
        .single();
      expect(saved.error).toBeNull();
      expect(saved.data?.payload.preferences.missingSalary).toBe("review");
    } finally {
      await cleanup(store);
    }
  });
  it("refreshes source facts, keeps human corrections, and invalidates stale approvals", async () => {
    const store = await makeStore();
    const workspace = demoWorkspace();
    const op = isolatedOpportunity();
    const originalFirstSeen = op.firstSeenAt;
    try {
      await store.importOpportunity(op);
      const corrections = {
        companyCountry: "United States",
        remoteScope: "worldwide" as const,
        contactName: "Reviewed recipient",
      };
      await store.setRuntime(`corrections:${op.id}`, corrections);
      const application = {
        status: "interview" as const,
        appliedAt: new Date().toISOString(),
        interviewAt: new Date().toISOString(),
        nextAction: "Prepare interview",
        followUpOn: "2026-11-10",
        notes: "Recruiter screen completed",
      };
      const corrected = {
        ...op,
        ...corrections,
        application,
        stage: "tested" as const,
      };
      await store.save("opportunities", corrected);

      const assessment = assessOpportunity(
        corrected,
        workspace.profile,
        workspace.preferences,
      );
      const approved = createDraft(
        corrected,
        workspace.profile,
        workspace.preferences,
        assessment,
      );
      approved.status = "tested";
      approved.testReceipt = "Previous local simulation";
      await store.save("drafts", approved);
      expect(() =>
        assertApproved(approved, corrected, workspace),
      ).not.toThrow();

      const incoming: Opportunity = {
        ...op,
        id: randomUUID(),
        firstSeenAt: new Date(Date.now() + 1000).toISOString(),
        companyCountry: "Unknown",
        remoteScope: "unknown",
        contactName: "",
        salaryMin: 130000,
        requirements: [
          ...op.requirements,
          {
            id: "new-aws",
            text: "Must have AWS experience",
            skills: ["AWS"],
            essential: true,
            hard: true,
          },
        ],
      };
      const refreshed = await store.importOpportunity(incoming);
      expect(refreshed.id).toBe(op.id);
      expect(refreshed.firstSeenAt).toBe(originalFirstSeen);
      expect(refreshed.salaryMin).toBe(130000);
      expect(refreshed.requirements.at(-1)?.id).toBe("new-aws");
      expect(refreshed).toMatchObject(corrections);
      expect(refreshed.application).toEqual(application);
      expect(refreshed.stage).toBe("new");
      expect(refreshed.assessment).toBeNull();
      const invalidated = await store.get("drafts", approved.id);
      expect(invalidated.status).toBe("draft");
      expect(invalidated.testReceipt).toBeNull();
      expect(() => assertFresh(approved, refreshed, workspace)).toThrow(
        /changed/,
      );
      expect(() =>
        assertApproved(
          { ...invalidated, status: "approved" },
          refreshed,
          workspace,
        ),
      ).toThrow(/changed/);

      // Identical reimports do not disturb a newly reviewed draft or the current lifecycle.
      const freshDraft = createDraft(
        refreshed,
        workspace.profile,
        workspace.preferences,
        assessOpportunity(refreshed, workspace.profile, workspace.preferences),
      );
      freshDraft.status = "approved";
      await store.save("drafts", freshDraft);
      await store.save("opportunities", { ...refreshed, stage: "approved" });
      const unchanged = await store.importOpportunity(incoming);
      expect(unchanged.stage).toBe("approved");
      const unchangedDraft = await store.get("drafts", freshDraft.id);
      expect(unchangedDraft.status).toBe("approved");
      expect(() =>
        assertApproved(unchangedDraft, unchanged, workspace),
      ).not.toThrow();
    } finally {
      await cleanup(store);
    }
  }, 20000);

  it.each(["drafted", "approved", "tested", "archived"] as const)(
    "preserves the %s stage when reassessing current facts",
    async (stage) => {
      const store = await makeStore();
      const { analyze } = await import("../src/server/service.js");
      const workspace = demoWorkspace();
      const op = { ...isolatedOpportunity(), stage };
      try {
        await store.save("opportunities", op);
        const result = await analyze(store, op, workspace);
        expect(result.stage).toBe(stage);
        expect(result.assessment?.recommendation).toBe("ready");
        expect((await store.get("opportunities", op.id)).stage).toBe(stage);
      } finally {
        await cleanup(store);
      }
    },
    20000,
  );
});

integration("workspace-scoped persistence", () => {
  it("keeps contact synced to the owner account and rejects retired profile fields on every database write", async () => {
    const store = await makeStore(true);
    try {
      const row = await store.db
        .from("workspace")
        .select("owner_user_id,payload")
        .eq("id", store.workspaceId)
        .single();
      expect(row.error).toBeNull();
      const ownerId = row.data!.owner_user_id;
      const account = await store.db.auth.admin.getUserById(ownerId);
      const current = await store.getWorkspace();
      expect(current.profile.email).toBe(account.data.user!.email);
      expect(row.data!.payload.profile).not.toHaveProperty("email");
      const legacy = {
        ...current.profile,
        email: "forged@example.test",
        headline: "Old",
        summary: "Old",
        learning: "Old",
        skills: ["Unused"],
      };
      const direct = await store.db
        .from("workspace")
        .update({ payload: { ...current, profile: legacy } })
        .eq("id", store.workspaceId)
        .select("payload")
        .single();
      expect(direct.error).toBeNull();
      for (const field of [
        "email",
        "headline",
        "summary",
        "learning",
        "skills",
      ])
        expect(direct.data!.payload.profile).not.toHaveProperty(field);
      expect(direct.data!.payload.profile.cache!.facts!.evidence).toEqual(
        current.profile.cache!.facts!.evidence,
      );
      const nextEmail = `changed-${randomUUID()}@example.test`;
      const updated = await store.db.auth.admin.updateUserById(ownerId, {
        email: nextEmail,
      });
      expect(updated.error).toBeNull();
      expect((await store.getWorkspace()).profile.email).toBe(nextEmail);
      const saved = await store.updateWorkspace({ profile: legacy });
      expect(saved.profile.email).toBe(nextEmail);
      const stored = await store.db
        .from("workspace")
        .select("payload")
        .eq("id", store.workspaceId)
        .single();
      expect(stored.data!.payload.profile).not.toHaveProperty("email");
    } finally {
      await cleanup(store);
    }
  });

  it("accepts SQL-valid colon and 200-character IDs while rejecting path traversal", async () => {
    const store = await makeStore();
    try {
      const base = isolatedOpportunity();
      const ids = [
        `record:${randomUUID()}`,
        `r${randomUUID().replaceAll("-", "")}${"x".repeat(167)}`,
      ];
      expect(ids[1]).toHaveLength(200);
      for (const id of ids) {
        const op = { ...base, id, sourceKey: `integration:${id}` };
        await store.save("opportunities", op);
        expect((await store.get("opportunities", id)).id).toBe(id);
      }
      expect(
        (await store.list("opportunities")).map((op) => op.id).sort(),
      ).toEqual([...ids].sort());
      await expect(
        store.save("opportunities", { ...base, id: "../foreign" }),
      ).rejects.toThrow(/identifier/);
      await expect(
        store.save("opportunities", { ...base, id: "x".repeat(201) }),
      ).rejects.toThrow(/identifier/);
      const now = new Date().toISOString();
      const runId = `running:${randomUUID()}`;
      const direct = await store.db.from("runs").insert({
        id: runId,
        workspace_id: store.workspaceId,
        status: "running",
        payload: {},
      });
      if (direct.error) throw new Error(direct.error.message);
      const recovered = (await store.list("runs"))[0];
      expect(recovered.id).toBe(runId);
      expect(recovered.status).toBe("running");
      await store.save("runs", {
        ...recovered,
        action: "discover",
        status: "failed",
        message: "Recovery test",
        progress: 0,
        createdAt: now,
        updatedAt: now,
      });
      expect((await store.get("runs", runId)).status).toBe("failed");
    } finally {
      await cleanup(store);
    }
  }, 20000);

  it("uses SQL identity and relationships even when JSON payloads are tampered with", async () => {
    const store = await makeStore();
    try {
      const op = isolatedOpportunity(),
        workspace = demoWorkspace();
      await store.save("opportunities", op);
      const draft = createDraft(
        op,
        workspace.profile,
        workspace.preferences,
        assessOpportunity(op, workspace.profile, workspace.preferences),
      );
      await store.save("drafts", draft);
      const changedOp = await store.db
        .from("opportunities")
        .update({
          payload: {
            ...op,
            id: "../../foreign-record",
            kind: "startup",
            sourceKey: "forged-source",
          },
        })
        .eq("workspace_id", store.workspaceId)
        .eq("id", op.id);
      if (changedOp.error) throw new Error(changedOp.error.message);
      const changedDraft = await store.db
        .from("drafts")
        .update({
          payload: {
            ...draft,
            id: "../../foreign-document",
            opportunityId: "foreign-opportunity",
          },
        })
        .eq("workspace_id", store.workspaceId)
        .eq("id", draft.id);
      if (changedDraft.error) throw new Error(changedDraft.error.message);
      const readOp = await store.get("opportunities", op.id);
      expect(readOp.id).toBe(op.id);
      expect(readOp.kind).toBe(op.kind);
      expect(readOp.sourceKey).toBe(op.sourceKey);
      const readDraft = await store.get("drafts", draft.id);
      expect(readDraft.id).toBe(draft.id);
      expect(readDraft.opportunityId).toBe(op.id);
      expect((await store.list("drafts"))[0].id).toBe(draft.id);
      expect((await store.importOpportunity(op)).id).toBe(op.id);
      const { createWorkspaceStore } = await import("../src/server/store.js");
      expect(() =>
        createWorkspaceStore({ workspaceId: "../another", client: store.db }),
      ).toThrow(/workspace context/);
      await expect(
        store.save("opportunities", { ...op, id: "../another" }),
      ).rejects.toThrow(/identifier/);
    } finally {
      await cleanup(store);
    }
  }, 20000);

  it("keeps identical source keys, corrections, lists and ID lookups isolated even for the worker client", async () => {
    const first = await makeStore(),
      second = await makeStore();
    try {
      const opportunity = isolatedOpportunity();
      const other = {
        ...opportunity,
        id: randomUUID(),
        company: "Second workspace company",
      };
      await first.importOpportunity(opportunity);
      await second.importOpportunity(other);
      expect((await first.list("opportunities")).map((x) => x.company)).toEqual(
        [opportunity.company],
      );
      expect(
        (await second.list("opportunities")).map((x) => x.company),
      ).toEqual([other.company]);
      await first.setRuntime("last-discovery", { at: "first workspace only" });
      expect(await second.runtime("last-discovery")).toBeNull();
      await expect(second.get("opportunities", opportunity.id)).rejects.toThrow(
        /not found/,
      );
      await expect(
        second.save("opportunities", {
          ...opportunity,
          company: "Attempted overwrite",
        }),
      ).rejects.toThrow();
      expect((await first.get("opportunities", opportunity.id)).company).toBe(
        opportunity.company,
      );
      expect((await first.getWorkspace()).profile.cache!.facts!.name).toBe(
        "Alex Morgan",
      );
      const updated = demoWorkspace().profile;
      updated.cache!.facts!.name = "Private candidate";
      await second.updateWorkspace({ profile: updated });
      expect((await first.getWorkspace()).profile.cache!.facts!.name).toBe(
        "Alex Morgan",
      );
      expect((await second.getWorkspace()).profile.cache!.facts!.name).toBe(
        "Private candidate",
      );
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  }, 20000);

  it("rejects a draft referencing another workspace's opportunity", async () => {
    const first = await makeStore(),
      second = await makeStore();
    try {
      const op = isolatedOpportunity(),
        workspace = demoWorkspace();
      await first.save("opportunities", op);
      const draft = createDraft(
        op,
        workspace.profile,
        workspace.preferences,
        assessOpportunity(op, workspace.profile, workspace.preferences),
      );
      await expect(second.save("drafts", draft)).rejects.toThrow();
      expect(await first.list("drafts")).toEqual([]);
      expect(await second.list("drafts")).toEqual([]);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  }, 20000);

  it("keeps queue deduplication local to each workspace", async () => {
    const first = await makeStore(true),
      second = await makeStore(true);
    try {
      const { enqueue } = await import("../src/server/service.js");
      const firstRun = await enqueue(first, { action: "discover" });
      const secondRun = await enqueue(second, { action: "discover" });
      expect(firstRun.workspaceId).toBe(first.workspaceId);
      expect(secondRun.workspaceId).toBe(second.workspaceId);
      expect(firstRun.id).not.toBe(secondRun.id);
      const duplicate = await enqueue(first, { action: "discover" });
      expect(duplicate.id).toBe(firstRun.id);
      expect(await first.list("runs")).toHaveLength(1);
      expect(await second.list("runs")).toHaveLength(1);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  }, 20000);

  it("refuses a worker task paired with a different workspace store", async () => {
    const first = await makeStore(),
      second = await makeStore();
    try {
      const { processRun } = await import("../src/server/service.js");
      const now = new Date().toISOString();
      await expect(
        processRun(
          first,
          {
            id: randomUUID(),
            workspaceId: second.workspaceId,
            action: "discover",
            status: "running",
            progress: 0,
            message: "",
            createdAt: now,
            updatedAt: now,
          },
          async () => {},
        ),
      ).rejects.toThrow(/workspace/);
      expect(await first.list("runs")).toEqual([]);
      expect(await second.list("runs")).toEqual([]);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  }, 20000);
});
