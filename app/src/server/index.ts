import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { z } from "zod";
import { appDir, settings } from "./config.js";
import {
  OpportunitySchema,
  PreferencesSchema,
  SourceSchema,
} from "../shared/types.js";
import type { WorkspaceStore } from "./store.js";
import * as auth from "./auth.js";
import * as service from "./service.js";
import { allowedOrigin } from "./guards.js";
import { UploadSchema, readResume } from "./resume-import.js";
import * as chatgpt from "./chatgpt.js";
import {
  uploadCV,
  retryCV,
  clearCVFacts,
  originalCV,
  cvContentType,
} from "./cv.js";
import {
  extractRequirementDetails,
  plainText,
  safeFetchText,
  remoteScope,
  publishedSalary,
} from "../domain/connectors.js";
import { normalizeSource, sourceIdentity } from "../shared/discovery.js";
import { preferencesFingerprint } from "../domain/rules.js";
import { resumePdf } from "./documents.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: auth.Identity | null;
    workspaceStore: WorkspaceStore | null;
  }
}
function identity(req: FastifyRequest) {
  if (!req.identity) throw auth.fail("Sign in to continue.", 401);
  return req.identity;
}
function requestStore(req: FastifyRequest) {
  if (!req.workspaceStore) throw auth.fail("Choose a workspace.", 400);
  return req.workspaceStore;
}

export async function buildServer() {
  const app = Fastify({ bodyLimit: 250_000, logger: false });
  app.addHook("onClose", async () => chatgpt.stopChatGPTLogins());
  app.decorateRequest("identity", null);
  app.decorateRequest("workspaceStore", null);
  app.addHook("onRequest", async (req, reply) => {
    if (
      !allowedOrigin(
        req.headers.origin,
        req.headers.host,
        settings.appUrl,
        settings.apiPort,
      )
    )
      return reply.code(403).send({
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
    const path = req.url.split("?")[0];
    if (
      path.startsWith("/api/") &&
      !["/api/health", "/api/auth/config"].includes(path)
    ) {
      req.identity = await auth.authenticate(req);
      if (
        /^\/api\/(bootstrap|profile|preferences|sources|opportunities|runs|drafts)(?:\/|$)/.test(
          path,
        )
      ) {
        req.workspaceStore = (
          await auth.workspaceAccess(
            req.identity,
            req.headers["x-workspace-id"],
          )
        ).store;
      }
    }
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    const err = error as Error & { statusCode?: number; code?: string };
    if (
      /duplicate key value violates unique constraint "opportunities_startup_identity"/.test(
        err.message,
      )
    )
      return reply.code(409).send({
        error:
          "A startup with this company website is already saved. Open the existing prospect to edit its details or add your notes.",
      });
    reply.code(err.statusCode || 500).send({
      error: err.message || "Request failed",
      ...(err.code === "WORKSPACE_ACCESS_DENIED" ? { code: err.code } : {}),
    });
  });
  app.get("/api/health", async () => ({ ok: true, testMode: true }));
  app.get("/api/auth/config", async () => ({
    supabaseUrl: settings.supabaseUrl,
    anonKey: settings.supabaseAnonKey,
  }));
  app.get("/api/account", async (req) => auth.accountContext(identity(req)));
  app.post("/api/account/claim-owner", async (req) =>
    auth.claimOwner(identity(req), req.body),
  );
  app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (req) => {
    await auth.workspaceAccess(identity(req), req.params.id);
    const { name } = z
      .object({ name: z.string().trim().min(1).max(100) })
      .parse(req.body);
    const { error } = await identity(req)
      .client.from("workspace")
      .update({ name, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (error) throw auth.fail("Could not rename this workspace.");
    return { id: req.params.id, name };
  });
  app.get<{ Querystring: { page?: string } }>("/api/admin/users", async (req) =>
    auth.adminUsers(identity(req), req.query.page),
  );
  app.post("/api/admin/users", async (req) =>
    auth.createAccount(identity(req), req.body),
  );
  app.get("/api/account/chatgpt", async (req) =>
    chatgpt.chatgptStatus(identity(req).user.id),
  );
  app.post("/api/account/chatgpt/connect", async (req) => {
    const input = z
      .object({ profileId: z.string().uuid().optional() })
      .parse(req.body);
    return chatgpt.startChatGPTLogin(identity(req).user.id, input.profileId);
  });
  app.post("/api/account/chatgpt/select", async (req) => {
    const input = z
      .object({
        profileId: z.string().uuid(),
        model: z.string().min(1).max(200).optional(),
      })
      .parse(req.body);
    await chatgpt.selectChatGPT(
      identity(req).user.id,
      input.profileId,
      input.model,
    );
    return chatgpt.chatgptStatus(identity(req).user.id);
  });
  app.post("/api/account/chatgpt/models", async (req) => {
    await chatgpt.listChatGPTModels(identity(req).user.id);
    return chatgpt.chatgptStatus(identity(req).user.id);
  });
  app.post("/api/account/chatgpt/retry", async (req) => {
    await chatgpt.retryChatGPT(identity(req).user.id);
    return chatgpt.chatgptStatus(identity(req).user.id);
  });
  app.post("/api/account/chatgpt/use-api", async (req) => {
    await chatgpt.useAPIKey(identity(req).user.id);
    return chatgpt.chatgptStatus(identity(req).user.id);
  });
  app.post("/api/account/chatgpt/disconnect", async (req) => {
    const { profileId } = z
      .object({ profileId: z.string().uuid() })
      .parse(req.body);
    return chatgpt.disconnectChatGPT(identity(req).user.id, profileId);
  });
  app.get("/api/bootstrap", async (req) => {
    const data = await service.bootstrap(requestStore(req));
    if (!identity(req).isAdmin) {
      data.status.studioUrl = "";
      data.status.mailpitUrl = "";
    }
    return data;
  });
  app.post("/api/profile/import", { bodyLimit: 2_900_000 }, async (req) => {
    const input = UploadSchema.parse(req.body);
    return {
      profile: await uploadCV(
        requestStore(req),
        input.name,
        Buffer.from(input.data, "base64"),
        identity(req).user.id,
      ),
    };
  });
  app.post("/api/profile/process", async (req) => ({
    profile: await retryCV(requestStore(req), identity(req).user.id),
  }));
  app.delete("/api/profile/cache", async (req) => ({
    profile: await clearCVFacts(
      requestStore(req),
      z
        .object({
          sourceId: z.string().uuid().nullable(),
          cacheId: z.string().uuid().nullable(),
        })
        .strict()
        .parse(req.body),
    ),
  }));
  // Retired clients cannot save career facts independently of the master CV.
  app.put("/api/profile", async (_req, reply) =>
    reply.code(405).send({
      error: "Replace the master CV to update your career information.",
    }),
  );
  app.get("/api/profile/sources/:id/:kind", async (req, reply) => {
    const { id, kind } = z
      .object({ id: z.string().uuid(), kind: z.enum(["pdf", "docx"]) })
      .parse(req.params);
    const { preview } = z
      .object({ preview: z.enum(["1"]).optional() })
      .parse(req.query);
    const buffer = await originalCV(requestStore(req), id, kind);
    if (preview && kind === "docx") {
      const { text } = await readResume("original.docx", buffer);
      const escaped = text.replace(
        /[&<>]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
      );
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>CV preview</title><style>body{font:16px/1.6 system-ui;padding:24px;white-space:pre-wrap;overflow-wrap:anywhere}</style>${escaped}`,
        );
    }
    return reply
      .header(
        "Content-Disposition",
        `${preview ? "inline" : "attachment"}; filename="original-cv.${kind}"`,
      )
      .type(cvContentType(kind))
      .send(buffer);
  });
  app.put("/api/preferences", async (req) => {
    const preferences = PreferencesSchema.parse(req.body);
    if (
      preferences.targetSalary !== null &&
      preferences.targetSalary < preferences.minimumSalary
    )
      throw Object.assign(
        new Error("Target salary must be at least the minimum salary."),
        { statusCode: 400 },
      );
    const old = (await requestStore(req).getWorkspace()).preferences;
    await requestStore(req).updateWorkspace({ preferences });
    if (preferencesFingerprint(old) !== preferencesFingerprint(preferences)) {
      await service.invalidateDrafts(requestStore(req));
      await service.refreshAssessments(requestStore(req));
    }
    await requestStore(req).event(
      "Search and automation preferences saved.",
      "info",
      undefined,
      { category: "preferences" },
    );
    return preferences;
  });
  app.put("/api/sources", async (req) => {
    const { sources, expectedRevision } = z
      .object({
        sources: z.array(SourceSchema).max(50),
        expectedRevision: z.number().int().min(0),
      })
      .parse(req.body);
    if (new Set(sources.map((s) => s.id)).size !== sources.length)
      throw Object.assign(new Error("Source IDs must be unique."), {
        statusCode: 400,
      });
    const normalized = sources.map(normalizeSource);
    if (new Set(normalized.map(sourceIdentity)).size !== normalized.length)
      throw Object.assign(
        new Error(
          "This company board or feed is already added. Edit its settings instead.",
        ),
        { statusCode: 400 },
      );
    return requestStore(req).replaceSources(normalized, expectedRevision);
  });
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
    companyId: true,
    title: true,
    description: true,
    descriptionTruncated: true,
    requirementsTruncated: true,
    url: true,
    companyUrl: true,
    location: true,
    companyCountry: true,
    companyCountrySource: true,
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
    application: true,
    outreach: true,
  }).partial();
  const startupEditable = editable.omit({ application: true }).strict();
  const jobProgress = OpportunitySchema.pick({
    stage: true,
    application: true,
  })
    .partial()
    .strict();
  app.post("/api/opportunities/capture", async (req) => {
    const { url } = z
      .object({ url: z.string().url().max(2000) })
      .parse(req.body);
    const page = await safeFetchText(url);
    const fullDescription = plainText(page.text, true);
    const description = fullDescription.slice(0, 50000);
    return {
      description,
      descriptionTruncated: fullDescription.length > 50000,
      ...extractRequirementDetails(description),
      remoteScope: remoteScope(description),
      ...publishedSalary("", fullDescription),
    };
  });
  app.post("/api/opportunities", async (req) => {
    const input = manual.parse(req.body),
      id = randomUUID(),
      now = new Date().toISOString();
    if (Object.hasOwn(input, "application") || Object.hasOwn(input, "outreach"))
      throw Object.assign(
        new Error(
          "Save the opportunity first, then add it to its tracking board.",
        ),
        { statusCode: 400 },
      );
    const op = OpportunitySchema.parse({
      ...editable.parse(input),
      ...(input.kind === "job" &&
      input.salaryMin == null &&
      input.salaryMax == null
        ? publishedSalary(input.title, input.description)
        : {}),
      ...(input.kind === "job" &&
      !(input.requirements as unknown[] | undefined)?.length
        ? extractRequirementDetails(input.description)
        : { requirements: input.requirements }),
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
    await requestStore(req).save("opportunities", op);
    await requestStore(req).event(
      `Added ${op.kind === "job" ? "job" : "startup prospect"}: ${op.title} at ${op.company}.`,
      "success",
      op.id,
      { category: "application" },
    );
    return service.analyze(
      requestStore(req),
      op,
      await requestStore(req).getWorkspace(),
    );
  });
  app.patch<{ Params: { id: string } }>(
    "/api/opportunities/:id",
    async (req) => {
      const existing = await requestStore(req).get(
        "opportunities",
        req.params.id,
      );
      const parsedPatch =
        existing.kind === "job"
          ? jobProgress.parse(req.body)
          : startupEditable.parse(req.body);
      // Optional schema defaults must not overwrite facts or progress omitted
      // from the request.
      const patch = Object.fromEntries(
        Object.keys(req.body as object)
          .filter((key) => Object.hasOwn(parsedPatch, key))
          .map((key) => [key, parsedPatch[key as keyof typeof parsedPatch]]),
      ) as z.infer<typeof editable>;
      if (patch.requirements && patch.requirementsTruncated === undefined)
        patch.requirementsTruncated = false;
      let saved = OpportunitySchema.parse({
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      if (patch.application) {
        const previous = existing.application;
        const status = patch.application.status;
        saved.application = {
          ...patch.application,
          appliedAt:
            previous?.appliedAt ??
            (["applied", "interview", "offer"].includes(status)
              ? new Date().toISOString()
              : patch.application.appliedAt),
          interviewAt:
            previous?.interviewAt ??
            (status === "interview" ? new Date().toISOString() : null),
          offerAt:
            previous?.offerAt ??
            (status === "offer" ? new Date().toISOString() : null),
        };
      }
      // Apply only supplied fields to the latest state, including after a
      // concurrent website refresh. Defaults must not clear saved board notes.
      const outreachUpdate = (current: typeof existing) => {
        const supplied = (req.body as { outreach: Record<string, unknown> })
          .outreach;
        const previous = current.outreach;
        const changes = Object.fromEntries(
          Object.keys(supplied)
            .filter((key) => Object.hasOwn(patch.outreach!, key))
            .map((key) => [
              key,
              patch.outreach![key as keyof typeof patch.outreach],
            ]),
        );
        const next = OpportunitySchema.shape.outreach
          .unwrap()
          .parse({ ...previous, ...changes });
        if (next.status === "closed" && !next.outcome)
          throw Object.assign(
            new Error("Choose an outcome when closing outreach."),
            { statusCode: 400 },
          );
        const now = new Date().toISOString();
        return {
          ...next,
          contactedAt:
            previous?.contactedAt ??
            (["contacted", "conversation"].includes(next.status)
              ? now
              : next.contactedAt),
          conversationAt:
            previous?.conversationAt ??
            (next.status === "conversation" ? now : next.conversationAt),
          closedAt:
            previous?.closedAt ??
            (next.status === "closed" ? now : next.closedAt),
        };
      };
      if (patch.outreach) saved.outreach = outreachUpdate(existing);
      if (
        patch.outreach &&
        Object.keys(patch).every((key) => key === "outreach")
      ) {
        let current = existing;
        for (let attempt = 0; attempt < 5; attempt++) {
          const next = OpportunitySchema.parse({
            ...current,
            outreach: outreachUpdate(current),
            updatedAt: new Date(
              Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
            ).toISOString(),
          });
          const result = await requestStore(req).saveDerivedOpportunity(
            current,
            next,
          );
          if (!result)
            throw Object.assign(new Error("This startup was removed."), {
              statusCode: 404,
            });
          if (
            isDeepStrictEqual(
              JSON.parse(JSON.stringify(result)),
              JSON.parse(JSON.stringify(next)),
            )
          ) {
            await service.recordOpportunityChanges(
              requestStore(req),
              current,
              result,
            );
            return result;
          }
          current = result;
        }
        throw Object.assign(
          new Error("This startup changed while saving. Please try again."),
          { statusCode: 409 },
        );
      }
      if (Object.keys(patch).every((key) => key === "application")) {
        await requestStore(req).save("opportunities", saved);
        await service.recordOpportunityChanges(
          requestStore(req),
          existing,
          saved,
        );
        return saved;
      }
      const {
        stage: _stage,
        application: _application,
        outreach: _outreach,
        ...corrections
      } = patch;
      if (existing.kind === "startup") {
        saved = await requestStore(req).saveStartupWithCorrections(
          saved,
          corrections,
        );
      } else {
        await requestStore(req).save("opportunities", saved);
      }
      await service.recordOpportunityChanges(
        requestStore(req),
        existing,
        saved,
      );
      await service.invalidateDrafts(requestStore(req), saved.id);
      return service.analyze(
        requestStore(req),
        saved,
        await requestStore(req).getWorkspace(),
      );
    },
  );
  app.post("/api/runs", async (req) => {
    const run = service.RunInput.parse(req.body);
    if (run.action === "simulate")
      throw Object.assign(new Error("Local test runs are unavailable."), {
        statusCode: 400,
      });
    return service.enqueue(requestStore(req), run);
  });
  app.patch<{ Params: { id: string } }>("/api/drafts/:id", async (req) =>
    service.editDraft(requestStore(req), req.params.id, req.body),
  );
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/drafts/:id/download",
    async (req, reply) => {
      const draft = await requestStore(req).get("drafts", req.params.id);
      const format = z
        .enum(["pdf", "json", "txt"])
        .parse(req.query.format || "txt");
      const filename = `roleloop-${draft.id.replace(/[^a-zA-Z0-9-]/g, "")}.${format}`;
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      if (format === "pdf")
        return reply.type("application/pdf").send(await resumePdf(draft));
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
  await app.listen({ host: "127.0.0.1", port: settings.apiPort });
  console.log(
    `RoleLoop API listening at http://127.0.0.1:${settings.apiPort} • local test mode`,
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => void app.close().then(() => process.exit(0)));
}
