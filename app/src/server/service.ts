import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  OpportunitySchema,
  type Bootstrap,
  type Draft,
  type Opportunity,
  type Run,
  type Workspace,
} from "../shared/types.js";
import {
  assessOpportunity,
  dateWindow,
  draftContentHash,
  localDay,
} from "../domain/rules.js";
import { demoOpportunities } from "../domain/fixtures.js";
import { discover, research } from "../domain/connectors.js";
import * as store from "./store.js";
import { assertApproved, assertFresh } from "./guards.js";
import { generateDraft, ollamaAvailable } from "./model.js";
import { resumePdf, sendToLocalInbox } from "./documents.js";
import { settings } from "./config.js";

export const RunInput = z.object({
  action: z.enum(["discover", "analyze", "draft", "research", "simulate"]),
  opportunityId: z.string().optional(),
  sourceId: z.string().optional(),
  draftId: z.string().optional(),
});
export async function bootstrap(): Promise<Bootstrap> {
  const [workspace, opportunities, drafts, runs, events, heartbeat, model] =
    await Promise.all([
      store.getWorkspace(),
      store.list("opportunities"),
      store.list("drafts"),
      store.list("runs", 100),
      store.list("events", 60),
      store.runtime<{ at: string }>("worker"),
      ollamaAvailable(),
    ]);
  const window = dateWindow(workspace.preferences);
  const freshness = (op: Opportunity) => {
    if (!op.publishedAt) return 0;
    const day = localDay(
      new Date(op.publishedAt),
      workspace.preferences.timezone,
    );
    return day >= window.start && day <= window.end ? 1 : 0;
  };
  const rank = (op: Opportunity) =>
    op.assessment?.recommendation === "excluded"
      ? 2
      : op.assessment?.recommendation === "ready"
        ? 0
        : 1;
  opportunities.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      freshness(b) - freshness(a) ||
      (b.assessment?.score || 0) - (a.assessment?.score || 0) ||
      (b.publishedAt || "").localeCompare(a.publishedAt || ""),
  );
  return {
    ...workspace,
    opportunities,
    drafts,
    runs,
    events,
    status: {
      database: true,
      worker: !!heartbeat && Date.now() - Date.parse(heartbeat.at) < 15000,
      testMode: true,
      modelMode: workspace.preferences.modelMode,
      ollamaAvailable: model,
      studioUrl: settings.studioUrl,
      mailpitUrl: settings.mailpitUrl,
    },
  };
}
export async function seed() {
  const workspace = await store.getWorkspace();
  for (const op of demoOpportunities()) {
    const stored = await store.importOpportunity(op);
    if (!stored.assessment) await analyze(stored, workspace);
  }
  await store.event(
    "Added fictional sample opportunities for both flows. Your profile and preferences were preserved.",
  );
  return bootstrap();
}
export async function enqueue(input: z.infer<typeof RunInput>): Promise<Run> {
  const parsed = RunInput.parse(input);
  if (parsed.action !== "discover" && !parsed.opportunityId)
    throw Object.assign(new Error("Choose an opportunity for this action."), {
      statusCode: 400,
    });
  if (parsed.opportunityId)
    await store.get("opportunities", parsed.opportunityId);
  if (
    parsed.sourceId &&
    !(await store.getWorkspace()).sources.some(
      (s) => s.id === parsed.sourceId && s.enabled,
    )
  )
    throw Object.assign(new Error("Select an enabled source."), {
      statusCode: 400,
    });
  if (parsed.action === "simulate") {
    if (!parsed.draftId)
      throw Object.assign(new Error("Choose a draft to test."), {
        statusCode: 400,
      });
    const draft = await store.get("drafts", parsed.draftId);
    if (draft.opportunityId !== parsed.opportunityId)
      throw new Error("Draft and opportunity differ.");
    assertApproved(
      draft,
      await store.get("opportunities", draft.opportunityId),
      await store.getWorkspace(),
    );
  }
  const now = new Date().toISOString();
  const run: Run = {
    id: randomUUID(),
    ...parsed,
    status: "queued",
    progress: 0,
    message: "Waiting for the local worker",
    createdAt: now,
    updatedAt: now,
  };
  const { data, error } = await store.db.rpc("enqueue_run", {
    run_payload: run,
  });
  if (error) throw new Error(`Queue: ${error.message}`);
  return data[0].payload as Run;
}
export async function analyze(op: Opportunity, workspace: Workspace) {
  const assessment = assessOpportunity(
    op,
    workspace.profile,
    workspace.preferences,
  );
  const progressed = ["drafted", "approved", "tested", "archived"].includes(
    op.stage,
  );
  return store.save("opportunities", {
    ...op,
    assessment,
    stage: progressed
      ? op.stage
      : assessment.recommendation === "ready"
        ? "ready"
        : "review",
    updatedAt: new Date().toISOString(),
  });
}
async function draftCountToday(workspace: Workspace) {
  const day = localDay(new Date(), workspace.preferences.timezone);
  return (await store.list("drafts", 10000)).filter(
    (d) =>
      localDay(new Date(d.createdAt), workspace.preferences.timezone) === day,
  ).length;
}
async function prepare(op: Opportunity, workspace: Workspace) {
  const assessed = await analyze(op, workspace);
  if (assessed.assessment!.recommendation === "excluded")
    throw new Error(
      `Resolve the exclusion before drafting: ${assessed.assessment!.blockers.join(" ")}`,
    );
  if ((await draftCountToday(workspace)) >= workspace.preferences.dailyLimit)
    throw new Error(
      "Daily draft limit reached. Adjust the limit in Settings or wait until tomorrow.",
    );
  const draft = await generateDraft(assessed, workspace, assessed.assessment!);
  await store.save("drafts", draft);
  await store.save("opportunities", {
    ...assessed,
    stage: "drafted",
    updatedAt: new Date().toISOString(),
  });
  await store.event(
    `Prepared ${op.kind === "job" ? "application" : "founder outreach"} draft for ${op.company}.`,
    "success",
    op.id,
  );
  return draft;
}
export async function approve(id: string): Promise<Draft> {
  const draft = await store.get("drafts", id),
    op = await store.get("opportunities", draft.opportunityId),
    workspace = await store.getWorkspace();
  assertFresh(draft, op, workspace);
  const saved = await store.save("drafts", {
    ...draft,
    status: "approved",
    updatedAt: new Date().toISOString(),
  });
  await store.save("opportunities", {
    ...op,
    stage: "approved",
    updatedAt: new Date().toISOString(),
  });
  await store.event("Draft approved for local testing only.", "info", op.id);
  return saved;
}
export const DraftEdit = z
  .object({
    subject: z.string().max(1000),
    body: z.string().max(30000),
    resume: z.string().max(30000),
    coverLetter: z.string().max(30000),
    answers: z
      .array(
        z.object({
          question: z.string().max(3000),
          answer: z.string().max(10000),
        }),
      )
      .max(100),
  })
  .partial();
export async function editDraft(id: string, body: unknown) {
  const draft = await store.get("drafts", id);
  const next = {
    ...draft,
    ...DraftEdit.parse(body),
    status: "draft" as const,
    artifactPath: null,
    testReceipt: null,
    updatedAt: new Date().toISOString(),
  };
  next.contentHash = draftContentHash(next);
  return store.save("drafts", next);
}
export async function invalidateDrafts(opportunityId?: string) {
  for (const draft of await store.list("drafts", 10000))
    if (
      (!opportunityId || draft.opportunityId === opportunityId) &&
      draft.status !== "draft"
    )
      await store.save("drafts", {
        ...draft,
        status: "draft",
        testReceipt: null,
        updatedAt: new Date().toISOString(),
      });
}
export async function refreshAssessments() {
  const workspace = await store.getWorkspace();
  for (const op of await store.list("opportunities", 10000))
    await analyze(op, workspace);
}
export async function processRun(
  run: Run,
  progress: (amount: number, message: string) => Promise<void>,
) {
  const workspace = await store.getWorkspace();
  if (run.action === "discover") {
    const sources = workspace.sources.filter(
      (s) => s.enabled && (!run.sourceId || s.id === run.sourceId),
    );
    if (!sources.length)
      throw new Error("Add and enable a source before running discovery.");
    let imported = 0,
      failed = 0;
    for (const [index, source] of sources.entries()) {
      await progress(
        Math.round((index / sources.length) * 80),
        `Reading ${source.label}`,
      );
      try {
        const opportunities = await discover(source, workspace.preferences);
        for (const candidate of opportunities.slice(0, 200)) {
          const existing = await store.importOpportunity(
            OpportunitySchema.parse(candidate),
          );
          if (existing.stage === "archived") continue;
          const op = await analyze(existing, workspace);
          imported++;
          // Automatically prepare only reviewed, well-supported opportunities. Approval remains explicit.
          if (
            op.assessment?.recommendation === "ready" &&
            !(await store.list("drafts", 10000)).some(
              (d) => d.opportunityId === op.id,
            ) &&
            (await draftCountToday(workspace)) <
              workspace.preferences.dailyLimit
          )
            await prepare(op, workspace);
        }
      } catch (error) {
        failed++;
        await store.event(
          `${source.label}: ${error instanceof Error ? error.message : "Source failed"}`,
          "error",
        );
      }
    }
    if (failed === sources.length)
      throw new Error(
        "All selected sources failed. See Activity for source errors.",
      );
    await store.event(
      `Discovery evaluated ${imported} opportunities${failed ? `; ${failed} source(s) failed` : ""}.`,
      "success",
    );
    return `Evaluated ${imported} opportunities${failed ? `; ${failed} source(s) failed` : ""}`;
  }
  const op = await store.get("opportunities", run.opportunityId!);
  if (run.action === "analyze") {
    await analyze(op, workspace);
    return "Evidence and eligibility checked";
  }
  if (run.action === "research") {
    await progress(20, "Reading the public company website");
    const facts = await research(op);
    await analyze(
      OpportunitySchema.parse({
        ...op,
        ...facts,
        updatedAt: new Date().toISOString(),
      }),
      workspace,
    );
    await invalidateDrafts(op.id);
    return "Public website research saved; confirm company facts";
  }
  if (run.action === "draft") {
    await progress(30, "Selecting verified experience");
    await prepare(op, workspace);
    return "Draft prepared for review";
  }
  if (run.action === "simulate") {
    const draft = await store.get("drafts", run.draftId!);
    assertApproved(draft, op, workspace);
    if (draft.testReceipt)
      return "This draft has already completed its local test";
    await progress(25, "Preparing local test artifacts");
    const pdf = await resumePdf(draft);
    const artifactPath = `drafts/${draft.id}/resume.pdf`;
    const uploaded = await store.db.storage
      .from("documents")
      .upload(artifactPath, pdf, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (uploaded.error)
      throw new Error(`Artifact storage: ${uploaded.error.message}`);
    // Recheck at execution time after document generation, in case the user edited the draft.
    const fresh = await store.get("drafts", draft.id);
    assertApproved(
      fresh,
      await store.get("opportunities", op.id),
      await store.getWorkspace(),
    );
    if (fresh.contentHash !== draft.contentHash)
      throw new Error(
        "The draft changed during preparation. Review and run the test again.",
      );
    let receipt: string;
    if (draft.kind === "outreach")
      receipt = `Mailpit only: ${await sendToLocalInbox(draft, op, workspace.profile)}`;
    else
      receipt = `Mock application accepted locally • ${new Date().toISOString()} • no employer contacted`;
    await store.save("drafts", {
      ...fresh,
      status: "tested",
      artifactPath,
      testReceipt: receipt,
      updatedAt: new Date().toISOString(),
    });
    const latestOp = await store.get("opportunities", op.id);
    await store.save("opportunities", {
      ...latestOp,
      stage: "tested",
      updatedAt: new Date().toISOString(),
    });
    await store.event(receipt, "success", op.id);
    return receipt;
  }
  throw new Error("Unknown worker action.");
}
