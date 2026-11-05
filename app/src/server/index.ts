import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { appDir, settings } from "./config.js";
import {
  OpportunitySchema,
  PreferencesSchema,
  ProfileSchema,
  SourceSchema,
} from "../shared/types.js";
import * as store from "./store.js";
import * as service from "./service.js";
import { allowedOrigin } from "./guards.js";
import { emailFile, resumePdf } from "./documents.js";

export async function buildServer() {
  const app = Fastify({ bodyLimit: 250_000, logger: false });
  app.addHook("onRequest", async (req, reply) => {
    if (
      !allowedOrigin(
        req.headers.origin,
        req.headers.host,
        settings.appUrl,
        settings.apiPort,
      )
    )
      return reply
        .code(403)
        .send({
          error: "Only requests from the local RoleLoop app are allowed.",
        });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return reply
        .code(403)
        .send({ error: "Cross-site requests are disabled." });
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return reply.code(415).send({ error: "Use application/json." });
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          error: error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
    const err = error as Error & { statusCode?: number };
    reply
      .code(err.statusCode || 500)
      .send({ error: err.message || "Request failed" });
  });
  app.get("/api/health", async () => ({ ok: true, testMode: true }));
  app.get("/api/bootstrap", async () => service.bootstrap());
  app.put("/api/profile", async (req) => {
    const profile = ProfileSchema.parse(req.body);
    const previous = (await store.getWorkspace()).profile;
    await store.updateWorkspace({ profile });
    if (JSON.stringify(previous) !== JSON.stringify(profile)) {
      await service.invalidateDrafts();
      await service.refreshAssessments();
    }
    await store.event("Profile saved. Existing draft approvals were cleared.");
    return profile;
  });
  app.put("/api/preferences", async (req) => {
    const preferences = PreferencesSchema.parse(req.body);
    try {
      new Intl.DateTimeFormat("en", {
        timeZone: preferences.timezone,
      }).format();
    } catch {
      throw Object.assign(
        new Error("Enter a valid IANA timezone, such as America/Guayaquil."),
        { statusCode: 400 },
      );
    }
    if (preferences.targetSalary < preferences.minimumSalary)
      throw Object.assign(
        new Error("Target salary must be at least the minimum salary."),
        { statusCode: 400 },
      );
    const old = (await store.getWorkspace()).preferences;
    await store.updateWorkspace({ preferences });
    if (JSON.stringify(old) !== JSON.stringify(preferences)) {
      await service.invalidateDrafts();
      await service.refreshAssessments();
    }
    await store.event("Search and automation preferences saved.");
    return preferences;
  });
  app.put("/api/sources", async (req) => {
    const { sources } = z
      .object({ sources: z.array(SourceSchema).max(50) })
      .parse(req.body);
    if (new Set(sources.map((s) => s.id)).size !== sources.length)
      throw Object.assign(new Error("Source IDs must be unique."), {
        statusCode: 400,
      });
    await store.updateWorkspace({ sources });
    return sources;
  });
  app.post("/api/seed", async () => service.seed());
  const manual = z
    .object({
      kind: z.enum(["job", "startup"]),
      company: z.string().min(1).max(200),
      title: z.string().min(1).max(300),
      description: z.string().min(1).max(50000),
      url: z.string().url().max(2000),
    })
    .passthrough();
  const editable = OpportunitySchema.pick({
    company: true,
    title: true,
    description: true,
    url: true,
    companyUrl: true,
    location: true,
    companyCountry: true,
    remoteScope: true,
    salaryMin: true,
    salaryMax: true,
    salaryCurrency: true,
    salaryPeriod: true,
    publishedAt: true,
    requirements: true,
    signals: true,
    contactName: true,
    contactEmail: true,
    contactSource: true,
    notes: true,
    stage: true,
  }).partial();
  app.post("/api/opportunities", async (req) => {
    const input = manual.parse(req.body),
      id = randomUUID(),
      now = new Date().toISOString();
    const op = OpportunitySchema.parse({
      ...editable.parse(input),
      kind: input.kind,
      id,
      source: "Manual entry",
      sourceKey: `manual:${id}`,
      isDemo: false,
      stage: "new",
      assessment: null,
      firstSeenAt: now,
      updatedAt: now,
    });
    await store.save("opportunities", op);
    return service.analyze(op, await store.getWorkspace());
  });
  app.patch<{ Params: { id: string } }>(
    "/api/opportunities/:id",
    async (req) => {
      const existing = await store.get("opportunities", req.params.id);
      const patch = editable.parse(req.body);
      const saved = OpportunitySchema.parse({
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      const { stage: _stage, ...corrections } = patch;
      await store.setRuntime(`corrections:${existing.id}`, {
        ...((await store.runtime(`corrections:${existing.id}`)) as object),
        ...corrections,
      });
      await store.save("opportunities", saved);
      await service.invalidateDrafts(saved.id);
      return service.analyze(saved, await store.getWorkspace());
    },
  );
  app.post("/api/runs", async (req) => {
    const run = service.RunInput.parse(req.body);
    if (run.action === "simulate")
      throw Object.assign(new Error("Use the draft test endpoint."), {
        statusCode: 400,
      });
    return service.enqueue(run);
  });
  app.post<{ Params: { id: string } }>("/api/drafts/:id/approve", async (req) =>
    service.approve(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/drafts/:id/simulate",
    async (req) => {
      const draft = await store.get("drafts", req.params.id);
      return service.enqueue({
        action: "simulate",
        opportunityId: draft.opportunityId,
        draftId: draft.id,
      });
    },
  );
  app.patch<{ Params: { id: string } }>("/api/drafts/:id", async (req) =>
    service.editDraft(req.params.id, req.body),
  );
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/drafts/:id/download",
    async (req, reply) => {
      const draft = await store.get("drafts", req.params.id),
        op = await store.get("opportunities", draft.opportunityId),
        workspace = await store.getWorkspace();
      const format = z
        .enum(["pdf", "eml", "json", "txt"])
        .parse(req.query.format || "txt");
      const filename = `roleloop-${draft.id.replace(/[^a-zA-Z0-9-]/g, "")}.${format}`;
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      if (format === "pdf")
        return reply.type("application/pdf").send(await resumePdf(draft));
      if (format === "eml")
        return reply
          .type("message/rfc822")
          .send(await emailFile(draft, op, workspace.profile));
      if (format === "json")
        return reply
          .type("application/json")
          .send(JSON.stringify(draft, null, 2));
      return reply
        .type("text/plain; charset=utf-8")
        .send(
          [
            draft.subject,
            draft.body,
            draft.resume,
            draft.coverLetter,
            ...draft.answers.map((a) => `${a.question}\n${a.answer}`),
          ]
            .filter(Boolean)
            .join("\n\n———\n\n"),
        );
    },
  );
  if (process.argv.includes("--production")) {
    await app.register(fastifyStatic, { root: resolve(appDir, "dist") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "API route not found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
if (!process.env.VITEST) {
  const app = await buildServer();
  await store.getWorkspace();
  await app.listen({ host: "127.0.0.1", port: settings.apiPort });
  console.log(
    `RoleLoop API listening at http://127.0.0.1:${settings.apiPort} • local test mode`,
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => void app.close().then(() => process.exit(0)));
}
