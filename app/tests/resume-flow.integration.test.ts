import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { FastifyInstance } from "fastify";
import { demoWorkspace, demoOpportunities } from "./fixtures.js";
import { createDraft } from "../src/domain/templates.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { resumePdf } from "../src/server/documents.js";
const integration = process.env.ROLELOOP_INTEGRATION === "1" ? it : it.skip;
const quote =
  "Built and maintained a TypeScript and React application for an internal operations team.";
vi.mock("../src/server/ai.js", () => ({
  structuredAI: vi.fn(
    async (_schema, _name, _instructions, input: { text: string }) => {
      if (!input.text.includes(quote))
        throw new Error("Original document text was not extracted");
      return {
        name: "Alex Morgan",
        portfolio: "",
        skills: ["TypeScript", "React"],
        uncertainties: ["Confirm employment dates."],
        entries: [
          {
            text: quote,
            role: "",
            company: "",
            period: "",
            category: "experience",
            skills: ["TypeScript", "React"],
          },
        ],
      };
    },
  ),
}));

integration(
  "imports PDF and Word, reviews facts, and isolates originals between workspaces",
  async () => {
    const { db } = await import("../src/server/store.js");
    const { authClient } = await import("../src/server/auth.js");
    const { buildServer } = await import("../src/server/index.js");
    const app = await buildServer();
    const users: string[] = [],
      workspaces: string[] = [],
      objects: string[] = [];
    async function actor() {
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
      return {
        workspaceId,
        email,
        headers: { ...headers, "x-workspace-id": workspaceId },
      };
    }
    try {
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
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      );
      zip.file(
        "word/document.xml",
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alex Morgan ${quote}</w:t></w:r></w:p></w:body></w:document>`,
      );
      const docx = await zip.generateAsync({ type: "nodebuffer" });
      for (const [name, buffer] of [
        ["resume.pdf", pdf],
        ["resume.docx", docx],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/api/profile/import",
          headers: alice.headers,
          payload: { name, data: buffer.toString("base64") },
        });
        expect(response.statusCode, response.body).toBe(200);
        const imported = response.json();
        expect(imported.profile.email).toBe(alice.email);
        const source = imported.profile.source;
        objects.push(
          `${alice.workspaceId}/resumes/${source.id}/original.${source.kind}`,
        );
        expect(imported.profile.evidence[0]).toMatchObject({
          text: quote,
          verified: false,
        });
        expect(imported.warnings).toContain("Confirm employment dates.");
        const before = await app.inject({
          url: "/api/bootstrap",
          headers: alice.headers,
        });
        expect(before.json().profile.source).toBeNull();
        const downloadUrl = `/api/profile/sources/${source.id}/${source.kind}`;
        const own = await app.inject({
          url: downloadUrl,
          headers: alice.headers,
        });
        expect(own.statusCode).toBe(200);
        expect(own.rawPayload).toEqual(buffer);
        const other = await app.inject({
          url: downloadUrl,
          headers: bob.headers,
        });
        expect(other.statusCode).toBe(404);
        const escaped = await app.inject({
          url: downloadUrl,
          headers: { ...bob.headers, "x-workspace-id": alice.workspaceId },
        });
        expect(escaped.statusCode).toBe(403);
        const profile = {
          ...imported.profile,
          email: "forged@example.test",
          headline: "Old",
          summary: "Old",
          learning: "Old",
          evidence: imported.profile.evidence.map((e: object) => ({
            ...e,
            verified: true,
          })),
        };
        const saved = await app.inject({
          method: "PUT",
          url: "/api/profile",
          headers: alice.headers,
          payload: profile,
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json().email).toBe(alice.email);
        expect(saved.json()).not.toHaveProperty("headline");
        const stored = await db
          .from("workspace")
          .select("payload")
          .eq("id", alice.workspaceId)
          .single();
        for (const field of [
          "email",
          "headline",
          "summary",
          "learning",
          "skills",
        ])
          expect(stored.data!.payload.profile).not.toHaveProperty(field);
        const snapshot = await db.storage
          .from("documents")
          .list(`${alice.workspaceId}/profile-versions`);
        for (const file of snapshot.data || [])
          objects.push(`${alice.workspaceId}/profile-versions/${file.name}`);
        const loaded = await app.inject({
          url: "/api/bootstrap",
          headers: alice.headers,
        });
        expect(loaded.json().profile.source.id).toBe(source.id);
        // Reset the current profile to prove the next import remains a preview.
        await db
          .from("workspace")
          .update({
            payload: {
              ...workspace,
              profile: { ...workspace.profile, source: null },
            },
          })
          .eq("id", alice.workspaceId);
      }
      const denied = await app.inject({
        method: "POST",
        url: "/api/profile/import",
        headers: { ...bob.headers, "x-workspace-id": alice.workspaceId },
        payload: { name: "bad.pdf", data: "YWJj" },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      if (objects.length)
        await db.storage.from("documents").remove([...new Set(objects)]);
      for (const workspaceId of workspaces)
        await db.from("workspace").delete().eq("id", workspaceId);
      for (const id of users) await db.auth.admin.deleteUser(id);
      await app.close();
    }
  },
  30000,
);
