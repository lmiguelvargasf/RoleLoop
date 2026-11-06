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
  draftContentHash,
  localDay,
  orderOpportunities,
  profileFingerprint,
  preferencesFingerprint,
  opportunityFingerprint,
} from "../domain/rules.js";
import { discover, research } from "../domain/connectors.js";
import {
  getGlobalRuntime,
  setGlobalRuntime,
  type WorkspaceStore,
} from "./store.js";
import { assertApproved, assertFresh } from "./guards.js";
import { generateDraft } from "./model.js";
import { resumePdf, sendToLocalInbox } from "./documents.js";
import { chatgptStatus } from "./chatgpt.js";
import { assessWithAI } from "./fit.js";
import { matchesTargetRole } from "../shared/discovery.js";
import { settings } from "./config.js";

export const RunInput = z.object({
  action: z.enum(["discover", "analyze", "draft", "research", "simulate"]),
  opportunityId: z.string().optional(),
  sourceId: z.string().optional(),
  draftId: z.string().optional(),
});
export async function bootstrap(store: WorkspaceStore): Promise<Bootstrap> {
  const [workspace, opportunities, drafts, runs, events, heartbeat] =
    await Promise.all([
      store.getWorkspace(),
      store.list("opportunities"),
      store.list("drafts"),
      store.list("runs", 100),
      store.list("events", 60),
      getGlobalRuntime<{ at: string }>("worker"),
    ]);
  // Refresh cached assessments after a CV change or a retired salary policy.
  const currentOpportunities = await Promise.all(
    opportunities.map((op) =>
      (op.assessment &&
        op.assessment.profileFingerprint !==
          profileFingerprint(workspace.profile)) ||
      (workspace.preferences.missingSalary === "review" &&
        op.kind === "job" &&
        op.salaryMin === null &&
        op.salaryMax === null &&
        op.assessment?.recommendation === "ready")
        ? analyze(store, op, workspace, false)
        : op,
    ),
  );
  const connection = store.actorUserId
    ? await chatgptStatus(store.actorUserId)
    : null;
  const active = connection?.profiles.find((p) => p.id === connection.activeId);
  return {
    ...workspace,
    opportunities: orderOpportunities(
      currentOpportunities,
      workspace.preferences,
    ),
    drafts,
    runs,
    events,
    status: {
      database: true,
      worker: !!heartbeat && Date.now() - Date.parse(heartbeat.at) < 15000,
      testMode: true,
      openaiConfigured:
        connection?.mode === "chatgpt"
          ? !!active?.connected && active.planEnabled
          : !!settings.openaiKey,
      openaiModel:
        connection?.mode === "chatgpt"
          ? active?.model || "ChatGPT plan"
          : settings.openaiModel,
      studioUrl: settings.studioUrl,
      mailpitUrl: settings.mailpitUrl,
    },
  };
}
export async function enqueue(
  store: WorkspaceStore,
  input: z.infer<typeof RunInput>,
): Promise<Run> {
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
    workspaceId: store.workspaceId,
    status: "queued",
    progress: 0,
    message: "Waiting for the local worker",
    createdAt: now,
    updatedAt: now,
  };
  const { data, error } = await store.db.rpc("enqueue_run", {
    target_workspace: store.workspaceId,
    run_payload: run,
  });
  if (error) throw new Error(`Queue: ${error.message}`);
  return {
    ...data[0].payload,
    requestedBy: data[0].requested_by || undefined,
  } as Run;
}
export async function analyze(
  store: WorkspaceStore,
  op: Opportunity,
  workspace: Workspace,
  useAI = true,
) {
  let assessment = useAI
    ? await assessWithAI(op, workspace, store.actorUserId)
    : assessOpportunity(op, workspace.profile, workspace.preferences);
  const current = await store.getWorkspace();
  if (
    profileFingerprint(current.profile) !==
    profileFingerprint(workspace.profile)
  )
    assessment = assessOpportunity(op, current.profile, current.preferences);
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
async function draftCountToday(store: WorkspaceStore) {
  const day = localDay(new Date());
  return (await store.list("drafts", 10000)).filter(
    (d) => localDay(new Date(d.createdAt)) === day,
  ).length;
}
async function prepare(
  store: WorkspaceStore,
  op: Opportunity,
  workspace: Workspace,
  alreadyAssessed = false,
) {
  const assessed = alreadyAssessed ? op : await analyze(store, op, workspace);
  if (assessed.assessment!.recommendation === "excluded")
    throw new Error(
      `Resolve the exclusion before drafting: ${assessed.assessment!.blockers.join(" ")}`,
    );
  if ((await draftCountToday(store)) >= workspace.preferences.dailyLimit)
    throw new Error(
      "Daily draft limit reached. Adjust the limit in Settings or wait until tomorrow.",
    );
  const draft = await generateDraft(assessed, workspace, assessed.assessment!);
  assertFresh(draft, assessed, await store.getWorkspace());
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
export async function approve(
  store: WorkspaceStore,
  id: string,
): Promise<Draft> {
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
export async function editDraft(
  store: WorkspaceStore,
  id: string,
  body: unknown,
) {
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
export async function invalidateDrafts(
  store: WorkspaceStore,
  opportunityId?: string,
) {
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
export async function refreshAssessments(store: WorkspaceStore) {
  const workspace = await store.getWorkspace();
  for (const op of await store.list("opportunities", 10000))
    await analyze(store, op, workspace, false);
}
export async function processRun(
  store: WorkspaceStore,
  run: Run,
  progress: (amount: number, message: string) => Promise<void>,
) {
  if (run.workspaceId !== store.workspaceId)
    throw new Error("Task workspace does not match its execution context.");
  const workspace = await store.getWorkspace();
  if (run.action === "discover") {
    const sources = workspace.sources.filter(
      (s) => s.enabled && (!run.sourceId || s.id === run.sourceId),
    );
    if (!sources.length)
      throw new Error("Add and enable a source before running discovery.");
    const shortlist: Opportunity[] = [];
    let imported = 0,
      failed = 0;
    for (const [index, source] of sources.entries()) {
      await progress(
        Math.round((index / sources.length) * 80),
        `Reading ${source.label}`,
      );
      try {
        let opportunities: Opportunity[];
        if (source.provider === "jobicy") {
          const cached = await getGlobalRuntime<{
            at: number;
            opportunities: Opportunity[];
            ok?: boolean;
          }>("jobicy-feed-v1");
          if (cached && Date.now() - cached.at < 3600000) {
            if (!cached.ok && !cached.opportunities.length)
              throw new Error(
                "Jobicy was checked recently; retry after the hourly refresh window.",
              );
            opportunities = cached.opportunities.map((op) =>
              OpportunitySchema.parse({ ...op, sourceId: source.id }),
            );
          } else {
            // Persist before requesting: errors and restarts must not bypass the hourly limit.
            await setGlobalRuntime("jobicy-feed-v1", {
              at: Date.now(),
              opportunities: cached?.opportunities ?? [],
            });
            opportunities = await discover(source, workspace.preferences);
            await setGlobalRuntime("jobicy-feed-v1", {
              at: Date.now(),
              opportunities,
              ok: true,
            });
          }
          const keyword = source.board.trim().toLowerCase();
          if (keyword)
            opportunities = opportunities.filter((op) =>
              `${op.title} ${op.description}`.toLowerCase().includes(keyword),
            );
        } else opportunities = await discover(source, workspace.preferences);
        for (const candidate of opportunities) {
          if (
            source.provider === "jobicy" &&
            workspace.preferences.roles.length &&
            !matchesTargetRole(candidate.title, workspace.preferences.roles)
          )
            continue;
          const existing = await store.importOpportunity(
            OpportunitySchema.parse(candidate),
          );
          if (existing.stage === "archived") continue;
          const cacheKey = `fit:${existing.id}`;
          const fingerprint = `${opportunityFingerprint(existing)}:${profileFingerprint(workspace.profile)}:${preferencesFingerprint(workspace.preferences)}:${store.actorUserId ?? "api"}`;
          const previous = await store.runtime<{
            fingerprint: string;
            at: number;
          }>(cacheKey);
          const basic = assessOpportunity(
            existing,
            workspace.profile,
            workspace.preferences,
          );
          const op =
            existing.assessment &&
            previous?.fingerprint === fingerprint &&
            Date.now() - previous.at < 86400000
              ? existing
              : await analyze(
                  store,
                  existing,
                  workspace,
                  !basic.blockers.length &&
                    matchesTargetRole(
                      existing.title,
                      workspace.preferences.roles,
                    ),
                );
          if (op !== existing && op.assessment?.fitSummary)
            await store.setRuntime(cacheKey, { fingerprint, at: Date.now() });
          imported++;
          shortlist.push(op);
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
    const drafted = new Set(
      (await store.list("drafts", 10000)).map((d) => d.opportunityId),
    );
    let remainingDrafts =
      workspace.preferences.dailyLimit - (await draftCountToday(store));
    for (const op of orderOpportunities(shortlist, workspace.preferences)) {
      if (remainingDrafts <= 0) break;
      if (
        op.assessment?.recommendation === "ready" &&
        !drafted.has(op.id) &&
        (!op.application || op.application.status === "saved")
      ) {
        try {
          await prepare(store, op, workspace, true);
          drafted.add(op.id);
          remainingDrafts--;
        } catch (error) {
          await store.event(
            `Draft for ${op.company}: ${error instanceof Error ? error.message : "failed"}`,
            "error",
            op.id,
          );
        }
      }
    }
    await store.event(
      `Discovery evaluated ${imported} opportunities${failed ? `; ${failed} source(s) failed` : ""}.`,
      "success",
    );
    return `Evaluated ${imported} opportunities${failed ? `; ${failed} source(s) failed` : ""}`;
  }
  const op = await store.get("opportunities", run.opportunityId!);
  if (run.action === "analyze") {
    await analyze(store, op, workspace);
    return "Evidence and eligibility checked";
  }
  if (run.action === "research") {
    await progress(20, "Reading the public company website");
    const facts = await research(op);
    await analyze(
      store,
      OpportunitySchema.parse({
        ...op,
        ...facts,
        updatedAt: new Date().toISOString(),
      }),
      workspace,
    );
    await invalidateDrafts(store, op.id);
    return "Public website research saved; confirm company facts";
  }
  if (run.action === "draft") {
    await progress(30, "Selecting verified experience");
    await prepare(store, op, workspace);
    return "Draft prepared for review";
  }
  if (run.action === "simulate") {
    const draft = await store.get("drafts", run.draftId!);
    assertApproved(draft, op, workspace);
    if (draft.testReceipt)
      return "This draft has already completed its local test";
    await progress(25, "Preparing local test artifacts");
    const pdf = await resumePdf(draft);
    const artifactPath = `${store.workspaceId}/drafts/${draft.id}/resume.pdf`;
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
