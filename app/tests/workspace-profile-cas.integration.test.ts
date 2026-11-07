import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { demoWorkspace } from "./fixtures.js";
import { clearCVFacts } from "../src/server/cv.js";
import type { Profile } from "../src/shared/types.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
const persisted = ({ email: _email, ...profile }: Profile) => profile;

function largeProfile() {
  const profile = structuredClone(demoWorkspace().profile);
  const facts = profile.cache!.facts!;
  facts.evidence = Array.from({ length: 60 }, (_, index) => ({
    id: randomUUID(),
    text: `Record ${index}: ${"Built tested services with TypeScript and PostgreSQL. ".repeat(22)}`,
    skills: ["TypeScript", "PostgreSQL"],
    verified: true,
    role: `Engineer ${index}`,
    company: "Example employer",
    period: "2024–2026",
    category: "experience" as const,
  }));
  facts.sections = facts.evidence.map((entry) => ({
    id: randomUUID(),
    category: "experience" as const,
    role: entry.role,
    company: entry.company,
    period: entry.period,
    sourceText: entry.text,
    evidenceIds: [entry.id],
  }));
  return profile;
}

integration("body-based workspace profile compare-and-swap", () => {
  let db: SupabaseClient;
  const users: string[] = [],
    workspaces: string[] = [];
  async function actor() {
    const { authClient } = await import("../src/server/auth.js");
    const { createWorkspaceStore } = await import("../src/server/store.js");
    const email = `profile-cas-${randomUUID()}@example.test`;
    const password = `${randomUUID()}aA1!`;
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
    const client = authClient(session.data.session!.access_token);
    const provisioned = await client.rpc("ensure_workspace", {
      initial_payload: demoWorkspace(),
    });
    if (provisioned.error) throw provisioned.error;
    const workspaceId = provisioned.data[0].id;
    workspaces.push(workspaceId);
    return {
      userId: created.data.user.id,
      workspaceId,
      client,
      store: createWorkspaceStore({
        workspaceId,
        client,
        actorUserId: created.data.user.id,
      }),
    };
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
  }, 30000);

  it("clears and replaces a realistic large profile without putting its JSON in the URL", async () => {
    const alice = await actor();
    const large = (
      await alice.store.updateWorkspace({ profile: largeProfile() })
    ).profile;
    expect(JSON.stringify(large).length).toBeGreaterThan(50_000);
    const before = await alice.store.getWorkspace();
    const cleared = await clearCVFacts(alice.store, {
      sourceId: large.source!.id,
      cacheId: large.cache!.id,
    });
    expect(cleared).toMatchObject({ source: large.source, cache: null });
    expect((await alice.store.getWorkspace()).preferences).toEqual(
      before.preferences,
    );
    const restored = (await alice.store.updateWorkspace({ profile: large }))
      .profile;
    const replacement = {
      ...restored,
      source: { ...restored.source!, id: randomUUID() },
      cache: null,
    };
    const saved = await alice.store.updateWorkspace(
      { profile: replacement },
      restored,
    );
    expect(saved.profile).toEqual(replacement);
    expect((await alice.store.getWorkspace()).profile).toEqual(replacement);
    await expect(
      alice.store.updateWorkspace({ profile: large }, restored),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("compares atomically in PostgreSQL and preserves independently changed workspace settings", async () => {
    const alice = await actor();
    const old = (await alice.store.updateWorkspace({ profile: largeProfile() }))
      .profile;
    const initial = await alice.store.getWorkspace();
    const changedPreferences = {
      ...initial.preferences,
      minimumSalary: 123456,
    };
    const preferences = await alice.client.rpc(
      "update_workspace_profile_if_current",
      {
        target_workspace: alice.workspaceId,
        expected_profile: null,
        workspace_patch: { preferences: changedPreferences },
      },
    );
    expect(preferences.error).toBeNull();
    const cleared = await alice.client.rpc(
      "update_workspace_profile_if_current",
      {
        target_workspace: alice.workspaceId,
        expected_profile: persisted(old),
        workspace_patch: { profile: { ...persisted(old), cache: null } },
      },
    );
    expect(cleared.error).toBeNull();
    expect(cleared.data).toEqual([{ id: alice.workspaceId }]);
    expect((await alice.store.getWorkspace()).preferences).toEqual(
      changedPreferences,
    );
    const stale = await alice.client.rpc(
      "update_workspace_profile_if_current",
      {
        target_workspace: alice.workspaceId,
        expected_profile: persisted(old),
        workspace_patch: { profile: persisted(old) },
      },
    );
    expect(stale.error).toBeNull();
    expect(stale.data).toEqual([]);
    expect((await alice.store.getWorkspace()).profile.cache).toBeNull();

    const current = (await alice.store.getWorkspace()).profile;
    const attempts = await Promise.all(
      [1, 2].map(() =>
        alice.client.rpc("update_workspace_profile_if_current", {
          target_workspace: alice.workspaceId,
          expected_profile: persisted(current),
          workspace_patch: {
            profile: {
              ...persisted(current),
              source: { ...current.source!, id: randomUUID() },
            },
          },
        }),
      ),
    );
    expect(attempts.every((result) => result.error === null)).toBe(true);
    expect(attempts.map((result) => result.data.length).sort()).toEqual([0, 1]);
  });

  it("allows only the owner to write, including when a legacy manager row exists", async () => {
    const alice = await actor(),
      bob = await actor();
    const current = (
      await alice.store.updateWorkspace({ profile: largeProfile() })
    ).profile;
    const args = {
      target_workspace: alice.workspaceId,
      expected_profile: persisted(current),
      workspace_patch: { profile: { ...persisted(current), cache: null } },
    };
    const foreign = await bob.client.rpc(
      "update_workspace_profile_if_current",
      args,
    );
    expect(foreign.error).toBeNull();
    expect(foreign.data).toEqual([]);
    expect((await alice.store.getWorkspace()).profile).toEqual(current);
    const { authClient } = await import("../src/server/auth.js");
    const anonymous = await authClient().rpc(
      "update_workspace_profile_if_current",
      args,
    );
    expect(anonymous.error).not.toBeNull();
    const legacy = await db.from("workspace_members").insert({
      workspace_id: alice.workspaceId,
      user_id: bob.userId,
      role: "manager",
    });
    expect(legacy.error).toBeNull();
    const formerManager = await bob.client.rpc(
      "update_workspace_profile_if_current",
      args,
    );
    expect(formerManager.error).toBeNull();
    expect(formerManager.data).toEqual([]);
    expect((await alice.store.getWorkspace()).profile).toEqual(current);
    const owner = await alice.client.rpc(
      "update_workspace_profile_if_current",
      args,
    );
    expect(owner.error).toBeNull();
    expect(owner.data).toEqual([{ id: alice.workspaceId }]);
    const ownership = await db
      .from("workspace")
      .select("owner_user_id,name")
      .eq("id", alice.workspaceId)
      .single();
    expect(ownership.error).toBeNull();
    expect(ownership.data).toEqual({
      owner_user_id: alice.userId,
      name: "Personal workspace",
    });
    expect((await alice.store.getWorkspace()).profile.cache).toBeNull();
    expect((await bob.store.getWorkspace()).profile.cache).not.toBeNull();
  });

  it("rejects malformed direct RPC patches without changing the workspace", async () => {
    const alice = await actor();
    const before = await alice.client.from("workspace")
      .select("payload,updated_at").eq("id", alice.workspaceId).single();
    expect(before.error).toBeNull();
    const invalidPatches = [
      null, [], "replacement", 42, true,
      { profile: null }, { profile: [] }, { profile: "replacement" },
      { preferences: null }, { preferences: [] }, { preferences: true },
      { sources: null }, { sources: {} }, { sources: "replacement" },
      { unknown: {} }, { name: "Replacement name" },
      { owner_user_id: randomUUID() }, { profile: {}, extra: [] },
    ];
    for (const workspace_patch of invalidPatches) {
      const attempted = await alice.client.rpc("update_workspace_profile_if_current", {
        target_workspace: alice.workspaceId,
        expected_profile: null,
        workspace_patch,
      });
      expect(attempted.error?.code, JSON.stringify(workspace_patch)).toBe("22023");
    }
    const after = await alice.client.from("workspace")
      .select("payload,updated_at").eq("id", alice.workspaceId).single();
    expect(after.error).toBeNull();
    expect(after.data).toEqual(before.data);
  });
});
