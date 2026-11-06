import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { FastifyInstance } from "fastify";
import { demoWorkspace, demoOpportunities } from "./fixtures.js";
import { createDraft } from "../src/domain/templates.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { resumePdf } from "../src/server/documents.js";
import { careerFacts, type Profile } from "../src/shared/types.js";
import { structuredAI } from "../src/server/ai.js";
import { normalizeText, readResume } from "../src/server/resume-import.js";
import { assertFresh } from "../src/server/guards.js";
const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;
const quote =
  "Built and maintained a TypeScript and React application for an internal operations team.";
const replacementQuote =
  "Developed Python services and PostgreSQL data models for a research team.";
vi.mock("../src/server/ai.js", () => ({ structuredAI: vi.fn() }));
const extracted = (lines: { id: number; text: string }[]) => {
  const text = normalizeText(lines.map((line) => line.text).join("\n"));
  const entry = text.includes(normalizeText(replacementQuote))
    ? replacementQuote
    : quote;
  const ranges: { startLine: number; endLine: number; length: number }[] = [];
  for (let start = 0; start < lines.length; start++) {
    for (let end = start; end < Math.min(start + 5, lines.length); end++) {
      const value = normalizeText(
        lines
          .slice(start, end + 1)
          .map((line) => line.text)
          .join("\n"),
      );
      if (value.includes(normalizeText(entry)))
        ranges.push({
          startLine: lines[start].id,
          endLine: lines[end].id,
          length: value.length,
        });
    }
  }
  const range = ranges.sort((a, b) => a.length - b.length)[0];
  if (!range) throw new Error("Original document text was not extracted");
  return {
    name: "Alex Morgan",
    portfolio: "",
    uncertainties: ["Employment dates were not supplied."],
    entries: [
      {
        startLine: range.startLine,
        endLine: range.endLine,
        statements: [
          {
            startLine: range.startLine,
            endLine: range.endLine,
            skills:
              entry === quote
                ? ["TypeScript", "React"]
                : ["Python", "PostgreSQL"],
          },
        ],
        role: "",
        company: "",
        period: "",
        category: "experience",
      },
    ],
  };
};
async function word(text = quote) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  const escaped = text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alex Morgan</w:t></w:r></w:p><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

integration("CV upload to application generation", () => {
  let app: FastifyInstance;
  let db: typeof import("../src/server/store.js").db;
  const users: string[] = [],
    workspaces: string[] = [];
  async function actor() {
    const { authClient } = await import("../src/server/auth.js");
    const email = `resume-${randomUUID()}@example.test`,
      password = randomUUID() + "aA1!";
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
    const headers = {
      host: "127.0.0.1:4310",
      authorization: `Bearer ${session.data.session!.access_token}`,
      "content-type": "application/json",
    };
    const context = await app.inject({ url: "/api/account", headers });
    const workspaceId = context.json().workspaces[0].id;
    workspaces.push(workspaceId);
    const { createWorkspaceStore } = await import("../src/server/store.js");
    return {
      workspaceId,
      email,
      headers: { ...headers, "x-workspace-id": workspaceId },
      store: createWorkspaceStore({
        workspaceId,
        client: authClient(session.data.session!.access_token),
        actorUserId: created.data.user.id,
      }),
    };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;
  async function upload(who: Actor, buffer: Buffer, name = "master.docx") {
    return app.inject({
      method: "POST",
      url: "/api/profile/import",
      headers: who.headers,
      payload: { name, data: buffer.toString("base64") },
    });
  }
  function resetAI() {
    vi.mocked(structuredAI).mockReset();
    vi.mocked(structuredAI).mockImplementation(
      async (_schema, name, _instructions, input) => {
        if (name !== "resume_import")
          throw new Error("Use deterministic matching for this test");
        return extracted(
          (input as { lines: { id: number; text: string }[] }).lines,
        );
      },
    );
  }
  beforeAll(async () => {
    ({ db } = await import("../src/server/store.js"));
    const { buildServer } = await import("../src/server/index.js");
    app = await buildServer();
  });
  afterAll(async () => {
    try {
      for (const workspaceId of workspaces) {
        const versions = await db.storage
          .from("documents")
          .list(`${workspaceId}/resumes`);
        for (const version of versions.data || []) {
          const files = await db.storage
            .from("documents")
            .list(`${workspaceId}/resumes/${version.name}`);
          const paths = (files.data || []).map(
            (f) => `${workspaceId}/resumes/${version.name}/${f.name}`,
          );
          if (paths.length) await db.storage.from("documents").remove(paths);
        }
        await db.from("drafts").delete().eq("workspace_id", workspaceId);
        await db.from("opportunities").delete().eq("workspace_id", workspaceId);
        await db.from("workspace").delete().eq("id", workspaceId);
      }
      for (const id of users) await db.auth.admin.deleteUser(id);
    } finally {
      await app.close();
    }
  }, 30000);

  it("activates PDF and Word facts once, keeps originals private, and rejects independent profile edits", async () => {
    resetAI();
    const alice = await actor(),
      bob = await actor();
    const workspace = demoWorkspace(),
      job = demoOpportunities()[0];
    const pdf = await resumePdf(
      createDraft(
        job,
        workspace.profile,
        workspace.preferences,
        assessOpportunity(job, workspace.profile, workspace.preferences),
      ),
    );
    for (const [name, buffer] of [
      ["master.pdf", pdf],
      ["master.docx", await word()],
    ] as const) {
      const response = await upload(alice, buffer, name);
      expect(response.statusCode, response.body).toBe(200);
      const profile: Profile = response.json().profile;
      expect(profile.email).toBe(alice.email);
      expect(profile.cache).toMatchObject({
        status: "ready",
        sourceId: profile.source!.id,
        warnings: ["Employment dates were not supplied."],
      });
      const evidence = careerFacts(profile)!.evidence[0];
      expect(evidence.verified).toBe(true);
      expect(normalizeText(evidence.text)).toContain(normalizeText(quote));
      const originalText = (await readResume(name, buffer)).text;
      expect(
        originalText.slice(evidence.source!.start, evidence.source!.end),
      ).toBe(evidence.text);
      expect(careerFacts(profile)!.sections[0].evidenceIds).toEqual([
        evidence.id,
      ]);
      expect(profile.source!.sha256).toBe(
        createHash("sha256").update(buffer).digest("hex"),
      );
      const loaded = await app.inject({
        url: "/api/bootstrap",
        headers: alice.headers,
      });
      expect(loaded.json().profile).toEqual(profile);
      const url = `/api/profile/sources/${profile.source!.id}/${profile.source!.kind}`;
      const own = await app.inject({ url, headers: alice.headers });
      expect(own.rawPayload).toEqual(buffer);
      const preview = await app.inject({
        url: `${url}?preview=1`,
        headers: alice.headers,
      });
      expect(preview.statusCode).toBe(200);
      if (name.endsWith(".pdf"))
        expect(preview.headers["content-disposition"]).toContain("inline");
      else expect(preview.body).toContain(quote);
      expect((await app.inject({ url, headers: bob.headers })).statusCode).toBe(
        404,
      );
      expect(
        (
          await app.inject({
            url,
            headers: { ...bob.headers, "x-workspace-id": alice.workspaceId },
          })
        ).statusCode,
      ).toBe(403);
      const publicDownload = await db.storage
        .from("documents")
        .getPublicUrl(
          `${alice.workspaceId}/resumes/${profile.source!.id}/original.${profile.source!.kind}`,
        );
      expect((await fetch(publicDownload.data.publicUrl)).ok).toBe(false);
      const calls = vi.mocked(structuredAI).mock.calls.length;
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/profile/process",
            headers: alice.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(vi.mocked(structuredAI).mock.calls).toHaveLength(calls);
      const edited = await app.inject({
        method: "PUT",
        url: "/api/profile",
        headers: alice.headers,
        payload: { ...profile, name: "Invented", evidence: [] },
      });
      expect(edited.statusCode).toBe(405);
      const stored = await db
        .from("workspace")
        .select("payload")
        .eq("id", alice.workspaceId)
        .single();
      expect(Object.keys(stored.data!.payload.profile).sort()).toEqual([
        "cache",
        "source",
      ]);
    }
    expect(
      vi
        .mocked(structuredAI)
        .mock.calls.filter((c) => c[1] === "resume_import"),
    ).toHaveLength(2);
  }, 30000);

  it("reuses facts for targeted drafts, rejects stale approvals, and preserves documents and history on replacement", async () => {
    resetAI();
    const alice = await actor();
    const imported = await upload(alice, await word());
    expect(imported.statusCode, imported.body).toBe(200);
    const { processRun } = await import("../src/server/service.js");
    for (const [company, title] of [
      ["Interface Co", "Frontend Engineer"],
      ["Product Co", "Product Engineer"],
    ]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/opportunities",
        headers: alice.headers,
        payload: {
          ...demoOpportunities()[0],
          company,
          title,
          requirements: [
            {
              id: "react",
              text: "Build React interfaces",
              skills: ["React"],
              essential: true,
            },
          ],
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const queued = await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: alice.headers,
        payload: { action: "draft", opportunityId: created.json().id },
      });
      expect(queued.statusCode, queued.body).toBe(200);
      const run = await alice.store.get("runs", queued.json().id);
      await processRun(alice.store, run, async () => {});
    }
    const drafts = await alice.store.list("drafts");
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      const op = await alice.store.get("opportunities", draft.opportunityId);
      expect(draft.resume).toContain(
        `Application: ${op.title} at ${op.company}`,
      );
      expect(draft.resume).toContain(
        `Relevant experience for ${op.title} at ${op.company}`,
      );
      expect(draft.resume).toContain(quote);
      expect(draft.resume).toContain(alice.email);
      expect(draft.resume).not.toContain("alex@example.com");
    }
    expect(
      vi
        .mocked(structuredAI)
        .mock.calls.filter((c) => c[1] === "resume_import"),
    ).toHaveLength(1);
    const history = await alice.store.list("events");
    const oldSource = (await alice.store.getWorkspace()).profile.source!;
    const replaced = await upload(alice, await word(replacementQuote));
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().profile.source.id).not.toBe(oldSource.id);
    expect(careerFacts(replaced.json().profile)!.evidence[0].text).toBe(
      replacementQuote,
    );
    expect(await alice.store.list("drafts")).toEqual(drafts);
    expect(await alice.store.list("events")).toEqual(
      expect.arrayContaining(history),
    );
    expect(
      (
        await app.inject({
          url: `/api/drafts/${drafts[0].id}/download?format=txt`,
          headers: alice.headers,
        })
      ).body,
    ).toContain(quote);
    const oldOpportunity = await alice.store.get(
      "opportunities",
      drafts[0].opportunityId,
    );
    const currentWorkspace = await alice.store.getWorkspace();
    expect(() =>
      assertFresh(drafts[0], oldOpportunity, currentWorkspace),
    ).toThrow("changed");
    expect(
      (
        await app.inject({
          url: `/api/profile/sources/${oldSource.id}/${oldSource.kind}`,
          headers: alice.headers,
        })
      ).statusCode,
    ).toBe(200);
    const refreshed = await app.inject({
      url: "/api/bootstrap",
      headers: alice.headers,
    });
    expect(
      refreshed
        .json()
        .opportunities.every(
          (op: { assessment: { matches: { status: string }[] } }) =>
            op.assessment.matches.every((m) => m.status === "missing"),
        ),
    ).toBe(true);
  }, 30000);

  it("clears old facts during processing, retains failed originals, and safely retries", async () => {
    resetAI();
    const alice = await actor();
    await upload(alice, await word());
    let fail!: (error: Error) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(structuredAI).mockImplementationOnce(async () => {
      started();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    const pending = upload(alice, await word(replacementQuote));
    await waiting;
    const processing = (await alice.store.getWorkspace()).profile;
    expect(processing.cache?.status).toBe("processing");
    expect(processing.cache?.facts).toBeNull();
    expect(careerFacts(processing)).toBeNull();
    expect(() =>
      createDraft(
        demoOpportunities()[0],
        processing,
        demoWorkspace().preferences,
        assessOpportunity(
          demoOpportunities()[0],
          processing,
          demoWorkspace().preferences,
        ),
      ),
    ).toThrow("finish processing");
    fail(new Error("Extraction temporarily unavailable"));
    const failed = await pending;
    expect(failed.json().profile.cache).toMatchObject({
      status: "failed",
      facts: null,
      error: "Extraction temporarily unavailable",
    });
    const source = failed.json().profile.source;
    expect(
      (
        await app.inject({
          url: `/api/profile/sources/${source.id}/${source.kind}`,
          headers: alice.headers,
        })
      ).statusCode,
    ).toBe(200);
    const retried = await app.inject({
      method: "POST",
      url: "/api/profile/process",
      headers: alice.headers,
      payload: {},
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().profile.source.id).toBe(source.id);
    expect(careerFacts(retried.json().profile)!.evidence[0].text).toBe(
      replacementQuote,
    );
    const invalid = await upload(alice, Buffer.from("corrupt"), "invalid.pdf");
    expect(invalid.statusCode).toBe(422);
    expect((await alice.store.getWorkspace()).profile).toEqual(
      retried.json().profile,
    );
  }, 30000);

  it("rejects late extraction results after a newer CV has won", async () => {
    resetAI();
    const alice = await actor();
    let finish!: (value: ReturnType<typeof extracted>) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(structuredAI).mockImplementationOnce(async () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const older = upload(alice, await word());
    await waiting;
    const newer = await upload(alice, await word(replacementQuote));
    expect(newer.statusCode, newer.body).toBe(200);
    finish(
      extracted([
        { id: 1, text: "Alex Morgan" },
        { id: 2, text: quote },
      ]),
    );
    const late = await older;
    expect(late.statusCode, late.body).toBe(409);
    expect((await alice.store.getWorkspace()).profile).toEqual(
      newer.json().profile,
    );
  }, 30000);
});
