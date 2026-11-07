import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import {
  discover,
  research,
  freshFeedRecords,
  extractRequirementDetails,
  REQUIREMENT_EXTRACTION_VERSION,
  publishedSalary,
  SALARY_EXTRACTION_VERSION,
} from "../domain/connectors.js";
import {
  getGlobalRuntime,
  setGlobalRuntime,
  type WorkspaceStore,
} from "./store.js";
import { assertApproved, assertCanPrepare, assertFresh } from "./guards.js";
import { generateDraft } from "./model.js";
import { resumePdf, sendToLocalInbox } from "./documents.js";
import { chatgptStatus } from "./chatgpt.js";
import { assessWithAI, FIT_PROMPT_VERSION } from "./fit.js";
import {
  matchesTargetRole,
  sourceIdentity,
  sourceKind,
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
const collectionRefreshes = new Map<string, Promise<unknown>>();

function needsTimeRefresh(op: Opportunity, now = new Date()) {
  const evaluatedAt = op.assessment?.evaluatedAt;
  return (
    !evaluatedAt ||
    !Number.isFinite(Date.parse(evaluatedAt)) ||
    localDay(new Date(evaluatedAt)) !== localDay(now) ||
    (!!op.sourceExpiresAt &&
      Date.parse(op.sourceExpiresAt) <= now.getTime() &&
      Date.parse(evaluatedAt) < Date.parse(op.sourceExpiresAt))
  );
}

function needsSalaryExtraction(op: Opportunity) {
  return (
    op.kind === "job" &&
    !op.isDemo &&
    !op.sourceKey.startsWith("manual:") &&
    op.source !== "Manual entry" &&
    op.salaryMin === null &&
    op.salaryMax === null &&
    op.salaryVersion !== SALARY_EXTRACTION_VERSION
  );
}

function localAssessment(
  op: Opportunity,
  workspace: Workspace,
  reuseFit: boolean,
) {
  const previous =
    reuseFit &&
    op.assessment?.profileFingerprint ===
      profileFingerprint(workspace.profile) &&
    (op.assessment.fitSummary ||
      op.assessment.fitEvaluation?.method === "semantic") &&
    op.assessment.matches.every((match) =>
      op.requirements.some(
        (requirement) =>
          requirement.id === match.requirementId &&
          requirement.text === match.requirement &&
          requirement.essential === match.essential,
      ),
    )
      ? op.assessment
      : null;
  const assessment = assessOpportunity(
    op,
    workspace.profile,
    workspace.preferences,
    new Date(),
    previous?.matches,
  );
  // Semantic evidence remains useful when preferences change. Policy questions
  // must be rebuilt, rather than carrying an old country's cautions forward.
  return previous
    ? {
        ...assessment,
        // The prose may mention the old country, salary or policy context.
        // Requirement-level evidence is reusable; context-specific prose is not.
        fitSummary:
          previous.preferencesFingerprint ===
          preferencesFingerprint(workspace.preferences) &&
          JSON.stringify(previous.blockers) === JSON.stringify(assessment.blockers) &&
          JSON.stringify(previous.policyUnknowns ?? previous.unknowns) ===
            JSON.stringify(assessment.policyUnknowns ?? assessment.unknowns)
            ? previous.fitSummary
            : undefined,
        learningGaps: previous.learningGaps,
        relevantEvidenceIds: previous.relevantEvidenceIds,
      }
    : assessment;
}

function assessedOpportunity(
  op: Opportunity,
  assessment: NonNullable<Opportunity["assessment"]>,
): Opportunity {
  return {
    ...op,
    assessment,
    stage: ["drafted", "approved", "tested", "archived"].includes(op.stage)
      ? op.stage
      : assessment.recommendation === "ready"
        ? "ready"
        : "review",
    updatedAt: new Date().toISOString(),
  };
}

async function refreshCollection(
  store: WorkspaceStore,
  workspace: Workspace,
  opportunities: Opportunity[],
): Promise<{ workspace: Workspace; opportunities: Opportunity[] }> {
  const active = collectionRefreshes.get(store.workspaceId);
  if (active) {
    await active;
    return refreshCollection(
      store,
      await store.getWorkspace(),
      await store.listAllOpportunities(),
    );
  }
  const refresh = async (
    snapshot = workspace,
  ): Promise<{ workspace: Workspace; opportunities: Opportunity[] }> => {
    const profile = profileFingerprint(snapshot.profile);
    const preferences = preferencesFingerprint(snapshot.preferences);
    const staleExtraction = opportunities.filter(
      (op) =>
        op.kind === "job" &&
        (op.requirementsVersion !== REQUIREMENT_EXTRACTION_VERSION ||
          needsSalaryExtraction(op)),
    );
    const corrections = await store.runtimeMany<Partial<Opportunity>>(
      staleExtraction.map((op) => `corrections:${op.id}`),
    );
    const updates = opportunities.flatMap((original) => {
      let op = original;
      let salaryChanged = false;
      const correction = corrections.get(`corrections:${op.id}`);
      if (needsSalaryExtraction(op)) {
        const correctedSalary = [
          "salaryMin",
          "salaryMax",
          "salaryCurrency",
          "salaryPeriod",
        ].some((key) => correction && Object.hasOwn(correction, key));
        const salary = correctedSalary
          ? null
          : publishedSalary(op.title, op.description);
        salaryChanged = salary !== null;
        op = {
          ...op,
          ...salary,
          salaryVersion: SALARY_EXTRACTION_VERSION,
        };
      }
      if (
        op.kind === "job" &&
        op.requirementsVersion !== REQUIREMENT_EXTRACTION_VERSION
      ) {
        const manual =
          op.isDemo ||
          op.sourceKey.startsWith("manual:") ||
          op.source === "Manual entry";
        const extracted = extractRequirementDetails(op.description);
        const requirements =
          correction && Object.hasOwn(correction, "requirements")
            ? correction.requirements!
            : manual && op.requirements.length
              ? op.requirements
              : extracted.requirements;
        const requirementsTruncated =
          correction && Object.hasOwn(correction, "requirements")
            ? (correction.requirementsTruncated ?? false)
            : manual && op.requirements.length
              ? op.requirementsTruncated
              : extracted.requirementsTruncated;
        const changed =
          JSON.stringify(requirements) !== JSON.stringify(op.requirements) ||
          requirementsTruncated !== op.requirementsTruncated;
        op = {
          ...op,
          requirements,
          requirementsTruncated,
          requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
          assessment: changed ? null : op.assessment,
        };
      }
      const stale =
        salaryChanged ||
        needsTimeRefresh(op) ||
        !op.assessment ||
        op.assessment.profileFingerprint !== profile ||
        op.assessment.preferencesFingerprint !== preferences ||
        op.assessment.rulesVersion !== ASSESSMENT_RULES_VERSION ||
        (op.kind === "job" &&
          (!op.assessment.geography || !op.assessment.fitEvaluation)) ||
        (snapshot.preferences.missingSalary === "review" &&
          op.kind === "job" &&
          op.salaryMin === null &&
          op.salaryMax === null &&
          op.assessment.recommendation === "ready");
      if (stale) {
        const assessment = localAssessment(op, snapshot, true);
        if (salaryChanged) {
          // Old prose may claim the salary is undisclosed. Retain requirement
          // evidence while rebuilding policy checks without another AI request.
          assessment.fitSummary = undefined;
          assessment.learningGaps = undefined;
        }
        op = assessedOpportunity(op, assessment);
      }
      return op === original ? [] : [{ original, next: op }];
    });
    if (!updates.length) return { workspace: snapshot, opportunities };
    // Read once per rollout, not once per job; profile/contact reads are costly.
    // Fingerprints allow a later preference edit to invalidate this snapshot.
    const currentWorkspace = await store.getWorkspace();
    const workspaceChanged =
      profileFingerprint(currentWorkspace.profile) !== profile ||
      preferencesFingerprint(currentWorkspace.preferences) !== preferences;
    // A preference edit invalidates every assessment, including rows that were
    // current when the initial read started. Recompute the whole change set.
    if (workspaceChanged) return refresh(currentWorkspace);
    const updated = new Map<string, Opportunity | null>();
    for (let offset = 0; offset < updates.length; offset += 4) {
      await Promise.all(
        updates.slice(offset, offset + 4).map(async ({ original, next }) => {
          updated.set(
            original.id,
            await store.saveDerivedOpportunity(original, next),
          );
        }),
      );
    }
    return {
      workspace: currentWorkspace,
      opportunities: opportunities.flatMap((op) => {
        const next = updated.has(op.id) ? updated.get(op.id) : op;
        return next ? [next] : [];
      }),
    };
  };
  const pending = refresh();
  collectionRefreshes.set(store.workspaceId, pending);
  try {
    return await pending;
  } finally {
    if (collectionRefreshes.get(store.workspaceId) === pending)
      collectionRefreshes.delete(store.workspaceId);
  }
}

export async function bootstrap(store: WorkspaceStore): Promise<Bootstrap> {
  const [
    initialWorkspace,
    opportunities,
    drafts,
    runs,
    events,
    heartbeat,
    sourceHealth,
    employerDiscovery,
  ] = await Promise.all([
    store.getWorkspace(),
    store.listAllOpportunities(),
    store.list("drafts"),
    store.list("runs", 100),
    store.list("events", 60),
    getGlobalRuntime<{ at: string }>("worker"),
    store.runtime<Record<string, SourceHealth>>("source-health"),
    store.runtime<EmployerDiscoveryReport>("employer-discovery"),
  ]);
  // Repair derived data locally once per version, then rank all saved jobs
  // before the UI takes its first page. Bootstrap never requests paid AI.
  const { workspace, opportunities: currentOpportunities } =
    await refreshCollection(store, initialWorkspace, opportunities);
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
  if (parsed.opportunityId) {
    const opportunity = await store.get("opportunities", parsed.opportunityId);
    if (parsed.action === "draft") assertCanPrepare(opportunity);
  }
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
  options: { reuseFit?: boolean; persist?: boolean } = {},
) {
  const evaluated = useAI
    ? await assessWithAI(op, workspace, store.actorUserId)
    : localAssessment(op, workspace, !!options.reuseFit);
  let original = op;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await store.getWorkspace();
    const assessment =
      profileFingerprint(current.profile) !==
        profileFingerprint(workspace.profile) ||
      preferencesFingerprint(current.preferences) !==
        preferencesFingerprint(workspace.preferences)
        ? localAssessment(original, current, false)
        : evaluated;
    const assessed = assessedOpportunity(original, assessment);
    if (options.persist === false) return assessed;
    const saved = await store.saveDerivedOpportunity(original, assessed);
    if (!saved)
      throw new Error("This opportunity was removed while it was being evaluated.");
    // Timestamps can collide within one millisecond. Compare the persisted JSON
    // too; storage omits undefined fields and may reorder object keys.
    if (
      saved.updatedAt === assessed.updatedAt &&
      isDeepStrictEqual(
        JSON.parse(JSON.stringify(saved.assessment ?? null)),
        JSON.parse(JSON.stringify(assessment)),
      )
    )
      return saved;
    // Polling can save a preliminary local assessment while AI is running.
    // Reapply the completed assessment to that newer row, preserving notes,
    // application progress and archiving. Changed job facts invalidate it.
    if (opportunityFingerprint(saved) !== opportunityFingerprint(op))
      return saved;
    original = saved;
  }
  throw new Error(
    "This opportunity kept changing while its evaluation was saved. Retry evaluation.",
  );
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
  const current = await store.get("opportunities", op.id);
  assertCanPrepare(current);
  const assessed =
    alreadyAssessed && current.updatedAt === op.updatedAt
      ? current
      : await analyze(store, current, workspace, true, { persist: false });
  if (assessed.assessment!.recommendation === "excluded")
    throw new Error(
      `Resolve the exclusion before drafting: ${assessed.assessment!.blockers.join(" ")}`,
    );
  if ((await draftCountToday(store)) >= workspace.preferences.dailyLimit)
    throw new Error(
      "Daily draft limit reached. Adjust the limit in Settings or wait until tomorrow.",
    );
  assertCanPrepare(await store.get("opportunities", op.id));
  const draft = await generateDraft(assessed, workspace, assessed.assessment!);
  // Preparation can span AI calls. Re-read before saving so archiving or
  // editing the job during preparation cannot restore it or erase progress.
  const latest = await store.get("opportunities", op.id);
  assertCanPrepare(latest);
  assertFresh(draft, latest, await store.getWorkspace());
  await store.save("drafts", draft);
  await store.saveDerivedOpportunity(latest, {
    ...latest,
    assessment: assessed.assessment,
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
  const [workspace, opportunities] = await Promise.all([
    store.getWorkspace(),
    store.listAllOpportunities(),
  ]);
  await refreshCollection(store, workspace, opportunities);
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
      evaluationFailures: 0,
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
        summary.evaluationFailures ||
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
          const storedOffset = await store.runtime<{ offset: number }>("employer-role-offset");
          const roleOffset = Number.isSafeInteger(storedOffset?.offset) && storedOffset!.offset >= 0
            ? storedOffset!.offset
            : 0;
          const found = await discoverEmployerBoards(workspace, {
            cache: { get: getGlobalRuntime, set: setGlobalRuntime },
            himalayasApiKey: settings.himalayasApiKey,
            excludeIdentities: await store.ignoredDiscoveryIdentities(),
            roleOffset,
            onProgress: (message) => progress(5, message),
          });
          if (!found.errors.length || found.companiesFound)
            await store.setRuntime("employer-role-offset", { offset: roleOffset + 3 });
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
        } else if (sourceKind(source) === "job_feed") {
          const feedCacheKey = `${source.provider}-feed-v1`;
          const cached = await getGlobalRuntime<{
            at: number;
            opportunities: Opportunity[];
            ok?: boolean;
          }>(feedCacheKey);
          if (cached && Date.now() - cached.at < 3600000) {
            if (!cached.ok)
              throw new Error(
                `${source.label} could not be refreshed recently; retry after the hourly refresh window. Previously saved jobs remain available.`,
              );
            opportunities = cached.opportunities.map((op) =>
              OpportunitySchema.parse({ ...op, sourceId: source.id }),
            );
          } else {
            // Persist before requesting: errors and restarts must not bypass the hourly limit.
            await setGlobalRuntime(feedCacheKey, {
              at: Date.now(),
              opportunities: cached?.opportunities ?? [],
            });
            opportunities = await discover(source, workspace.preferences);
            await setGlobalRuntime(feedCacheKey, {
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
        // Reserve identities before starting asynchronous imports so concurrent
        // jobs (including changed duplicates) keep the first snapshot in a run.
        const candidates = opportunities.filter((candidate) => {
          if (
            candidate.kind === "job" &&
            workspace.preferences.roles.length &&
            !matchesTargetRole(
              candidate.title,
              workspace.preferences.roles,
              candidate.company,
            )
          )
            return false;
          if (seenSourceKeys.has(candidate.sourceKey)) return false;
          seenSourceKeys.add(candidate.sourceKey);
          return true;
        });
        const importedIds = new Map<string, string>();
        const evaluateCandidate = async (candidate: Opportunity) => {
          // Shared hourly feeds may contain rows parsed before the latest
          // extraction rules. Repair them before evaluation, not only later
          // when the UI reloads the saved collection.
          const parsed = OpportunitySchema.parse({
            ...candidate,
            ...(candidate.kind === "job" &&
            !candidate.isDemo &&
            candidate.requirementsVersion !== REQUIREMENT_EXTRACTION_VERSION
              ? {
                  ...extractRequirementDetails(candidate.description),
                  requirementsVersion: REQUIREMENT_EXTRACTION_VERSION,
                }
              : {}),
          });
          const importedOpportunity =
            await store.importOpportunityWithStatus(parsed);
          const existing = importedOpportunity.opportunity;
          importedIds.set(parsed.sourceKey, existing.id);
          if (existing.stage === "archived") return;
          if (importedOpportunity.created) summary.newOpportunities++;
          else summary.existingOpportunities++;
          const cacheKey = `fit:${existing.id}`;
          const fingerprint = `${FIT_PROMPT_VERSION}:${opportunityFingerprint(existing)}:${profileFingerprint(workspace.profile)}:${preferencesFingerprint(workspace.preferences)}:${store.actorUserId ?? "api"}`;
          const previous = await store.runtime<{
            fingerprint: string;
            at: number;
          }>(cacheKey);
          const basic = assessOpportunity(
            existing,
            workspace.profile,
            workspace.preferences,
          );
          const reuseCachedFit =
            existing.assessment &&
            existing.assessment.rulesVersion === ASSESSMENT_RULES_VERSION &&
            previous?.fingerprint === fingerprint &&
            Date.now() - previous.at < 86400000;
          const op = reuseCachedFit
              ? needsTimeRefresh(existing)
                ? await analyze(store, existing, workspace, false, {
                    reuseFit: true,
                  })
                : existing
              : await analyze(
                  store,
                  existing,
                  workspace,
                  !basic.blockers.length &&
                    (existing.kind !== "job" ||
                      basic.geography?.status !== "excluded") &&
                    matchesTargetRole(
                      existing.title,
                      workspace.preferences.roles,
                      existing.company,
                    ),
                );
          if (!reuseCachedFit && op !== existing && op.assessment?.fitSummary)
            await store.setRuntime(cacheKey, { fingerprint, at: Date.now() });
          if (op.assessment?.fitEvaluation?.failureReason) {
            summary.evaluationFailures = (summary.evaluationFailures ?? 0) + 1;
            await store.event(
              `${op.company}: ${op.assessment.fitEvaluation.failureReason}`,
              "warning",
              op.id,
              { runId: run.id, category: "evaluation" },
            );
          }
          imported++;
          summary.evaluated++;
          shortlist.push(op);
        };
        let nextCandidate = 0;
        let checked = 0;
        let progressUpdates = Promise.resolve();
        const reportEvaluationProgress = () => {
          const finished = checked;
          const amount = Math.round(
            (expand ? 15 : 0) +
              ((index + finished / candidates.length) / sources.length) *
                (expand ? 65 : 80),
          );
          // Database writes for progress must retain completion order even when
          // three evaluations finish together. A failed write is still surfaced
          // by its worker after all other in-flight evaluations have settled.
          const update = progressUpdates.then(() =>
            progress(
              amount,
              `Evaluating ${source.label}: ${finished}/${candidates.length} checked`,
            ),
          );
          progressUpdates = update.catch(() => {});
          return update;
        };
        if (candidates.length) await reportEvaluationProgress();
        const evaluations = await Promise.allSettled(
          Array.from({ length: Math.min(3, candidates.length) }, async () => {
            while (nextCandidate < candidates.length) {
              const candidate = candidates[nextCandidate++];
              try {
                await evaluateCandidate(candidate);
              } catch (error) {
                summary.evaluationFailures = (summary.evaluationFailures ?? 0) + 1;
                await store.event(
                  `Evaluation for ${candidate.company}: ${error instanceof Error ? error.message : "Evaluation failed"}`,
                  "warning",
                  importedIds.get(candidate.sourceKey),
                  { runId: run.id, category: "evaluation" },
                );
              } finally {
                checked++;
                await reportEvaluationProgress();
              }
            }
          }),
        );
        const rejected = evaluations.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
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
        op.kind === "startup" &&
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
    return `Evaluated ${imported} opportunities${expansion?.boardsConnected ? ` · ${expansion.boardsConnected} ${expansion.boardsConnected === 1 ? "company" : "companies"} connected` : ""}${failed ? `; ${failed} source(s) failed` : ""}${summary.evaluationFailures ? `; ${summary.evaluationFailures} evaluation(s) need retry` : ""}`;
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
