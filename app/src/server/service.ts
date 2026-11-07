import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  OpportunitySchema,
  type Bootstrap,
  type Draft,
  type Opportunity,
  type Run,
  type Workspace,
  type SourceHealth,
  type EmployerDiscoveryReport,
} from "../shared/types.js";
import {
  assessOpportunity,
  ASSESSMENT_RULES_VERSION,
  draftContentHash,
  localDay,
  orderOpportunities,
  profileFingerprint,
  preferencesFingerprint,
  opportunityFingerprint,
} from "../domain/rules.js";
import { discover, research, freshFeedRecords } from "../domain/connectors.js";
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
import {
  matchesTargetRole,
  sourceIdentity,
  sourcesForDiscovery,
} from "../shared/discovery.js";
import { settings } from "./config.js";
import { discoverEmployerBoards } from "../domain/employer-discovery.js";

export const RunInput = z.object({
  action: z.enum(["discover", "analyze", "draft", "research", "simulate"]),
  opportunityId: z.string().optional(),
  sourceId: z.string().optional(),
  discoveryScope: z.enum(["jobs", "startups"]).optional(),
  draftId: z.string().optional(),
});
export async function bootstrap(store: WorkspaceStore): Promise<Bootstrap> {
  const [
    workspace,
    opportunities,
    drafts,
    runs,
    events,
    heartbeat,
    sourceHealth,
    employerDiscovery,
  ] = await Promise.all([
    store.getWorkspace(),
    store.list("opportunities"),
    store.list("drafts"),
    store.list("runs", 100),
    store.list("events", 60),
    getGlobalRuntime<{ at: string }>("worker"),
    store.runtime<Record<string, SourceHealth>>("source-health"),
    store.runtime<EmployerDiscoveryReport>("employer-discovery"),
  ]);
  // Recheck legacy eligibility rules locally without repeating paid AI matching.
  const currentOpportunities = await Promise.all(
    opportunities.map((op) => {
      if (
        (op.assessment &&
          op.assessment.profileFingerprint !==
            profileFingerprint(workspace.profile)) ||
        (workspace.preferences.missingSalary === "review" &&
          op.kind === "job" &&
          op.salaryMin === null &&
          op.salaryMax === null &&
          op.assessment?.recommendation === "ready")
      )
        return analyze(store, op, workspace, false);
      if (
        op.assessment &&
        op.assessment.rulesVersion !== ASSESSMENT_RULES_VERSION
      )
        return analyze(store, op, workspace, false, { reuseFit: true });
      return op;
    }),
  );
  const connection = store.actorUserId
    ? await chatgptStatus(store.actorUserId)
    : null;
  const active = connection?.profiles.find((p) => p.id === connection.activeId);
  return {
    ...workspace,
    sourceHealth: sourceHealth ?? {},
    employerDiscovery: employerDiscovery ?? undefined,
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
  options: { reuseFit?: boolean } = {},
) {
  const previous =
    options.reuseFit &&
    !useAI &&
    op.assessment?.profileFingerprint === profileFingerprint(workspace.profile)
      ? op.assessment
      : null;
  let assessment = useAI
    ? await assessWithAI(op, workspace, store.actorUserId)
    : assessOpportunity(
        op,
        workspace.profile,
        workspace.preferences,
        new Date(),
        previous?.matches,
      );
  if (previous) {
    // Keep existing AI/service cautions; replace only the legacy location
    // cautions that the new rules have just checked again.
    const legacyLocationCautions = new Set([
      "Your working country is missing.",
      "Remote location and hiring arrangement need confirmation.",
      "Confirm any state restrictions and work authorization directly in the application.",
    ]);
    assessment = {
      ...assessment,
      fitSummary: previous.fitSummary,
      learningGaps: previous.learningGaps,
      relevantEvidenceIds: previous.relevantEvidenceIds,
      unknowns: [
        ...new Set([
          ...assessment.unknowns,
          ...previous.unknowns.filter(
            (message) => !legacyLocationCautions.has(message),
          ),
        ]),
      ],
    };
    assessment.recommendation = assessment.blockers.length
      ? "excluded"
      : assessment.unknowns.length
        ? "review"
        : "ready";
  }
  const current = await store.getWorkspace();
  if (
    profileFingerprint(current.profile) !==
      profileFingerprint(workspace.profile) ||
    preferencesFingerprint(current.preferences) !==
      preferencesFingerprint(workspace.preferences)
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
  runId?: string,
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
    { runId, category: "draft" },
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
  await store.event("Draft approved for local testing only.", "info", op.id, {
    category: "draft",
  });
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
export async function recordOpportunityChanges(
  store: WorkspaceStore,
  previous: Opportunity,
  saved: Opportunity,
) {
  const previousStatus = previous.application?.status ?? "saved";
  const nextStatus = saved.application?.status ?? "saved";
  const labels = {
    saved: "Saved",
    applied: "Applied",
    interview: "Interview",
    offer: "Offer",
    rejected: "Rejected",
    withdrawn: "Withdrawn",
  };
  if (previousStatus !== nextStatus)
    await store.event(
      `Application status updated for ${saved.title} at ${saved.company}: ${labels[previousStatus]} → ${labels[nextStatus]}.`,
      "info",
      saved.id,
      { category: "application" },
    );
  if (previous.stage !== saved.stage && saved.stage === "archived")
    await store.event(
      `Archived ${saved.title} at ${saved.company}.`,
      "info",
      saved.id,
      { category: "application" },
    );
  else if (previous.stage === "archived" && saved.stage !== "archived")
    await store.event(
      `Restored ${saved.title} at ${saved.company} from the archive.`,
      "info",
      saved.id,
      { category: "application" },
    );
}
export async function processRun(
  store: WorkspaceStore,
  run: Run,
  progress: (amount: number, message: string) => Promise<void>,
) {
  if (run.workspaceId !== store.workspaceId)
    throw new Error("Task workspace does not match its execution context.");
  let workspace = await store.getWorkspace();
  if (run.action === "discover") {
    const summary: NonNullable<Run["summary"]> = {
      evaluated: 0,
      newOpportunities: 0,
      existingOpportunities: 0,
      draftsCreated: 0,
      sourcesChecked: 0,
      sourcesFailed: 0,
      companiesConnected: 0,
      draftFailures: 0,
    };
    const eventContext = { runId: run.id, category: "search" as const };
    const scope = run.discoveryScope ?? (run.sourceId ? undefined : "jobs");
    const discoveredJobs = new Map<
      string,
      { identity: string; opportunities: Opportunity[] }
    >();
    let expansion: EmployerDiscoveryReport | undefined;
    const saveSummary = async () => {
      run.summary = { ...summary };
      run.outcome =
        summary.sourcesFailed ||
        summary.draftFailures ||
        (expansion && expansion.status !== "success")
          ? "partial"
          : "success";
      await store.save("runs", run);
    };
    const expand =
      scope === "jobs" &&
      !run.sourceId &&
      workspace.preferences.discoverEmployers;
    if (expand) {
      expansion = {
        checkedAt: new Date().toISOString(),
        status: "success",
        message: "",
        companiesFound: 0,
        boardsConnected: 0,
        boardsChecked: 0,
      };
      if (
        !workspace.preferences.roles.some((role) => role.trim()) ||
        !workspace.preferences.country.trim()
      ) {
        expansion.status = "needs_preferences";
        expansion.message =
          "Set your target roles and working country in Settings to find new companies.";
      } else if (workspace.sources.length >= 50) {
        expansion.status = "partial";
        expansion.message =
          "Company discovery has reached its current limit. New companies cannot be added in this search.";
      } else {
        try {
          const found = await discoverEmployerBoards(workspace, {
            cache: { get: getGlobalRuntime, set: setGlobalRuntime },
            himalayasApiKey: settings.himalayasApiKey,
            excludeIdentities: await store.ignoredDiscoveryIdentities(),
            onProgress: (message) => progress(5, message),
          });
          expansion.companiesFound = found.companiesFound;
          expansion.boardsChecked = found.boardsChecked;
          let limited = false;
          let changed = false;
          let paused = false;
          for (const board of found.boards) {
            const latest = await store.getWorkspace();
            if (!latest.preferences.discoverEmployers) {
              paused = true;
              break;
            }
            if (
              preferencesFingerprint(latest.preferences) !==
              preferencesFingerprint(workspace.preferences)
            ) {
              changed = true;
              break;
            }
            const connection = await store.connectDiscoveredSource(
              board.source,
            );
            if (connection.status === "limit") {
              limited = true;
              break;
            }
            if (connection.status !== "added" || !connection.sourceId) continue;
            expansion.boardsConnected++;
            discoveredJobs.set(connection.sourceId, {
              identity: sourceIdentity(board.source),
              opportunities: board.opportunities,
            });
          }
          expansion.status =
            found.errors.length || limited || changed || paused
              ? "partial"
              : "success";
          expansion.message = `${expansion.boardsConnected} new ${expansion.boardsConnected === 1 ? "company connected" : "companies connected"} from ${found.companiesFound} employers found.`;
          if (
            !expansion.boardsConnected &&
            !found.errors.length &&
            !limited &&
            !changed &&
            !paused
          )
            expansion.message +=
              " No additional supported boards with relevant openings were found in this search.";
          if (limited) expansion.message += " Your 50-source limit is reached.";
          if (changed)
            expansion.message +=
              " Your preferences changed during discovery. Search again to find companies for your updated preferences.";
          if (paused) expansion.message += " New company discovery was paused.";
          if (found.errors.length) {
            expansion.message +=
              " Some employers could not be checked; see Activity.";
            for (const error of found.errors.slice(0, 5))
              await store.event(
                `Employer discovery: ${error}`,
                "warning",
                undefined,
                eventContext,
              );
          }
        } catch (error) {
          expansion.status = expansion.boardsConnected ? "partial" : "error";
          expansion.message = `${expansion.boardsConnected ? `${expansion.boardsConnected} companies connected before discovery stopped.` : "New-company discovery was unavailable."} ${error instanceof Error ? error.message : "Try again later."}`;
        }
      }
      expansion.checkedAt = new Date().toISOString();
      summary.companiesConnected = expansion.boardsConnected;
      await store.setRuntime("employer-discovery", expansion);
      await store.event(
        expansion.message,
        expansion.status === "success" ? "info" : "warning",
        undefined,
        eventContext,
      );
      // Reload after atomic appends and any edits made while websites were checked.
      workspace = await store.getWorkspace();
    }
    const sources = sourcesForDiscovery(workspace.sources, scope, run.sourceId);

    if (!sources.length) {
      await saveSummary();
      if (expansion?.status === "success" || expansion?.status === "partial")
        return expansion.message;
      throw new Error(
        expansion?.message ||
          (scope === "startups"
            ? "Startup research is paused. Resume it from Startup prospects."
            : "No job sources are enabled. Enable automatic company discovery in Search preferences or resume saved company searches."),
      );
    }
    const recordHealth = async (id: string, health: SourceHealth) => {
      const previous =
        (await store.runtime<Record<string, SourceHealth>>("source-health")) ??
        {};
      await store.setRuntime("source-health", { ...previous, [id]: health });
    };
    const shortlist: Opportunity[] = [];
    const seenSourceKeys = new Set<string>();
    let imported = 0,
      failed = 0;
    for (const [index, source] of sources.entries()) {
      summary.sourcesChecked++;
      await progress(
        Math.round(
          (expand ? 15 : 0) + (index / sources.length) * (expand ? 65 : 80),
        ),
        `Reading ${source.label}`,
      );
      const before = imported;
      let found = 0;
      try {
        let opportunities: Opportunity[];
        const verified = discoveredJobs.get(source.id);
        if (verified?.identity === sourceIdentity(source)) {
          opportunities = verified.opportunities.map((op) => ({
            ...op,
            sourceId: source.id,
            companyId: source.companyId,
            company: source.companyName || source.label,
            companyCountry: source.countrySource
              ? (source.companyCountry ?? "Unknown")
              : "Unknown",
            companyCountrySource: source.countrySource,
          }));
        } else if (source.provider === "jobicy") {
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
          opportunities = freshFeedRecords(opportunities, source.id);
          const keyword = source.board.trim().toLowerCase();
          if (keyword)
            opportunities = opportunities.filter((op) =>
              `${op.title} ${op.description}`.toLowerCase().includes(keyword),
            );
        } else opportunities = await discover(source, workspace.preferences);
        found = opportunities.length;
        for (const candidate of opportunities) {
          if (
            candidate.kind === "job" &&
            workspace.preferences.roles.length &&
            !matchesTargetRole(
              candidate.title,
              workspace.preferences.roles,
              candidate.company,
            )
          )
            continue;
          const parsed = OpportunitySchema.parse(candidate);
          // Keep the first snapshot within a run. Importing a changed duplicate
          // before skipping it would invalidate the assessment already selected
          // for drafting, so deduplicate before any writes.
          if (seenSourceKeys.has(parsed.sourceKey)) continue;
          const importedOpportunity = await store.importOpportunityWithStatus(
            parsed,
          );
          seenSourceKeys.add(parsed.sourceKey);
          const existing = importedOpportunity.opportunity;
          if (existing.stage === "archived") continue;
          if (importedOpportunity.created) summary.newOpportunities++;
          else summary.existingOpportunities++;
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
            existing.assessment.rulesVersion === ASSESSMENT_RULES_VERSION &&
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
                      existing.company,
                    ),
                );
          if (op !== existing && op.assessment?.fitSummary)
            await store.setRuntime(cacheKey, { fingerprint, at: Date.now() });
          imported++;
          summary.evaluated++;
          shortlist.push(op);
        }
        await recordHealth(source.id, {
          checkedAt: new Date().toISOString(),
          status: "success",
          found: opportunities.length,
          evaluated: imported - before,
        });
      } catch (error) {
        await recordHealth(source.id, {
          checkedAt: new Date().toISOString(),
          status: "error",
          found,
          evaluated: imported - before,
          error: error instanceof Error ? error.message : "Source failed",
        });
        failed++;
        summary.sourcesFailed++;
        await store.event(
          `${source.label}: ${error instanceof Error ? error.message : "Source failed"}`,
          "error",
          undefined,
          eventContext,
        );
      }
    }
    if (failed === sources.length) {
      await saveSummary();
      throw new Error(
        "All selected sources failed. See Activity for source errors.",
      );
    }
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
          await prepare(store, op, workspace, true, run.id);
          drafted.add(op.id);
          remainingDrafts--;
          summary.draftsCreated++;
        } catch (error) {
          summary.draftFailures++;
          await store.event(
            `Draft for ${op.company}: ${error instanceof Error ? error.message : "failed"}`,
            "error",
            op.id,
            { runId: run.id, category: "draft" },
          );
        }
      }
    }
    await saveSummary();
    await store.event(
      `Discovery evaluated ${imported} opportunities${expansion?.boardsConnected ? `; connected ${expansion.boardsConnected} new ${expansion.boardsConnected === 1 ? "company" : "companies"}` : ""}${failed ? `; ${failed} source(s) failed` : ""}.`,
      run.outcome === "partial" ? "warning" : "success",
      undefined,
      eventContext,
    );
    return `Evaluated ${imported} opportunities${expansion?.boardsConnected ? ` · ${expansion.boardsConnected} ${expansion.boardsConnected === 1 ? "company" : "companies"} connected` : ""}${failed ? `; ${failed} source(s) failed` : ""}`;
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
    await prepare(store, op, workspace, false, run.id);
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
    await store.event(receipt, "success", op.id, {
      runId: run.id,
      category: "application",
    });
    return receipt;
  }
  throw new Error("Unknown worker action.");
}
