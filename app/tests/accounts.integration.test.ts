import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountContext } from "../src/shared/types.js";
const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
type Actor = {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
  workspaceId: string;
};

integration(
  "account and workspace authorization through the API and RLS",
  () => {
    let app: FastifyInstance,
      db: SupabaseClient,
      alice: Actor,
      bob: Actor,
      carol: Actor;
    const users: string[] = [];
    const headers = (actor?: Actor, workspaceId?: string) => ({
      host: "127.0.0.1:4310",
      ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      "content-type": "application/json",
    });
    async function account(name: string): Promise<Actor> {
      const { authClient } = await import("../src/server/auth.js");
      const email = `roleloop-test-${randomUUID()}@roleloop.test`,
        password = randomBytes(24).toString("base64url");
      const created = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
      });
      if (created.error || !created.data.user)
        throw new Error(created.error?.message || "Could not create test user");
      users.push(created.data.user.id);
      const session = await authClient().auth.signInWithPassword({
        email,
        password,
      });
      if (session.error || !session.data.session)
        throw new Error(session.error?.message || "Could not sign in");
      const token = session.data.session.access_token;
      const actor = {
        id: created.data.user.id,
        email,
        token,
        client: authClient(token),
        workspaceId: "",
      };
      const response = await app.inject({
        url: "/api/account",
        headers: headers(actor),
      });
      expect(response.statusCode, response.body).toBe(200);
      const context = response.json<AccountContext>();
      expect(context.isAdmin).toBe(false);
      expect(context.workspaces).toHaveLength(1);
      actor.workspaceId = context.workspaces[0].id;
      return actor;
    }
    beforeAll(async () => {
      ({ db } = await import("../src/server/store.js"));
      const { buildServer } = await import("../src/server/index.js");
      app = await buildServer();
      alice = await account("Alice test");
      bob = await account("Bob test");
      carol = await account("Carol test");
    }, 30000);
    afterAll(async () => {
      if (db) {
        for (const id of users) {
          // Only delete records belonging to users created by this test.
          const workspaces = await db
            .from("workspace")
            .select("id")
            .eq("owner_user_id", id);
          for (const row of workspaces.data || []) {
            const versions = await db.storage
              .from("documents")
              .list(`${row.id}/profile-versions`);
            if (versions.data?.length)
              await db.storage
                .from("documents")
                .remove(
                  versions.data.map(
                    (file) => `${row.id}/profile-versions/${file.name}`,
                  ),
                );
            await db.from("drafts").delete().eq("workspace_id", row.id);
            await db.from("opportunities").delete().eq("workspace_id", row.id);
            const removed = await db
              .from("workspace")
              .delete()
              .eq("id", row.id);
            if (removed.error) throw new Error(removed.error.message);
          }
          await db.from("app_admins").delete().eq("user_id", id);
          const removed = await db.auth.admin.deleteUser(id);
          if (removed.error) throw new Error(removed.error.message);
        }
      }
      if (app) await app.close();
    }, 30000);

    it("keeps ChatGPT connection actions scoped to the signed-in account", async () => {
      const anonymous = await app.inject({
        url: "/api/account/chatgpt",
        headers: headers(),
      });
      expect(anonymous.statusCode).toBe(401);
      const own = await app.inject({
        url: "/api/account/chatgpt",
        headers: headers(alice),
      });
      expect(own.statusCode).toBe(200);
      expect(own.json().profiles).toEqual([]);
      const foreign = await app.inject({
        method: "POST",
        url: "/api/account/chatgpt/select",
        headers: headers(bob),
        payload: { profileId: randomUUID(), userId: alice.id },
      });
      expect(foreign.statusCode).toBe(404);
      expect(JSON.stringify(own.json())).not.toMatch(
        /access_token|refresh_token|id_token/,
      );
    });
    it("stamps immutable billing identities independently of supplied payloads", async () => {
      const id = randomUUID();
      try {
        const result = await alice.client
          .from("runs")
          .insert({
            id,
            workspace_id: alice.workspaceId,
            status: "completed",
            requested_by: bob.id,
            payload: {
              id,
              action: "discover",
              requestedBy: bob.id,
              status: "completed",
            },
          })
          .select("requested_by")
          .single();
        expect(result.error).toBeNull();
        expect(result.data?.requested_by).toBe(alice.id);
        await db.from("workspace_members").insert({
          workspace_id: alice.workspaceId,
          user_id: bob.id,
          role: "manager",
        });
        const tampered = await bob.client
          .from("runs")
          .update({ status: "queued", payload: { action: "discover" } })
          .eq("id", id);
        expect(tampered.error?.code).toBe("42501");
        const changed = await alice.client
          .from("runs")
          .update({ requested_by: bob.id })
          .eq("id", id);
        expect(changed.error?.code).toBe("42501");
        const { createWorkspaceStore } = await import("../src/server/store.js");
        const store = createWorkspaceStore({
          workspaceId: alice.workspaceId,
          client: db,
        });
        expect((await store.get("runs", id)).requestedBy).toBe(alice.id);
      } finally {
        await db.from("runs").delete().eq("id", id);
        await db
          .from("workspace_members")
          .delete()
          .eq("workspace_id", alice.workspaceId)
          .eq("user_id", bob.id);
      }
    });

    it("does not expose sample loading or local test actions", async () => {
      for (const url of [
        "/api/seed",
        "/api/drafts/example/approve",
        "/api/drafts/example/simulate",
      ]) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: headers(alice, alice.workspaceId),
          payload: {},
        });
        expect(response.statusCode).toBe(404);
      }
    });

    it("requires authentication and leaves the legacy workspace unclaimed", async () => {
      const anonymous = await app.inject({
        url: "/api/bootstrap",
        headers: headers(undefined, "default"),
      });
      expect(anonymous.statusCode).toBe(401);
      const bad = await app.inject({
        url: "/api/account",
        headers: { ...headers(), authorization: "Bearer forged-token" },
      });
      expect(bad.statusCode).toBe(401);
      for (const actor of [alice, bob]) {
        expect(actor.workspaceId).not.toBe("default");
        const legacy = await app.inject({
          url: "/api/bootstrap",
          headers: headers(actor, "default"),
        });
        expect(legacy.statusCode).toBe(403);
        const own = await app.inject({
          url: "/api/bootstrap",
          headers: headers(actor, actor.workspaceId),
        });
        expect(own.statusCode, own.body).toBe(200);
        expect(own.json().opportunities).toEqual([]);
        expect(own.json().profile.source).toBeNull();
        expect(own.json().profile.cache).toBeNull();
        expect(own.json().status.studioUrl).toBe("");
      }
    });
    it("captures requirements and keeps application milestones and follow-ups through status changes", async () => {
      const actor = await account("Application progress test");
      const requestHeaders = headers(actor, actor.workspaceId);
      const created = await app.inject({
        method: "POST",
        url: "/api/opportunities",
        headers: requestHeaders,
        payload: {
          kind: "job",
          company: "Test employer",
          title: "Account Manager",
          url: "https://example.com/job",
          description:
            "Requirements\nExcellent communication skills\nMust manage enterprise accounts",
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const op = created.json();
      expect(op.requirements).toHaveLength(2);
      let application = {
        status: "applied",
        appliedAt: null,
        nextAction: "Contact recruiter",
        followUpOn: "2026-11-10",
        notes: "Submitted on company website",
      };
      for (const status of ["applied", "interview", "rejected"]) {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/opportunities/${op.id}`,
          headers: requestHeaders,
          payload: { application: { ...application, status } },
        });
        expect(response.statusCode, response.body).toBe(200);
        application = response.json().application;
        expect(application.appliedAt).toBeTruthy();
        expect(response.json().stage).toBe(op.stage);
      }
      expect(application).toMatchObject({
        status: "rejected",
        nextAction: "Contact recruiter",
        followUpOn: "2026-11-10",
      });
      expect(
        (application as unknown as { interviewAt: string }).interviewAt,
      ).toBeTruthy();
      const denied = await app.inject({
        method: "PATCH",
        url: `/api/opportunities/${op.id}`,
        headers: headers(bob, actor.workspaceId),
        payload: { application },
      });
      expect(denied.statusCode).toBe(403);
    });
    it("saves a minimum alone, adds or clears a target, and validates an explicit target", async () => {
      const actor = await account("Salary preferences test");
      const own = await app.inject({
        url: "/api/bootstrap",
        headers: headers(actor, actor.workspaceId),
      });
      expect(own.statusCode, own.body).toBe(200);
      const preferences = own.json().preferences;
      expect(preferences.targetSalary).toBeNull();
      for (const targetSalary of [undefined, 200000, null]) {
        const response = await app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: headers(actor, actor.workspaceId),
          payload: { ...preferences, minimumSalary: 150000, targetSalary },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().targetSalary).toBe(targetSalary ?? null);
        const saved = await app.inject({
          url: "/api/bootstrap",
          headers: headers(actor, actor.workspaceId),
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json().preferences).toMatchObject({
          minimumSalary: 150000,
          targetSalary: targetSalary ?? null,
        });
      }
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/preferences",
        headers: headers(actor, actor.workspaceId),
        payload: {
          ...preferences,
          minimumSalary: 150000,
          targetSalary: 140000,
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toContain(
        "Target salary must be at least the minimum salary",
      );
    });
    it("persists salary flexibility and reassesses existing jobs when it changes", async () => {
      const actor = await account("Salary flexibility test");
      const requestHeaders = headers(actor, actor.workspaceId);
      const own = await app.inject({
        url: "/api/bootstrap",
        headers: requestHeaders,
      });
      expect(own.statusCode, own.body).toBe(200);
      const preferences = own.json().preferences;
      expect(preferences.salaryFlexibility).toBe(false);
      const created = await app.inject({
        method: "POST",
        url: "/api/opportunities",
        headers: requestHeaders,
        payload: {
          kind: "job",
          company: "Benefits review test",
          title: "Software Engineer",
          description: "A remote software engineering role.",
          url: "https://example.com/salary-flexibility-test",
          companyCountry: "United States",
          remoteScope: "worldwide",
          salaryMin: 100000,
          salaryMax: 100000,
          salaryCurrency: "USD",
          salaryPeriod: "year",
          publishedAt: new Date().toISOString(),
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      for (const salaryPolicy of ["overlap", "strict"]) {
        for (const salaryFlexibility of [false, true, false]) {
          const updated = await app.inject({
            method: "PUT",
            url: "/api/preferences",
            headers: requestHeaders,
            payload: {
              ...preferences,
              minimumSalary: 108000,
              salaryPolicy,
              salaryFlexibility,
            },
          });
          expect(updated.statusCode, updated.body).toBe(200);
          const loaded = await app.inject({
            url: "/api/bootstrap",
            headers: requestHeaders,
          });
          expect(loaded.statusCode, loaded.body).toBe(200);
          expect(loaded.json().preferences).toMatchObject({
            minimumSalary: 108000,
            salaryPolicy,
            salaryFlexibility,
          });
          const assessment = loaded.json().opportunities[0].assessment;
          expect(assessment.recommendation).toBe(
            salaryFlexibility ? "review" : "excluded",
          );
          expect(
            assessment.unknowns.join(" ").includes("consider benefits"),
          ).toBe(salaryFlexibility);
        }
      }
    });
    it("persists industry preferences and changes priority in both discovery lists without filtering", async () => {
      const actor = await account("Industry preferences test");
      const own = await app.inject({
        url: "/api/bootstrap",
        headers: headers(actor, actor.workspaceId),
      });
      const preferences = own.json().preferences;
      const industries = ["Climate", "Space technology"];
      for (const kind of ["job", "startup"]) {
        for (const preferred of [false, true]) {
          const created = await app.inject({
            method: "POST",
            url: "/api/opportunities",
            headers: headers(actor, actor.workspaceId),
            payload: {
              kind,
              company: preferred ? "Climate team" : "Accounting team",
              title: "Engineering opportunity",
              description: preferred
                ? "Climate risk software"
                : "Accounting software",
              url: `https://example.com/${kind}/${preferred ? "climate" : "accounting"}`,
              publishedAt: new Date(
                Date.now() - (preferred ? 2 : 1) * 86400000,
              ).toISOString(),
            },
          });
          expect(created.statusCode, created.body).toBe(200);
        }
      }
      for (const industryPreference of ["prefer", "any", "prefer"]) {
        const updated = await app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: headers(actor, actor.workspaceId),
          payload: {
            ...preferences,
            industries,
            industryPreference,
            topIndustries: ["Climate"],
          },
        });
        expect(updated.statusCode, updated.body).toBe(200);
        const loaded = await app.inject({
          url: "/api/bootstrap",
          headers: headers(actor, actor.workspaceId),
        });
        expect(loaded.statusCode, loaded.body).toBe(200);
        const state = loaded.json();
        expect(state.preferences.industries).toEqual(industries);
        expect(state.preferences.topIndustries).toEqual(["Climate"]);
        expect(state.preferences.industryPreference).toBe(industryPreference);
        for (const kind of ["job", "startup"]) {
          const list = state.opportunities.filter(
            (op: { kind: string }) => op.kind === kind,
          );
          expect(list).toHaveLength(2);
          expect(list[0].company).toBe(
            industryPreference === "prefer"
              ? "Climate team"
              : "Accounting team",
          );
        }
      }
    });
    it("blocks cross-workspace reads, updates, exports and direct database access", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/opportunities",
        headers: headers(alice, alice.workspaceId),
        payload: {
          kind: "job",
          company: "Private company",
          title: "Private engineer role",
          description: "Confidential test posting",
          url: "https://example.com/private",
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const op = created.json();
      const other = await app.inject({
        url: "/api/bootstrap",
        headers: headers(bob, alice.workspaceId),
      });
      expect(other.statusCode).toBe(403);
      const modify = await app.inject({
        method: "PATCH",
        url: `/api/opportunities/${op.id}`,
        headers: headers(bob, bob.workspaceId),
        payload: { notes: "Intrusion" },
      });
      expect(modify.statusCode).toBe(404);
      const forged = await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: headers(bob, bob.workspaceId),
        payload: { action: "analyze", opportunityId: op.id },
      });
      expect(forged.statusCode).toBe(404);
      const direct = await bob.client
        .from("opportunities")
        .select("id")
        .eq("id", op.id);
      expect(direct.error).toBeNull();
      expect(direct.data).toEqual([]);
      const insert = await bob.client.from("opportunities").insert({
        id: randomUUID(),
        workspace_id: alice.workspaceId,
        kind: "job",
        source_key: randomUUID(),
        payload: op,
      });
      expect(insert.error).not.toBeNull();
      const queue = await bob.client.rpc("enqueue_run", {
        target_workspace: alice.workspaceId,
        run_payload: { id: randomUUID(), action: "discover" },
      });
      expect(queue.error).not.toBeNull();
      const draftId = randomUUID();
      const { createDraft } = await import("../src/domain/templates.js");
      const { demoWorkspace, demoOpportunities } = await import(
        "./fixtures.js"
      );
      const { assessOpportunity } = await import("../src/domain/rules.js");
      const profile = demoWorkspace();
      const sample = { ...demoOpportunities()[0], id: op.id };
      const draft = {
        ...createDraft(
          sample,
          profile.profile,
          profile.preferences,
          assessOpportunity(sample, profile.profile, profile.preferences),
        ),
        id: draftId,
      };
      const saved = await db.from("drafts").insert({
        id: draftId,
        workspace_id: alice.workspaceId,
        opportunity_id: op.id,
        payload: draft,
      });
      expect(saved.error).toBeNull();
      const exportAttempt = await app.inject({
        url: `/api/drafts/${draftId}/download?format=json`,
        headers: headers(bob, bob.workspaceId),
      });
      expect(exportAttempt.statusCode).toBe(404);
      const ownExport = await app.inject({
        url: `/api/drafts/${draftId}/download?format=json`,
        headers: headers(alice, alice.workspaceId),
      });
      expect(ownExport.statusCode).toBe(200);
    });
    it("grants and revokes manager access without allowing manager escalation", async () => {
      const grant = await app.inject({
        method: "POST",
        url: `/api/workspaces/${alice.workspaceId}/members`,
        headers: headers(alice),
        payload: { email: bob.email },
      });
      expect(grant.statusCode, grant.body).toBe(200);
      const access = await app.inject({
        url: "/api/bootstrap",
        headers: headers(bob, alice.workspaceId),
      });
      expect(access.statusCode, access.body).toBe(200);
      expect(access.json().profile.email).toBe(alice.email);
      const forbidden = await app.inject({
        method: "POST",
        url: `/api/workspaces/${alice.workspaceId}/members`,
        headers: headers(bob),
        payload: { email: carol.email },
      });
      expect(forbidden.statusCode).toBe(403);
      const direct = await bob.client.rpc("manage_workspace_member", {
        target_workspace: alice.workspaceId,
        member_user_id: carol.id,
        operation: "grant",
      });
      expect(direct.error).not.toBeNull();
      const selfOwner = await bob.client
        .from("workspace")
        .update({ owner_user_id: bob.id })
        .eq("id", alice.workspaceId);
      expect(selfOwner.error).not.toBeNull();
      const membership = await bob.client.from("workspace_members").insert({
        workspace_id: carol.workspaceId,
        user_id: bob.id,
        role: "owner",
      });
      expect(membership.error).not.toBeNull();
      const revoke = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${alice.workspaceId}/members/${bob.id}`,
        headers: headers(alice),
        payload: {},
      });
      expect(revoke.statusCode, revoke.body).toBe(200);
      const denied = await app.inject({
        url: "/api/bootstrap",
        headers: headers(bob, alice.workspaceId),
      });
      expect(denied.statusCode).toBe(403);
      const rows = await bob.client
        .from("opportunities")
        .select("id")
        .eq("workspace_id", alice.workspaceId);
      expect(rows.data).toEqual([]);
    });
    it("keeps account administration separate from workspace membership", async () => {
      const denied = await app.inject({
        url: "/api/admin/users",
        headers: headers(bob),
      });
      expect(denied.statusCode).toBe(403);
      const escalation = await bob.client
        .from("app_admins")
        .insert({ user_id: bob.id });
      expect(escalation.error).not.toBeNull();
      const grant = await db.from("app_admins").insert({ user_id: alice.id });
      expect(grant.error).toBeNull();
      try {
        const list = await app.inject({
          url: "/api/admin/users",
          headers: headers(alice),
        });
        expect(list.statusCode, list.body).toBe(200);
        const noWorkspace = await app.inject({
          url: "/api/bootstrap",
          headers: headers(alice, carol.workspaceId),
        });
        expect(noWorkspace.statusCode).toBe(403);
        const email = `roleloop-admin-created-${randomUUID()}@roleloop.test`;
        const create = await app.inject({
          method: "POST",
          url: "/api/admin/users",
          headers: headers(alice),
          payload: {
            email,
            password: randomBytes(24).toString("base64url"),
            name: "Created test account",
          },
        });
        expect(create.statusCode, create.body).toBe(200);
        users.push(create.json().id);
        expect(create.json()).not.toHaveProperty("password");
      } finally {
        await db.from("app_admins").delete().eq("user_id", alice.id);
      }
    });
    it("rejects setup takeover without the local secret", async () => {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/account/claim-owner",
        headers: headers(bob),
        payload: { token: randomBytes(32).toString("base64url") },
      });
      expect(invalid.statusCode).toBe(403);
      const direct = await bob.client.rpc("claim_initial_owner", {
        owner_uuid: bob.id,
        token_digest: "0".repeat(64),
      });
      expect(direct.error).not.toBeNull();
    });
    it("protects stored documents with workspace membership and immediate revocation", async () => {
      const path = `${alice.workspaceId}/drafts/${randomUUID()}/test.txt`;
      const created = await db.storage
        .from("documents")
        .upload(path, Buffer.from("Private Alice document"), {
          contentType: "text/plain",
        });
      expect(created.error).toBeNull();
      try {
        const own = await alice.client.storage.from("documents").download(path);
        expect(own.error).toBeNull();
        const denied = await bob.client.storage
          .from("documents")
          .download(path);
        expect(denied.error).not.toBeNull();
        await app.inject({
          method: "POST",
          url: `/api/workspaces/${alice.workspaceId}/members`,
          headers: headers(alice),
          payload: { email: bob.email },
        });
        const shared = await bob.client.storage
          .from("documents")
          .download(path);
        expect(shared.error).toBeNull();
        await app.inject({
          method: "DELETE",
          url: `/api/workspaces/${alice.workspaceId}/members/${bob.id}`,
          headers: headers(alice),
          payload: {},
        });
        const revoked = await bob.client.storage
          .from("documents")
          .download(path);
        expect(revoked.error).not.toBeNull();
        const ownUpload = await bob.client.storage
          .from("documents")
          .upload(`${alice.workspaceId}/intrusion.txt`, Buffer.from("No"));
        expect(ownUpload.error).not.toBeNull();
      } finally {
        await db.storage.from("documents").remove([path]);
      }
    }, 20000);
  },
);
