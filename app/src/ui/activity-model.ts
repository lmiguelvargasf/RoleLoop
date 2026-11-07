import type { Activity, Bootstrap, Opportunity, Run } from "../shared/types";
import { outreachColumn } from "../shared/outreach-board";

export type ActivityCategory =
  | "search"
  | "evaluation"
  | "research"
  | "draft"
  | "resume"
  | "preferences"
  | "application"
  | "outreach"
  | "workspace";
export type ActivityStatus =
  | "queued"
  | "running"
  | "success"
  | "partial"
  | "warning"
  | "error"
  | "info";
export interface ActivityAction {
  label: string;
  page:
    | "jobs"
    | "startups"
    | "outreach"
    | "drafts"
    | "profile"
    | "settings"
    | "account";
  opportunityId?: string;
}
export interface ActivityItem {
  id: string;
  title: string;
  description: string;
  category: ActivityCategory;
  status: ActivityStatus;
  createdAt: string;
  updatedAt?: string;
  progress?: number;
  action?: ActivityAction;
  nextStep?: string;
  technicalDetails?: string;
  run?: Run;
  events?: ActivityItem[];
  summary?: Run["summary"];
}

const number = (value: number) => new Intl.NumberFormat().format(value);
const plural = (value: number, singular: string, multiple = `${singular}s`) =>
  `${number(value)} ${value === 1 ? singular : multiple}`;
const compact = (message: string) => message.replace(/\s+/g, " ").trim();
const details = (message: string) =>
  message.length > 12000
    ? `${message.slice(0, 12000)}\n[Additional technical details omitted]`
    : message;

// Historic activity contains raw error.message values, including serialized Zod
// issues. Never promote those values directly into the main reading surface.
function technical(message: string) {
  return (
    message.length > 420 ||
    /[\[{]\s*(?:[\[{]|"[^"]+"\s*:)/.test(message) ||
    /(?:ZodError|TypeError|ReferenceError|SyntaxError|invalid_type|invalid input:|expected .+received|\bundefined\b|\bnull\b|\bNaN\b|\bSQL\b|\bSQLSTATE\b|\bPGRST\w*\b|duplicate key|violates .+constraint|(?:relation|column) .+does not exist|schema cache|permission denied for|\bE(?:CONN\w*|NOTFOUND|TIMEDOUT)\b|\bHTTP\s*\d{3}\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+https?:|\bat\s+\S+\s*\([^)]*:\d+:\d+\)|[\w./-]+\.[cm]?[jt]sx?:\d+|<\/?(?:html|body|script)\b)/i.test(
      message,
    )
  );
}

function displayLabel(value: string, fallback: string) {
  const label = compact(value);
  if (!label || technical(label)) return fallback;
  return label.length > 100 ? `${label.slice(0, 99)}…` : label;
}

function sourceLabel(message: string) {
  const prefix = message.match(/^([^:\n]{1,100}):\s/);
  if (
    !prefix ||
    technical(prefix[1]) ||
    /[{}\[\]<>"\\]/.test(prefix[1]) ||
    /^(?:Scheduled discovery|Employer discovery|Previous tasks|Error|Queue|Artifact storage|Draft for|https?)\b/i.test(
      prefix[1],
    )
  )
    return undefined;
  return compact(prefix[1]);
}

function opportunityAction(op?: Opportunity): ActivityAction {
  if (op && outreachColumn(op))
    return {
      label: "View startup outreach",
      page: "outreach",
      opportunityId: op.id,
    };
  return {
    label: op ? "View opportunity" : "View opportunities",
    page: op?.kind === "startup" ? "startups" : "jobs",
    ...(op ? { opportunityId: op.id } : {}),
  };
}

function actionForCategory(
  category: ActivityCategory,
  op?: Opportunity,
): ActivityAction | undefined {
  if (category === "resume") return { label: "Open Resume", page: "profile" };
  if (category === "preferences")
    return { label: "Review preferences", page: "settings" };
  if (category === "draft")
    return {
      label: "View drafts",
      page: "drafts",
      ...(op ? { opportunityId: op.id } : {}),
    };
  if (category === "research" && !op)
    return { label: "View startup prospects", page: "startups" };
  if (category === "outreach" && !op)
    return { label: "View startup outreach", page: "outreach" };
  if (
    ["search", "evaluation", "research", "application", "outreach"].includes(
      category,
    )
  )
    return opportunityAction(op);
  return undefined;
}

function inferCategory(event: Activity): ActivityCategory {
  if (event.category) return event.category;
  const message = event.message;
  if (/^(?:Master CV|Extracted resume|Resume)/i.test(message)) return "resume";
  if (/preferences saved/i.test(message)) return "preferences";
  if (/^(?:Outreach |Added .+ to outreach)/i.test(message)) return "outreach";
  if (/^(?:Prepared |Draft |Draft for )/i.test(message)) return "draft";
  if (
    /^(?:Scheduled discovery|Employer discovery|Discovery evaluated|\d+ new compan|New-company discovery|All selected sources|No job sources)/i.test(
      message,
    )
  )
    return "search";
  if (
    /^(?:Application|Marked .* as|Archived |Added opportunity)/i.test(message)
  )
    return "application";
  return "workspace";
}

type Explanation = Pick<
  ActivityItem,
  "description" | "nextStep" | "action" | "technicalDetails"
>;

function explainFailure(
  message: string,
  category: ActivityCategory,
  defaultAction?: ActivityAction,
): Explanation {
  const raw = compact(message);
  const diagnostic = { technicalDetails: details(message) };
  const fallback = defaultAction ?? actionForCategory(category);
  const aiContext = /OpenAI|ChatGPT|\bAI\b|OPENAI_API_KEY/i.test(raw);
  const validation =
    /invalid_type|ZodError|invalid input:|expected .+received|"path"\s*:/.test(
      raw,
    );
  if (validation && /profile|resume|headline|career|skills/i.test(raw))
    return {
      description: "RoleLoop couldn’t read some saved resume information.",
      nextStep:
        "Open Resume to check your details. If they look correct and this happens again, restart RoleLoop and try the action again.",
      action: { label: "Open Resume", page: "profile" },
      ...diagnostic,
    };
  if (validation)
    return {
      description: "RoleLoop couldn’t read some saved workspace information.",
      nextStep:
        "Try the action again. If this continues, restart RoleLoop and share the technical details for help.",
      action: fallback,
      ...diagnostic,
    };
  if (/daily draft limit/i.test(raw))
    return {
      description: "The daily draft limit was reached.",
      nextStep:
        "Wait until tomorrow or change your daily limit in Search preferences.",
      action: { label: "Review preferences", page: "settings" },
      ...diagnostic,
    };
  if (/Company discovery has reached.*limit|50-source limit/i.test(raw))
    return {
      description:
        "The company-search limit prevented further companies from being added.",
      nextStep:
        "Existing company searches can continue. Open your opportunities to review their results.",
      action: { label: "View opportunities", page: "jobs" },
      ...diagnostic,
    };
  if (/rate.?limit|too many requests|\b429\b|quota|usage limit/i.test(raw))
    return {
      description: "A service limit prevented this task from finishing.",
      nextStep: aiContext
        ? "Wait before trying again, or check your AI connection and usage in Account."
        : "Wait before trying again. The service may temporarily limit how often it can be checked.",
      action: aiContext ? { label: "Open Account", page: "account" } : fallback,
      ...diagnostic,
    };
  if (
    /OPENAI_API_KEY|AI.+(?:not configured|unavailable)|no.+AI provider|plan usage|ChatGPT.+(?:connect|sign|session)|(?:token|session).+(?:expired|invalid)|sign.?in required|authentication required/i.test(
      raw,
    ) ||
    (aiContext && /API key|unauthori[sz]ed|\b401\b|\b403\b/i.test(raw))
  )
    return {
      description: "The task couldn’t access the service it needed.",
      nextStep:
        "Check your sign-in and AI connection in Account, then try again. A scheduled search uses the server’s AI configuration.",
      action: { label: "Open Account", page: "account" },
      ...diagnostic,
    };
  if (/API key/i.test(raw))
    return {
      description: "The source’s connection settings prevented this request.",
      nextStep:
        "Try another available source. If this continues, share the technical details for help.",
      action: fallback,
      ...diagnostic,
    };
  if (/unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(raw))
    return {
      description:
        category === "search"
          ? "This source could not be accessed because it did not allow the request."
          : "A service did not allow this request.",
      nextStep:
        "Review the technical details to identify the service. Try again later, or use another source if access is restricted.",
      action: fallback,
      ...diagnostic,
    };
  if (/interrupted.+(?:shutdown|restart)|worker shutdown/i.test(raw))
    return {
      description: "RoleLoop stopped before this task finished.",
      nextStep: "Review any saved results before starting the action again.",
      action: fallback,
      ...diagnostic,
    };
  if (/all selected sources failed/i.test(raw))
    return {
      description:
        "None of the selected sources finished successfully. Any results already saved remain available.",
      nextStep:
        "Review any available source details, then try the search again later.",
      action: fallback ?? { label: "Open job search", page: "jobs" },
      ...diagnostic,
    };
  if (/no job sources|no.+sources.+enabled|research is paused/i.test(raw))
    return {
      description: /research is paused/i.test(raw)
        ? "Startup research was paused."
        : "There were no active company searches to check.",
      nextStep: /research is paused/i.test(raw)
        ? "Resume research from Startup prospects when you’re ready."
        : "Enable company discovery in Search preferences or resume a saved company search.",
      action: /research is paused/i.test(raw)
        ? { label: "Open startup prospects", page: "startups" }
        : { label: "Review preferences", page: "settings" },
      ...diagnostic,
    };
  if (
    /timeout|timed out|took too long|ETIMEDOUT|aborted due to timeout/i.test(
      raw,
    )
  )
    return {
      description: "The service took too long to respond.",
      nextStep:
        category === "resume"
          ? "Open Resume to check the saved document and retry processing."
          : "Try the action again later. Any results already saved remain available.",
      action: fallback,
      ...diagnostic,
    };
  if (
    /fetch failed|failed to fetch|network|ECONN|ENOTFOUND|socket|connection refused|\bHTTP\s*5\d\d\b|bad gateway|service unavailable/i.test(
      raw,
    )
  )
    return {
      description: "RoleLoop couldn’t reach a service needed for this task.",
      nextStep:
        "Check your connection and try again later. Other saved opportunities are still available.",
      action: fallback,
      ...diagnostic,
    };
  if (
    /Master CV processing failed|resume.+(?:process|extract).+failed|upload a master CV|readable text|encrypted PDF|scanned/i.test(
      raw,
    )
  )
    return {
      description:
        "Resume details couldn’t be prepared for matching and drafts.",
      nextStep:
        "Open Resume to review the processing message and retry or replace the document.",
      action: { label: "Open Resume", page: "profile" },
      ...diagnostic,
    };
  if (
    /changed during|stale|outdated|no longer matches|regenerat|Resolve the exclusion/i.test(
      raw,
    )
  )
    return {
      description:
        "The saved information needs another review before this action can finish.",
      nextStep:
        "Review the opportunity and its matching details, then prepare a fresh draft if needed.",
      action: fallback,
      ...diagnostic,
    };
  return {
    description: technical(raw)
      ? "RoleLoop couldn’t finish this action. The detailed error is available below."
      : raw || "RoleLoop couldn’t finish this action.",
    nextStep:
      "Review any saved results and try again. If this continues, share the technical details for help.",
    action: fallback,
    ...diagnostic,
  };
}

function eventItem(event: Activity, op?: Opportunity): ActivityItem {
  const category = inferCategory(event);
  const message = compact(event.message);
  const item: ActivityItem = {
    id: `event:${event.id}`,
    title: "Workspace update",
    description: "An update was recorded in your workspace.",
    category,
    status: event.kind,
    createdAt: event.createdAt,
    action: actionForCategory(category, op),
  };
  if (event.kind === "error") {
    const source =
      category === "search" ? sourceLabel(event.message) : undefined;
    item.title = /^Scheduled discovery:/i.test(message)
      ? "Scheduled search couldn’t start"
      : source
        ? `Search issue · ${source}`
        : /^Draft for /i.test(message)
          ? `Draft couldn’t be prepared${op ? ` · ${displayLabel(op.company, "this company")}` : ""}`
          : category === "resume"
            ? "Resume processing failed"
            : category === "search"
              ? "Search encountered a problem"
              : "An action couldn’t finish";
    return {
      ...item,
      ...explainFailure(
        event.message,
        category,
        category === "draft" ? opportunityAction(op) : item.action,
      ),
    };
  }
  if (/^Master CV processed\./i.test(message))
    return {
      ...item,
      title: "Resume ready",
      description:
        "Career details are ready for matching and draft preparation.",
    };
  if (/^Extracted resume information cleared\./i.test(message))
    return {
      ...item,
      title: "Extracted resume details cleared",
      description:
        "The original resume is still available. Extract its details again when you’re ready.",
    };
  if (/preferences saved/i.test(message))
    return {
      ...item,
      title: "Search preferences saved",
      description: "Your search and automation settings were saved.",
    };
  const prepared = message.match(
    /^Prepared (application|founder outreach) draft for (.+)\.$/,
  );
  if (prepared && !technical(message))
    return {
      ...item,
      title: `${prepared[1] === "application" ? "Application" : "Outreach"} draft prepared`,
      description: `${displayLabel(prepared[2], "Your draft")}. Ready for your review; nothing was sent.`,
      category: "draft",
      action: actionForCategory("draft", op),
    };
  if (/^Draft approved for local testing/i.test(message))
    return {
      ...item,
      title: "Draft approved for a local test",
      description:
        "This historical approval did not submit an application or contact an employer.",
    };
  if (/^(?:Mailpit only:|Mock application accepted locally)/i.test(message))
    return {
      ...item,
      title: "Local test completed",
      description: "This was a local test. No employer was contacted.",
      category: "draft",
      action: actionForCategory("draft", op),
      technicalDetails: details(event.message),
    };
  const evaluated = message.match(/^Discovery evaluated (\d+) opportunities/);
  if (evaluated) {
    const failures = message.match(/(\d+) source\(s\) failed/);
    return {
      ...item,
      title: failures ? "Search finished with issues" : "Search finished",
      description: `${plural(Number(evaluated[1]), "opportunity", "opportunities")} evaluated, including any already in your workspace.${failures ? ` ${plural(Number(failures[1]), "source")} did not finish successfully.` : ""}`,
      status: failures ? "partial" : item.status,
      category: "search",
      action: actionForCategory("search", op),
    };
  }
  if (/^Employer discovery:/i.test(message))
    return {
      ...item,
      ...explainFailure(
        event.message,
        "search",
        actionForCategory("search", op),
      ),
      title: "A company couldn’t be checked",
      category: "search",
    };
  if (/Company discovery has reached.*limit|50-source limit/i.test(message))
    return {
      ...item,
      title: "Company discovery limit reached",
      category: "search",
      ...explainFailure(message, "search"),
      description: technical(message)
        ? "The company-search limit prevented further companies from being added."
        : message,
    };
  if (
    /^(?:New-company discovery was unavailable|\d+ companies connected before discovery stopped)/i.test(
      message,
    )
  )
    return {
      ...item,
      title: "Company discovery couldn’t finish",
      category: "search",
      ...explainFailure(message, "search", actionForCategory("search", op)),
    };
  if (
    /^(?:\d+ new compan|\d+ companies connected before|New-company discovery|Company discovery has reached|Set your target roles|New company discovery)/i.test(
      message,
    )
  )
    return {
      ...item,
      title:
        event.kind === "warning"
          ? "Company discovery needs review"
          : "Company discovery finished",
      category: "search",
      description: technical(message)
        ? "Some companies could not be checked during this search."
        : message.replace(/Settings/g, "Search preferences"),
      ...(event.kind === "warning"
        ? {
            nextStep: /target roles|working country/i.test(message)
              ? "Review your search preferences before searching again."
              : "Review the search results and try again later if needed.",
            technicalDetails: details(event.message),
          }
        : {}),
      action: /target roles|working country/i.test(message)
        ? { label: "Review preferences", page: "settings" }
        : actionForCategory("search", op),
    };
  if (technical(message))
    return {
      ...item,
      ...explainFailure(event.message, category, item.action),
      title: "Workspace update needs review",
      status: event.kind === "success" ? "info" : event.kind,
    };
  const applicationChange = message.match(
    /^Application status updated for (.+): (Saved|Applied|Interview|Offer|Rejected|Withdrawn) → (Saved|Applied|Interview|Offer|Rejected|Withdrawn)\.$/,
  );
  if (applicationChange)
    return {
      ...item,
      title: `Application marked as ${applicationChange[3].toLowerCase()}`,
      description: `${applicationChange[1]}. ${applicationChange[2]} → ${applicationChange[3]}.`,
      category: "application",
    };
  const archived = message.match(/^Archived (.+)\.$/);
  if (archived)
    return {
      ...item,
      title: "Opportunity archived",
      description: `${archived[1]} moved to your archive.`,
      category: "application",
    };
  const restored = message.match(/^Restored (.+) from the archive\.$/);
  if (restored)
    return {
      ...item,
      title: "Opportunity restored",
      description: `${restored[1]} returned to your opportunities.`,
      category: "application",
    };
  const added = message.match(/^Added (job|startup prospect): (.+)\.$/);
  if (added)
    return {
      ...item,
      title: added[1] === "job" ? "Job added" : "Startup prospect added",
      description: `${added[2]} was saved to your opportunities.`,
      category: "application",
      action:
        !op && added[1] === "startup prospect"
          ? { label: "View startup prospects", page: "startups" }
          : opportunityAction(op),
    };
  return {
    ...item,
    title:
      category === "outreach"
        ? "Outreach updated"
        : category === "application"
          ? "Opportunity updated"
          : category === "draft"
            ? "Draft updated"
            : category === "search"
              ? "Search update"
              : "Workspace update",
    description: message || item.description,
  };
}

function runItem(run: Run, op?: Opportunity): ActivityItem {
  const category: ActivityCategory =
    run.action === "discover"
      ? "search"
      : run.action === "analyze"
        ? "evaluation"
        : run.action === "research"
          ? "research"
          : run.action === "draft" || run.action === "simulate"
            ? "draft"
            : "workspace";
  const baseTitle =
    run.action === "discover"
      ? run.discoveryScope === "startups"
        ? "Startup search"
        : "Job search"
      : run.action === "analyze"
        ? "Opportunity evaluation"
        : run.action === "research"
          ? "Company research"
          : run.action === "draft"
            ? "Draft preparation"
            : run.action === "simulate"
              ? "Local test"
              : "Background task";
  const action =
    run.action === "discover"
      ? {
          label:
            run.discoveryScope === "startups"
              ? "View startup prospects"
              : "View opportunities",
          page:
            run.discoveryScope === "startups"
              ? ("startups" as const)
              : ("jobs" as const),
        }
      : actionForCategory(category, op);
  const partial =
    run.outcome === "partial" ||
    !!run.summary?.sourcesFailed ||
    !!run.summary?.draftFailures ||
    !!run.summary?.evaluationFailures ||
    !!run.summary?.researchFailures ||
    /\b[1-9]\d* source\(s\) failed/i.test(run.message);
  const item: ActivityItem = {
    id: `run:${run.id}`,
    title: `${baseTitle}${op ? ` · ${displayLabel(op.company, "this company")}` : ""}`,
    description: "",
    category,
    status:
      run.status === "completed"
        ? partial
          ? "partial"
          : "success"
        : run.status === "failed"
          ? "error"
          : run.status === "queued" || run.status === "running"
            ? run.status
            : "info",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    action,
    run,
    ...(run.summary ? { summary: run.summary } : {}),
  };
  if (run.status === "failed")
    return {
      ...item,
      ...explainFailure(
        run.message,
        category,
        run.action === "draft" ? opportunityAction(op) : action,
      ),
    };
  if (run.status === "queued" || run.status === "running") {
    const progress = Number.isFinite(run.progress)
      ? Math.max(0, Math.min(100, run.progress))
      : 0;
    const message = compact(run.message);
    return {
      ...item,
      progress,
      description:
        run.status === "queued"
          ? "Waiting to start. RoleLoop needs to stay open while this task runs."
          : /^Worker started$/i.test(message)
            ? "Getting started…"
            : technical(message) || !message
              ? "Working on this task…"
              : message,
      ...(technical(message) ? { technicalDetails: details(run.message) } : {}),
    };
  }
  if (run.action === "discover") {
    const summary = run.summary;
    const legacyCount = run.message.match(/Evaluated (\d+) opportunities/i);
    item.description = summary
      ? summary.evaluated
        ? "The search evaluated opportunities against your resume and search preferences."
        : "No opportunities were evaluated in this search."
      : legacyCount
        ? `${plural(Number(legacyCount[1]), "opportunity", "opportunities")} evaluated. This includes opportunities already in your workspace.`
        : technical(run.message)
          ? "The search finished. Open your opportunities to review the results."
          : compact(run.message) || "The search finished.";
    if (partial) {
      const sourceFailures =
        summary?.sourcesFailed ??
        Number(run.message.match(/(\d+) source\(s\) failed/i)?.[1] ?? 0);
      if (sourceFailures)
        item.description += ` ${plural(sourceFailures, "source")} did not finish successfully.`;
      if (summary?.evaluationFailures)
        item.description += ` ${plural(summary.evaluationFailures, "AI evaluation")} could not finish; those opportunities need review.`;
      if (summary?.researchFailures)
        item.description += ` ${plural(summary.researchFailures, "company website")} could not be researched; the saved leads remain available.`;
      if (
        !sourceFailures &&
        !summary?.evaluationFailures &&
        !summary?.researchFailures
      )
        item.description += " Some parts of the search could not finish.";
      item.nextStep =
        "Review the results and the issues from this search. You can search again later.";
    }
    return item;
  }
  item.description =
    run.action === "analyze"
      ? `Matching evidence and eligibility were checked${op ? ` for ${displayLabel(op.title, "this opportunity")}` : ""}. Open the opportunity to review the assessment.`
      : run.action === "research"
        ? "Public company information was saved. Review the facts before preparing outreach."
        : run.action === "draft"
          ? "Your draft is ready to review. Nothing was sent."
          : run.action === "simulate"
            ? "This was a local test. No employer was contacted."
            : "The task finished.";
  return item;
}

export function buildActivityItems(
  data: Pick<Bootstrap, "runs" | "events" | "opportunities">,
): ActivityItem[] {
  const opportunities = new Map(data.opportunities.map((op) => [op.id, op]));
  const runs = new Map(
    data.runs.map((run) => [
      run.id,
      runItem(run, opportunities.get(run.opportunityId ?? "")),
    ]),
  );
  const standalone: ActivityItem[] = [];
  for (const event of data.events) {
    const item = eventItem(event, opportunities.get(event.opportunityId ?? ""));
    const run = event.runId ? runs.get(event.runId) : undefined;
    if (run) (run.events ??= []).push(item);
    else standalone.push(item);
  }
  const newestFirst = (a: ActivityItem, b: ActivityItem) =>
    (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) ||
    a.id.localeCompare(b.id);
  for (const run of runs.values()) {
    run.events?.sort(newestFirst);
    if (
      run.status === "success" &&
      run.events?.some((event) =>
        ["warning", "error", "partial"].includes(event.status),
      )
    ) {
      run.status = "partial";
      run.nextStep =
        "Review the results and the issues recorded during this task.";
    }
  }
  return [...runs.values(), ...standalone].sort(newestFirst);
}
