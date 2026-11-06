import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CV_EXTRACTOR_VERSION, type Profile } from "../src/shared/types.js";
import { processCV } from "../src/server/cv.js";
import { extractFacts } from "../src/server/resume-import.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { createDraft } from "../src/domain/templates.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { assertFresh } from "../src/server/guards.js";

vi.mock("../src/server/resume-import.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/resume-import.js")>()),
  extractFacts: vi.fn(),
}));

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

integration("clearing extracted resume information", () => {
  let app: FastifyInstance;
  let db: typeof import("../src/server/store.js").db;
  const users: string[] = [],
    workspaces: string[] = [],
    originals: string[] = [];

  async function actor() {
    const { authClient } = await import("../src/server/auth.js");
    const email = `resume-clear-${randomUUID()}@example.test`;
    const password = `${randomUUID()}aA1!`;
    const created = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    const userId = created.data.user.id;
    users.push(userId);
    const session = await authClient().auth.signInWithPassword({
      email,
      password,
    });
    if (session.error) throw session.error;
    const headers = {
      host: "127.0.0.1:4310",
      authorization: `Bearer ${session.data.session!.access_token}`,
      "content-type": "application/json",
    };
    const account = await app.inject({ url: "/api/account", headers });
    const workspaceId = account.json().workspaces[0].id;
    workspaces.push(workspaceId);
    const { createWorkspaceStore } = await import("../src/server/store.js");
    return {
      userId,
      workspaceId,
      headers: { ...headers, "x-workspace-id": workspaceId },
      store: createWorkspaceStore({
        workspaceId,
        client: authClient(session.data.session!.access_token),
        actorUserId: userId,
      }),
    };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;

  async function seed(who: Actor) {
    const profile = structuredClone(demoWorkspace().profile);
    const sourceId = randomUUID();
    profile.source = { ...profile.source!, id: sourceId };
    profile.cache = {
      ...profile.cache!,
      id: randomUUID(),
      sourceId,
      extractorVersion: CV_EXTRACTOR_VERSION,
    };
    return (await who.store.updateWorkspace({ profile })).profile;
  }
  const clear = (who: Actor, profile: Profile) =>
    app.inject({
      method: "DELETE",
      url: "/api/profile/cache",
      headers: who.headers,
      payload: {
        sourceId: profile.source?.id ?? null,
        cacheId: profile.cache?.id ?? null,
      },
    });

  beforeAll(async () => {
    ({ db } = await import("../src/server/store.js"));
    const { buildServer } = await import("../src/server/index.js");
    app = await buildServer();
  });
  afterAll(async () => {
    try {
      if (originals.length)
        await db.storage.from("documents").remove(originals);
      for (const workspaceId of workspaces) {
        await db.from("drafts").delete().eq("workspace_id", workspaceId);
        await db.from("opportunities").delete().eq("workspace_id", workspaceId);
        await db.from("workspace").delete().eq("id", workspaceId);
      }
      for (const id of users) await db.auth.admin.deleteUser(id);
    } finally {
      await app.close();
    }
  }, 30000);

  it("clears only this workspace's cache, retaining its original, preferences and saved drafts", async () => {
    const alice = await actor(),
      bob = await actor();
    const profile = await seed(alice),
      otherProfile = await seed(bob);
    const workspace = await alice.store.getWorkspace();
    const original = Buffer.from(
      "Private original resume retained for reprocessing.",
    );
    const path = `${alice.workspaceId}/resumes/${profile.source!.id}/original.${profile.source!.kind}`;
    const saved = await alice.store.db.storage
      .from("documents")
      .upload(path, original);
    if (saved.error) throw saved.error;
    originals.push(path);
    const opportunity = { ...demoOpportunities()[0], id: randomUUID() };
    await alice.store.save("opportunities", opportunity);
    const draft = createDraft(
      opportunity,
      profile,
      workspace.preferences,
      assessOpportunity(opportunity, profile, workspace.preferences),
    );
    await alice.store.save("drafts", draft);

    const forbidden = await app.inject({
      method: "DELETE",
      url: "/api/profile/cache",
      headers: { ...bob.headers, "x-workspace-id": alice.workspaceId },
      payload: { sourceId: profile.source!.id, cacheId: profile.cache!.id },
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await alice.store.getWorkspace()).profile.cache).not.toBeNull();

    const response = await clear(alice, profile);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().profile).toMatchObject({
      source: profile.source,
      cache: null,
    });
    const current = await alice.store.getWorkspace();
    expect(current.preferences).toEqual(workspace.preferences);
    expect(await alice.store.get("drafts", draft.id)).toEqual(draft);
    expect(() => assertFresh(draft, opportunity, current)).toThrow(/changed/);
    expect((await bob.store.getWorkspace()).profile).toEqual(otherProfile);
    const download = await app.inject({
      url: `/api/profile/sources/${profile.source!.id}/${profile.source!.kind}`,
      headers: alice.headers,
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(original);
  });

  it("rejects stale clears after replacement or reprocessing and requires explicit revision identifiers", async () => {
    const alice = await actor();
    const previous = await seed(alice),
      replacement = await seed(alice);
    expect((await clear(alice, previous)).statusCode).toBe(409);
    expect((await alice.store.getWorkspace()).profile).toEqual(replacement);
    const reprocessed = structuredClone(replacement);
    reprocessed.cache!.id = randomUUID();
    await alice.store.updateWorkspace({ profile: reprocessed });
    expect((await clear(alice, replacement)).statusCode).toBe(409);
    expect((await alice.store.getWorkspace()).profile).toEqual(reprocessed);
    const invalid = await app.inject({
      method: "DELETE",
      url: "/api/profile/cache",
      headers: alice.headers,
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("does not let an in-flight extraction restore a cleared cache", async () => {
    const alice = await actor(),
      profile = await seed(alice);
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extracting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(extractFacts).mockImplementationOnce(async () => {
      entered();
      await pending;
      return { facts: profile.cache!.facts!, warnings: [] };
    });
    const processing = processCV(
      alice.store,
      profile,
      "Source text",
      alice.userId,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await extracting;
    try {
      const inFlight = (await alice.store.getWorkspace()).profile;
      expect(inFlight.cache?.status).toBe("processing");
      const response = await clear(alice, inFlight);
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      release();
    }
    expect(await processing).toMatchObject({ statusCode: 409 });
    expect((await alice.store.getWorkspace()).profile).toMatchObject({
      source: profile.source,
      cache: null,
    });
  });

  it("migrates obsolete caches while preserving V2 sections and unrelated records", () => {
    const migration = readFileSync(
      new URL(
        "../supabase/migrations/20261106000200_structured_resume_facts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const output = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_roleloop-ts",
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      {
        input: `begin;
        alter table public.workspace disable trigger clean_workspace_profile;
        insert into public.workspace (id, payload) values
          ('integration-v2-obsolete', '{"profile":{"source":{"id":"source-a"},"cache":{"sourceId":"source-a","extractorVersion":1,"facts":{"name":"Old"}}},"preferences":{"country":"Ecuador"}}'),
          ('integration-v2-current', '{"profile":{"source":{"id":"source-b"},"cache":{"sourceId":"source-b","extractorVersion":2,"facts":{"sections":[{"id":"section-a","sourceText":"Original text","evidenceIds":["fact-a"]}],"evidence":[{"id":"fact-a","source":{"start":0,"end":13}}]}}},"preferences":{"country":"Ecuador"}}'),
          ('integration-v2-mismatch', '{"profile":{"source":{"id":"source-c"},"cache":{"sourceId":"source-old","extractorVersion":2}}}');
        alter table public.workspace enable trigger clean_workspace_profile;
        create temp table v2_current_before as select payload from public.workspace where id='integration-v2-current';
        create temp table v2_history_before as
          select 'draft' as kind, id, to_jsonb(drafts) as record from public.drafts
          union all select 'event', id, to_jsonb(events) from public.events
          union all select 'object', id::text, to_jsonb(objects) from storage.objects;
        ${migration}
        do $$ begin
          if (select payload->'profile' from public.workspace where id='integration-v2-obsolete') is distinct from '{"source":{"id":"source-a"},"cache":null}'::jsonb
          then raise exception 'Obsolete cache was not cleared'; end if;
          if (select payload from public.workspace where id='integration-v2-current') is distinct from (select payload from v2_current_before)
          then raise exception 'Current sections or source offsets changed'; end if;
          if (select payload#>'{profile,cache}' from public.workspace where id='integration-v2-mismatch') is distinct from 'null'::jsonb
          then raise exception 'Mismatched cache survived'; end if;
          if (select payload->'preferences' from public.workspace where id='integration-v2-obsolete') is distinct from '{"country":"Ecuador"}'::jsonb
          then raise exception 'Preferences changed'; end if;
          if exists ((select * from v2_history_before) except (
            select 'draft', id, to_jsonb(drafts) from public.drafts
            union all select 'event', id, to_jsonb(events) from public.events
            union all select 'object', id::text, to_jsonb(objects) from storage.objects))
          then raise exception 'Historical documents or activity changed'; end if;
        end $$;
        rollback;
        select 'Structured resume migration assertions passed';`,
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(output).toContain("Structured resume migration assertions passed");
  }, 25000);
});
