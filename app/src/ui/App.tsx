import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Archive,
  Briefcase,
  Columns3,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  FileUser,
  Inbox,
  LoaderCircle,
  LogOut,
  MessagesSquare,
  Pencil,
  Plus,
  Rocket,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type {
  AccountContext,
  Bootstrap,
  Draft,
  Opportunity,
  Preferences,
  Profile,
  RunAction,
} from "../shared/types";
import { api, date, downloadFile, safeUrl, write } from "./api";
import { jobLocationStatus } from "../shared/job-matches";
import { recommendationForJob } from "../shared/job-recommendations";
import {
  opportunityMatchesView,
  type OpportunityView,
} from "../shared/opportunity-views";
import { OpportunityFilters } from "./OpportunityFilters";
import { StartupProspectFilters } from "./StartupProspectFilters";
import {
  startupMatchesQuery,
  startupMatchesSource,
  startupMatchesView,
  startupSourceLabels,
  startupSourceOptions,
  type StartupView,
} from "../shared/startup-prospects";
import {
  jobMatchesSource,
  jobSourceLabels,
  jobSourceOptions,
  type JobSourceFilter,
} from "../shared/job-sources";
import { ApplicationsBoard } from "./ApplicationsBoard";
import { OutreachBoard } from "./OutreachBoard";
import { OutreachProgress } from "./OutreachProgress";
import { OutreachPreparation } from "./OutreachPreparation";
import {
  isTrackedOutreach,
  outreachColumn,
  outreachProgressFor,
} from "../shared/outreach-board";
import { JobFitDetails } from "./JobFitDetails";
import { StartupFitDetails } from "./StartupFitDetails";
import {
  StartupCompanyOverview,
  StartupContributionPreview,
  StartupIndustryLabels,
  StartupSignalPreview,
} from "./StartupCompanyProfile";
import { opportunityMatchesQuery } from "../shared/opportunity-search";
import { startupSummary } from "../shared/startup-company";
import { sourceKind } from "../shared/discovery";
import {
  applicationColumn,
  applicationProgressFor,
  isTrackedApplication,
} from "../shared/application-board";
import { ApplicationProgress } from "./ApplicationProgress";
import { SalaryFields } from "./SalaryFields";
import { SalaryPolicies } from "./SalaryPolicies";
import { FreshnessPreferences } from "./FreshnessPreferences";
import { MatchingPreferences } from "./MatchingPreferences";
import { TargetRolesInput } from "./TargetRolesInput";
import { IndustryInterests } from "./IndustryInterests";
import { AutomationPreferences } from "./AutomationPreferences";
import { ResumePage } from "./ResumePage";
import { EditorHeader } from "./EditorHeader";
import { ActivityPage } from "./ActivityPage";
import { routeOpportunity, routePage } from "./navigation";
import { WorkspaceStatus, serverUnavailable } from "./WorkspaceStatus";
import {
  industryPriorityBoost,
  preferredIndustryMatches,
} from "../shared/industries";

type Page =
  | "jobs"
  | "applications"
  | "startups"
  | "outreach"
  | "drafts"
  | "profile"
  | "settings"
  | "activity"
  | "account";
type Perform = (
  task: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;
const nav = [
  { id: "jobs", label: "Job opportunities", icon: Briefcase },
  { id: "applications", label: "Applications", icon: Columns3 },
  { id: "startups", label: "Startup prospects", icon: Rocket },
  { id: "outreach", label: "Startup outreach", icon: MessagesSquare },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "profile", label: "Resume", icon: FileUser },
  { id: "settings", label: "Search preferences", icon: SlidersHorizontal },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "account", label: "Account", icon: UserRound },
] as const;
const statusLabels: Record<string, string> = {
  new: "New",
  review: "Needs review",
  ready: "Ready to draft",
  drafted: "Draft prepared",
  approved: "Approved",
  tested: "Tested",
  archived: "Archived",
  excluded: "Outside criteria",
  draft: "Draft",
};

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span className={`badge badge-${value}`}>
      {statusLabels[value] || value}
    </span>
  );
}
function opportunityBadge(opportunity: Opportunity) {
  return opportunity.stage !== "archived" &&
    opportunity.assessment?.recommendation === "excluded"
    ? "excluded"
    : opportunity.stage;
}
function External({ url, children }: { url: string; children: ReactNode }) {
  const href = safeUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-link">
      {children}
      <ArrowUpRight size={14} />
    </a>
  ) : null;
}
function Field({
  label,
  children,
  hint,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Empty({
  icon = <Inbox size={29} />,
  title,
  detail,
  children,
}: {
  icon?: ReactNode;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {children && <div className="button-row">{children}</div>}
    </div>
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <IconButton label="Close dialog" onClick={close}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}

export function App({
  account,
  onSignOut,
  accountPage,
  accountNotice,
}: {
  account: AccountContext;
  onSignOut: () => void;
  accountPage: ReactNode;
  accountNotice: string;
}) {
  const [data, setData] = useState<Bootstrap | null>(null),
    [failure, setFailure] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState<Page>(() =>
      nav.some((n) => n.id === routePage(location.hash))
        ? (routePage(location.hash) as Page)
        : "jobs",
    );
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Bootstrap>("/bootstrap");
      if (!mounted.current) return;
      setData(next);
      setFailure(null);
    } catch (e) {
      if (
        !mounted.current ||
        (e instanceof DOMException && e.name === "AbortError")
      )
        return;
      setFailure(
        e instanceof Error ? e : new Error("Unable to load your workspace."),
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.error ? 10000 : 4500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const changed = () => {
      const next = routePage(location.hash);
      if (next === "sources") {
        history.replaceState(null, "", "#jobs");
        setPage("jobs");
      } else if (nav.some((n) => n.id === next)) setPage(next as Page);
    };
    changed();
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const navigate = (next: Page) => {
    setPage(next);
    location.hash = next;
  };
  useEffect(() => {
    const revealNavigation = () => {
      const active = document.querySelector<HTMLElement>(".nav-item.active");
      const container = active?.parentElement;
      if (active && container && window.innerWidth < 700) {
        container.scrollTo({
          left: Math.max(0, active.offsetLeft - container.offsetLeft - 12),
        });
      }
    };
    revealNavigation();
    window.addEventListener("resize", revealNavigation);
    return () => window.removeEventListener("resize", revealNavigation);
  }, [page, Boolean(data)]);
  const perform: Perform = async (task, success) => {
    setBusy(true);
    try {
      await task();
      await refresh();
      if (success) setToast({ message: success, error: false });
      return true;
    } catch (e) {
      setToast({
        message:
          e instanceof Error
            ? e.message
            : "Something went wrong. Please try again.",
        error: true,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return <WorkspaceStatus failure={failure} onRetry={() => void refresh()} />;
  const running = data.runs.filter(
    (r) => r.status === "queued" || r.status === "running",
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#jobs" onClick={() => navigate("jobs")} className="brand">
          <span className="brand-mark" />
          RoleLoop<span className="brand-period">.</span>
        </a>
        <nav aria-label="Main navigation">
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              className={`nav-item ${page === id ? "active" : ""} ${id === "profile" ? "nav-break" : ""}`}
              key={id}
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "drafts" && data.drafts.length > 0 && (
                <span className="nav-count">{data.drafts.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-account">
          <button
            type="button"
            className="sidebar-identity"
            onClick={() => navigate("account")}
            title={account.user.email}
          >
            <span className="account-avatar small">
              {(account.user.name || account.user.email)
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span>
              <strong>{account.user.name || account.user.email}</strong>
              <small>{account.user.email}</small>
            </span>
          </button>
          <IconButton label="Sign out" onClick={onSignOut}>
            <LogOut size={16} />
          </IconButton>
        </div>
        <div className="sidebar-bottom">
          <div className="test-seal">
            <ShieldCheck size={17} />
            <div>
              <strong>Local test mode</strong>
              <small>No live applications or emails</small>
            </div>
          </div>
          <div className="service-row">
            <i className={data.status.database ? "live" : ""} />
            Database{" "}
            <span>{data.status.database ? "Connected" : "Offline"}</span>
          </div>
          <div className="service-row">
            <i className={data.status.worker ? "live" : ""} />
            Worker <span>{data.status.worker ? "Running" : "Offline"}</span>
          </div>
          <div className="sidebar-links">
            <External url={data.status.studioUrl}>Studio</External>
          </div>
        </div>
      </aside>
      <main className="main-area">
        {accountNotice && page !== "account" && (
          <div className="notice neutral" role="status">
            <ShieldCheck size={16} />
            <span>{accountNotice}</span>
          </div>
        )}
        {failure && (
          <div className="notice error" role="alert">
            <AlertTriangle size={16} />
            {serverUnavailable(failure)
              ? "Connection interrupted"
              : "Workspace refresh failed"}
            : {failure.message}
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        )}

        {running.length > 0 && page !== "activity" && (
          <div className="run-strip" aria-live="polite">
            <LoaderCircle size={15} className="spin" />
            <span>{running[0].message || `${running[0].action} queued`}</span>
            <span className="muted">
              {running.length > 1
                ? `${running.length} tasks`
                : `${running[0].progress}%`}
            </span>
            <div className="run-track">
              <div style={{ width: `${running[0].progress}%` }} />
            </div>
          </div>
        )}
        {(page === "jobs" ||
          page === "startups" ||
          page === "outreach" ||
          page === "applications") && (
          <Opportunities
            key={page}
            kind={
              page === "startups" || page === "outreach" ? "startup" : "job"
            }
            board={page === "applications" || page === "outreach"}
            data={data}
            perform={perform}
            busy={busy}
            navigate={navigate}
          />
        )}
        {page === "drafts" && (
          <Drafts data={data} perform={perform} busy={busy} />
        )}
        {page === "profile" && (
          <ResumePage initial={data.profile} perform={perform} busy={busy} />
        )}
        {page === "settings" && (
          <PreferencesEditor
            initial={data.preferences}
            perform={perform}
            busy={busy}
          />
        )}
        {page === "activity" && <ActivityPage data={data} />}
        {page === "account" && accountPage}
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? (
            <AlertTriangle size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>{toast.message}</span>
          <IconButton label="Dismiss message" onClick={() => setToast(null)}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function Opportunities({
  kind,
  board = false,
  data,
  perform,
  busy,
  navigate,
}: {
  kind: Opportunity["kind"];
  board?: boolean;
  data: Bootstrap;
  perform: Perform;
  busy: boolean;
  navigate: (p: Page) => void;
}) {
  const [query, setQuery] = useState(""),
    [sourceFilter, setSourceFilter] = useState<JobSourceFilter>("all"),
    [startupSource, setStartupSource] = useState("all"),
    [stage, setStage] = useState(() => {
      const id = routeOpportunity(location.hash);
      return id
        ? data.opportunities.find((op) => op.id === id)?.stage === "archived"
          ? "archived"
          : "all"
        : kind === "job"
          ? "recommended"
          : "explore";
    }),
    [visibleCount, setVisibleCount] = useState(() =>
      routeOpportunity(location.hash) || kind === "startup" ? 50 : 10,
    ),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [selected, setSelected] = useState<string | null>(() =>
      routeOpportunity(location.hash),
    );
  useEffect(() => {
    const selectFromLink = () => {
      const id = routeOpportunity(location.hash);
      if (!id) return;
      setSelected(id);
      setQuery("");
      setSourceFilter("all");
      setStartupSource("all");
      setVisibleCount(50);
      setStage(
        data.opportunities.find((op) => op.id === id)?.stage === "archived"
          ? "archived"
          : "all",
      );
    };
    window.addEventListener("hashchange", selectFromLink);
    return () => window.removeEventListener("hashchange", selectFromLink);
  }, [data.opportunities]);
  const changeView = (next: string) => {
    setStage(next);
    setVisibleCount(next === "recommended" ? 10 : 50);
    setChecked(new Set());
    setSelected(null);
  };
  const all = data.opportunities.filter((o) => o.kind === kind),
    list = all.filter((o) =>
      kind === "job"
        ? opportunityMatchesView(
            o,
            data.preferences,
            stage as OpportunityView,
          ) &&
          jobMatchesSource(o, data.sources, sourceFilter) &&
          opportunityMatchesQuery(o, query)
        : startupMatchesView(o, stage as StartupView) &&
          startupMatchesSource(o, startupSource) &&
          startupMatchesQuery(o, query),
    );
  const hasQuery = Boolean(query.trim());
  const hasStartupFilter = hasQuery || startupSource !== "all";
  const hasSourceFilter = kind === "job" && sourceFilter !== "all";
  const sourceFilterLabel =
    sourceFilter === "all" ? "All sources" : jobSourceLabels[sourceFilter];
  const sourceOptions = jobSourceOptions(all, data.sources);
  if (
    sourceFilter !== "all" &&
    !sourceOptions.some((option) => option.value === sourceFilter)
  )
    sourceOptions.push({
      value: sourceFilter,
      label: jobSourceLabels[sourceFilter],
    });
  const hasActive = all.some((opportunity) => opportunity.stage !== "archived");
  const visibleList = list.slice(0, visibleCount);
  const recommendations = new Map(
    kind === "job"
      ? all.map((opportunity) => [
          opportunity.id,
          recommendationForJob(opportunity, data.preferences),
        ])
      : [],
  );
  const chosen = (
    board
      ? all.filter((o) =>
          kind === "startup" ? outreachColumn(o) : applicationColumn(o),
        )
      : kind === "startup"
        ? all
        : list
  ).find((o) => o.id === selected);
  const chosenFit = chosen ? recommendations.get(chosen.id) : undefined;
  const isTracked = kind === "job" ? isTrackedApplication : isTrackedOutreach;
  const selectedOpportunities = list.filter(
    (o) => checked.has(o.id) && !isTracked(o) && o.stage !== "archived",
  );
  const addToApplications = async (jobs: Opportunity[]) => {
    const added = await perform(
      async () => {
        for (const job of jobs) {
          await write(
            `/opportunities/${job.id}`,
            { application: applicationProgressFor(job, "saved") },
            "PATCH",
          );
        }
      },
      `${jobs.length === 1 ? "Job" : `${jobs.length} jobs`} added to To apply.`,
    );
    if (added) setChecked(new Set());
  };
  const addToOutreach = async (startups: Opportunity[]) => {
    const added = await perform(
      async () => {
        for (const startup of startups) {
          await write(
            `/opportunities/${startup.id}`,
            { outreach: outreachProgressFor(startup, "saved") },
            "PATCH",
          );
        }
      },
      `${startups.length === 1 ? "Startup" : `${startups.length} startups`} added to To contact.`,
    );
    if (added) setChecked(new Set());
  };
  const run = (action: RunAction, id: string) =>
    perform(
      () => write("/runs", { action, opportunityId: id }),
      `${action === "draft" ? "Draft preparation" : action === "research" ? "Research" : "Evaluation"} queued.`,
    );
  const relatedDrafts = chosen
    ? data.drafts.filter((d) => d.opportunityId === chosen.id)
    : [];
  const searching = data.runs.some(
    (r) =>
      r.action === "discover" &&
      ["queued", "running"].includes(r.status) &&
      (r.discoveryScope ?? "jobs") === (kind === "job" ? "jobs" : "startups"),
  );
  const inSearch = (source: Bootstrap["sources"][number]) =>
    kind === "startup"
      ? sourceKind(source) === "startup_feed"
      : sourceKind(source) !== "startup_feed";
  const configured = data.sources.filter(inSearch);
  const hasEnabledSources = configured.some((source) => source.enabled);
  const canFindCompanies =
    (data.preferences.discoverEmployers ?? true) &&
    data.preferences.roles.some((role) => role.trim()) &&
    Boolean(data.preferences.country.trim()) &&
    data.sources.length < 50;
  const paused =
    configured.length > 0 &&
    !hasEnabledSources &&
    (kind === "startup" || !canFindCompanies);
  const canSearch =
    kind === "startup" || hasEnabledSources || canFindCompanies || paused;
  const searchLabel = paused
    ? kind === "job"
      ? "Resume job search"
      : "Resume startup search"
    : kind === "job"
      ? "Search jobs"
      : "Search startups";
  const search = () =>
    perform(
      async () => {
        if (paused) {
          const current = await api<Bootstrap>("/bootstrap");
          // Resume only after an explicit click, retaining unrelated paused choices.
          if (
            !current.sources.some(
              (source) => inSearch(source) && source.enabled,
            )
          )
            await write(
              "/sources",
              {
                sources: current.sources.map((source) =>
                  inSearch(source) ? { ...source, enabled: true } : source,
                ),
                expectedRevision: current.sourcesRevision ?? 0,
              },
              "PUT",
            );
        }
        await write("/runs", {
          action: "discover",
          discoveryScope: kind === "job" ? "jobs" : "startups",
        });
      },
      kind === "job" ? "Job search queued." : "Startup search queued.",
    );
  const inspector = chosen ? (
    <aside
      className={`inspector job-inspector ${kind === "startup" ? "startup-inspector" : ""}`}
    >
      <div className="inspector-top">
        <button
          className="text-button back-to-list"
          onClick={() => setSelected(null)}
        >
          <ArrowLeft size={15} />
          Back to list
        </button>
        <Badge value={opportunityBadge(chosen)} />
        <div className="button-row">
          <IconButton
            label={
              chosen.stage === "archived"
                ? "Restore opportunity"
                : "Archive opportunity"
            }
            disabled={busy}
            onClick={() =>
              void perform(
                () =>
                  write(
                    `/opportunities/${chosen.id}`,
                    {
                      stage: chosen.stage === "archived" ? "new" : "archived",
                    },
                    "PATCH",
                  ),
                chosen.stage === "archived"
                  ? "Opportunity restored."
                  : "Opportunity archived.",
              )
            }
          >
            <Archive size={16} />
          </IconButton>
        </div>
      </div>
      <div className="inspector-title">
        <div className={`company-monogram large ${kind}`}>
          {chosen.company.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <span className="company-name">
            {kind === "startup" ? "Startup prospect" : chosen.company}
          </span>
          <h2>{kind === "startup" ? chosen.company : chosen.title}</h2>
        </div>
      </div>
      {kind === "job" && board && (
        <ApplicationProgress
          key={`${chosen.id}:${JSON.stringify(chosen.application)}`}
          opportunity={chosen}
          busy={busy}
          perform={perform}
        />
      )}
      {kind === "startup" && board && (
        <OutreachProgress
          key={`${chosen.id}:${JSON.stringify(chosen.outreach)}`}
          opportunity={chosen}
          busy={busy}
          perform={perform}
        />
      )}
      {kind === "startup" && <StartupCompanyOverview opportunity={chosen} />}
      <div className="detail-grid">
        {kind === "job" && (
          <div className="job-salary">
            <small>Salary</small>
            <span>{salary(chosen)}</span>
          </div>
        )}
        {(kind === "job" ||
          !/^(unknown|location.*confirm)$/i.test(chosen.location.trim())) && (
          <div>
            <small>Location</small>
            <span>{chosen.location}</span>
          </div>
        )}
        {kind === "job" && (
          <div>
            <small>
              Hiring from {data.preferences.country || "your country"}
            </small>
            <span>
              {jobLocationStatus(chosen, data.preferences) === "eligible"
                ? "Eligible location"
                : jobLocationStatus(chosen, data.preferences) === "excluded"
                  ? "Outside hiring area"
                  : "Needs confirmation"}
            </span>
          </div>
        )}
        {kind === "startup" && chosen.companyCountry !== "Unknown" && (
          <div>
            <small>Company country</small>
            <span>{chosen.companyCountry}</span>
          </div>
        )}
        {kind === "startup" && chosen.remoteScope !== "unknown" && (
          <div>
            <small>Remote arrangement</small>
            <span>
              {
                {
                  worldwide: "Worldwide",
                  latam: "Latin America",
                  us: "US only",
                  onsite: "On-site",
                  unknown: "To confirm",
                }[chosen.remoteScope]
              }
            </span>
          </div>
        )}
        {(kind === "job" || chosen.publishedAt) && (
          <div>
            <small>{kind === "job" ? "Posted" : "Signal date"}</small>
            <span>{date(chosen.publishedAt)}</span>
          </div>
        )}
      </div>
      <div className="inspector-links">
        <External url={chosen.url}>
          {kind === "job" ? "View job posting" : "View source"}
          {chosen.source === "jobicy" ? " · Jobicy" : ""}
        </External>
        {chosen.companyCountrySource && (
          <External url={chosen.companyCountrySource}>
            Company country · {chosen.companyCountry}
          </External>
        )}
        {chosen.companyUrl && (
          <External url={chosen.companyUrl}>Company website</External>
        )}
      </div>
      <div className="action-bar">
        {kind === "job" && !board && chosen.stage !== "archived" && (
          <>
            {isTrackedApplication(chosen) ? (
              <button
                className="button"
                onClick={() => {
                  location.hash = `applications?opportunity=${encodeURIComponent(chosen.id)}`;
                }}
              >
                <Columns3 size={16} />
                View on application board
              </button>
            ) : (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void addToApplications([chosen])}
              >
                <Plus size={16} />
                Add to applications
              </button>
            )}
          </>
        )}
        {kind === "startup" &&
          !board &&
          chosen.stage !== "archived" &&
          (isTrackedOutreach(chosen) ? (
            <button
              className="button"
              onClick={() => {
                location.hash = `outreach?opportunity=${encodeURIComponent(chosen.id)}`;
              }}
            >
              <Columns3 size={16} />
              View on outreach board
            </button>
          ) : (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void addToOutreach([chosen])}
            >
              <Plus size={16} />
              Add to outreach
            </button>
          ))}
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void run(kind === "job" ? "analyze" : "research", chosen.id)
          }
        >
          {kind === "job" ? (
            <SlidersHorizontal size={15} />
          ) : (
            <Search size={15} />
          )}
          {kind === "job" ? "Re-evaluate fit" : "Research & evaluate"}
        </button>
      </div>
      {kind === "startup" && board && (
        <OutreachPreparation
          opportunity={chosen}
          drafts={data.drafts}
          runs={data.runs}
          busy={busy}
          perform={perform}
          onReviewFit={() =>
            document
              .getElementById("outreach-fit-details")
              ?.scrollIntoView({ block: "center" })
          }
        />
      )}
      {kind === "job" && (
        <JobFitDetails
          key={chosen.id}
          opportunity={chosen}
          profile={data.profile}
          fit={chosenFit}
        />
      )}
      {kind === "startup" && (
        <>
          {!!chosen.assessment?.blockers.length && (
            <NoticeList
              title="Outside your criteria"
              items={chosen.assessment.blockers}
              kind="error"
            />
          )}
          <div id={board ? "outreach-fit-details" : undefined}>
            <StartupFitDetails opportunity={chosen} profile={data.profile} />
          </div>
          {chosen.assessment && (
            <details className="startup-decision-details">
              <summary>
                Before outreach
                {chosen.assessment.unknowns.length > 0
                  ? ` · ${chosen.assessment.unknowns.length} things to confirm`
                  : " · evaluation details"}
              </summary>
              {chosen.assessment.unknowns.length > 0 && (
                <NoticeList
                  title="To confirm"
                  items={chosen.assessment.unknowns}
                  kind="warning"
                />
              )}
              {!!chosen.assessment.learningGaps?.length && (
                <NoticeList
                  title="Experience to discuss"
                  items={chosen.assessment.learningGaps}
                  kind="neutral"
                />
              )}
              {chosen.assessment.reasons.length > 0 && (
                <details className="startup-evaluation-details">
                  <summary>Evaluation notes</summary>
                  <NoticeList
                    title="Evaluation notes"
                    items={chosen.assessment.reasons}
                    kind="neutral"
                  />
                </details>
              )}
            </details>
          )}
        </>
      )}
      {kind === "startup" && (
        <div className="contact-detail">
          <h3>Public contact</h3>
          <p>{chosen.contactName || "Recipient not yet confirmed"}</p>
          {chosen.contactEmail && (
            <span className="mono">{chosen.contactEmail}</span>
          )}
          {chosen.contactSource && (
            <External url={chosen.contactSource}>Contact evidence</External>
          )}
          <small>Confirm the recipient and their role before outreach.</small>
        </div>
      )}
      {kind === "startup" && (
        <details className="description" open={!chosen.assessment}>
          <summary>Full company source text</summary>
          <p>
            {chosen.description ||
              "No company description saved yet. Research the company website to learn more."}
          </p>
        </details>
      )}
      {kind === "startup" && !!chosen.discoverySignals?.length && (
        <div className="form-section">
          <h3>Sources</h3>
          <ul className="startup-source-signals">
            {chosen.discoverySignals.map((signal) => (
              <li key={`${signal.source}:${signal.sourceKey}`}>
                <External url={signal.url}>{signal.title}</External>
                <small>
                  {signal.source === "hackernews"
                    ? "Show HN"
                    : signal.source === "seedcamp"
                      ? "Seedcamp"
                      : signal.source}
                  {signal.publishedAt
                    ? ` · ${date(signal.publishedAt)}`
                    : " · Date not provided"}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {kind === "startup" && chosen.notes && (
        <div className="notes">
          <h3>Your notes</h3>
          <p>{chosen.notes}</p>
        </div>
      )}
      {relatedDrafts.length > 0 && (
        <button
          className="draft-link"
          onClick={() => {
            location.hash = `drafts?opportunity=${encodeURIComponent(chosen.id)}`;
          }}
        >
          <FileText size={18} />
          <span>
            {relatedDrafts.length} prepared{" "}
            {relatedDrafts.length === 1 ? "draft" : "drafts"}
            <small>Open documents and drafts</small>
          </span>
          <ArrowRight size={16} />
        </button>
      )}
    </aside>
  ) : null;
  if (board)
    return (
      <section
        className="page applications-page"
        aria-labelledby="tracking-title"
      >
        <header className="page-heading">
          <div>
            <h1 id="tracking-title">
              {kind === "startup" ? "Startup outreach" : "Applications"}
            </h1>
            <p>
              {kind === "startup"
                ? "The companies you choose to contact, from first message to final outcome."
                : "The jobs you choose to pursue, from first application to final outcome."}
            </p>
          </div>
          <button
            className="button"
            onClick={() => navigate(kind === "startup" ? "startups" : "jobs")}
          >
            <Search size={16} />
            {kind === "startup" ? "Browse startup prospects" : "Browse jobs"}
          </button>
        </header>
        {kind === "startup" ? (
          <OutreachBoard
            opportunities={all}
            drafts={data.drafts}
            runs={data.runs}
            busy={busy}
            perform={perform}
            onSelect={(op) => setSelected(op.id)}
          />
        ) : (
          <ApplicationsBoard
            opportunities={all}
            drafts={data.drafts}
            runs={data.runs}
            busy={busy}
            perform={perform}
            onSelect={(op) => setSelected(op.id)}
          />
        )}
        {chosen && (
          <Modal
            title={
              kind === "startup" ? "Outreach details" : "Application details"
            }
            close={() => setSelected(null)}
          >
            {inspector}
          </Modal>
        )}
      </section>
    );
  return (
    <section
      className={`page opportunities-page ${kind === "startup" ? "startup-prospects-page" : ""}`}
      aria-labelledby="opportunities-title"
    >
      <header className="page-heading">
        <div>
          <h1 id="opportunities-title">
            {kind === "job" ? "Job opportunities" : "Startup prospects"}
          </h1>
          <p>
            {kind === "job"
              ? "Find promising roles and add the ones you want to pursue to Applications."
              : "Discover companies and add the ones you want to contact to Startup outreach."}
          </p>
        </div>
        <div className="button-row">
          <button
            className="button primary"
            disabled={busy || searching || !canSearch}
            onClick={() => void search()}
          >
            {searching ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Search size={16} />
            )}
            {searching ? "Searching…" : searchLabel}
          </button>
        </div>
      </header>
      {kind === "job" && !canSearch && (
        <p className="search-setup-note">
          Set your target roles and working country, and turn on automatic
          company discovery to start searching.{" "}
          <button className="text-button" onClick={() => navigate("settings")}>
            Set search preferences
          </button>
        </p>
      )}
      {paused && (
        <p className="search-setup-note">
          {kind === "job"
            ? "Searches of your saved companies are paused. Resume to include them again."
            : "Startup search is paused. Resume to find new companies."}
        </p>
      )}
      {(kind === "job" || all.length > 0) && (
        <div className="job-list-toolbar opportunity-browse-toolbar">
          {kind === "job" ? (
            <OpportunityFilters
              view={stage as OpportunityView}
              onViewChange={changeView}
              source={sourceFilter}
              sourceOptions={sourceOptions}
              onSourceChange={(source) => {
                setSourceFilter(source);
                setVisibleCount(stage === "recommended" ? 10 : 50);
                setChecked(new Set());
                setSelected(null);
              }}
            />
          ) : (
            <>
              <StartupProspectFilters
                view={stage as StartupView}
                onViewChange={changeView}
                source={startupSource}
                sourceOptions={startupSourceOptions(all)}
                onSourceChange={(source) => {
                  setStartupSource(source);
                  setVisibleCount(50);
                  setChecked(new Set());
                  setSelected(null);
                }}
              />
            </>
          )}
          <div className="opportunity-search-field">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label={
                kind === "job" ? "Search saved jobs" : "Search companies"
              }
              placeholder={
                kind === "job" ? "Search saved jobs…" : "Search companies…"
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleCount(stage === "recommended" ? 10 : 50);
                setChecked(new Set());
                setSelected(null);
              }}
            />
          </div>
          <span className="job-list-count" role="status">
            {visibleList.length < list.length
              ? `${visibleList.length} of ${list.length}`
              : list.length}{" "}
            {kind === "job"
              ? list.length === 1
                ? "job"
                : "jobs"
              : list.length === 1
                ? "company"
                : "companies"}
          </span>
        </div>
      )}
      {selectedOpportunities.length > 0 && (
        <div className="job-selection-bar" role="status">
          <span>{selectedOpportunities.length} selected</span>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void (kind === "job"
                ? addToApplications(selectedOpportunities)
                : addToOutreach(selectedOpportunities))
            }
          >
            <Plus size={15} />
            {kind === "job" ? "Add to applications" : "Add to outreach"}
          </button>
          <button className="text-button" onClick={() => setChecked(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <div
        className={`opportunity-workspace job-browser ${kind === "startup" ? "startup-browser" : ""}`}
      >
        <div className="opportunity-list">
          {list.length ? (
            visibleList.map((o) => (
              <div key={o.id} className="job-browse-row">
                {
                  <label className="job-select">
                    <input
                      type="checkbox"
                      aria-label={
                        kind === "startup"
                          ? `Select ${o.company}`
                          : `Select ${o.title} at ${o.company}`
                      }
                      disabled={busy || isTracked(o) || o.stage === "archived"}
                      checked={checked.has(o.id) && !isTracked(o)}
                      onChange={(event) =>
                        setChecked((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(o.id);
                          else next.delete(o.id);
                          return next;
                        })
                      }
                    />
                  </label>
                }
                <button
                  className={`opportunity-row ${chosen?.id === o.id ? "selected" : ""}`}
                  key={o.id}
                  onClick={() => setSelected(o.id)}
                >
                  <span className={`company-monogram ${kind}`}>
                    {o.company.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="opportunity-info">
                    {kind === "startup" ? (
                      <>
                        <strong className="startup-company-name">
                          {o.company}
                          {o.isDemo && <span className="demo-tag">SAMPLE</span>}
                        </strong>
                        <span className="startup-contribution-preview">
                          {startupSummary(o)}
                        </span>
                        <StartupIndustryLabels opportunity={o} />
                        <StartupSignalPreview opportunity={o} />
                        <StartupContributionPreview
                          opportunity={o}
                          profile={data.profile}
                        />
                      </>
                    ) : (
                      <>
                        <span className="company-name">
                          {o.company}
                          {o.isDemo && <span className="demo-tag">SAMPLE</span>}
                        </span>
                        <strong>{o.title}</strong>
                      </>
                    )}
                    {kind === "job" &&
                      stage !== "recommended" &&
                      preferredIndustryMatches(o, data.preferences).length >
                        0 && (
                        <span className="industry-priority-badge">
                          {industryPriorityBoost(o, data.preferences) === 10
                            ? "Top industry interest"
                            : "Industry interest"}
                        </span>
                      )}
                    <span className="row-meta">
                      {(kind === "job" ||
                        !/^(unknown|location.*confirm)$/i.test(
                          o.location.trim(),
                        )) && (
                        <>
                          {o.location}
                          <span>·</span>
                        </>
                      )}
                      {kind === "job"
                        ? salary(o)
                        : [
                            startupSourceLabels(o).join(" · "),
                            o.publishedAt ? date(o.publishedAt) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                    {kind === "job" && stage === "recommended" && (
                      <span className="job-fit-explanation">
                        <span>{recommendations.get(o.id)?.reason}</span>
                        {recommendations.get(o.id)?.question && (
                          <span className="job-fit-question">
                            {recommendations.get(o.id)?.question}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="opportunity-trailing">
                    {(kind === "job"
                      ? stage !== "recommended"
                      : o.stage === "archived") && (
                      <Badge value={opportunityBadge(o)} />
                    )}
                    {applicationColumn(o) && (
                      <span className="on-board-label">
                        On application board
                      </span>
                    )}
                    {outreachColumn(o) && (
                      <span className="on-board-label">In outreach</span>
                    )}
                    {kind === "startup" ? (
                      <ArrowRight
                        size={16}
                        className="startup-row-arrow"
                        aria-hidden="true"
                      />
                    ) : recommendations.get(o.id)?.score == null ? (
                      <span className="fit-evaluation-label">
                        {recommendations.get(o.id)?.fitLabel}
                      </span>
                    ) : (
                      <span
                        className={`score ${o.assessment?.recommendation === "ready" ? "good" : ""}`}
                      >
                        {o.assessment
                          ? `${Math.round(recommendations.get(o.id)!.score!)}%`
                          : "—"}
                        <small>required match</small>
                      </span>
                    )}
                  </span>
                </button>
              </div>
            ))
          ) : kind === "startup" ? (
            <Empty
              icon={
                searching ? (
                  <LoaderCircle size={28} className="spin" />
                ) : (
                  <Rocket size={28} />
                )
              }
              title={
                hasStartupFilter
                  ? "No companies match these filters"
                  : stage === "archived"
                    ? "No archived companies"
                    : hasActive
                      ? "No companies left to explore"
                      : all.length > 0
                        ? "Your saved companies are archived"
                        : searching
                          ? "Searching startups"
                          : "Find companies worth exploring"
              }
              detail={
                hasStartupFilter
                  ? "Try a different company name or clear your filters to see more companies in this view."
                  : stage === "archived"
                    ? "Companies you archive will appear here. You can restore them anytime."
                    : hasActive
                      ? "Your saved companies are already in outreach. Search for more companies or revisit your saved companies."
                      : all.length > 0
                        ? "Search for new companies or revisit your archived companies."
                        : searching
                          ? "New companies will appear here as research completes. You can keep browsing while we search."
                          : "Discover startups, review what they build, and add the companies you want to contact to outreach."
              }
            >
              {(hasStartupFilter || all.length > 0 || stage === "archived") && (
                <button
                  className="button secondary"
                  onClick={() => {
                    if (hasStartupFilter) {
                      setQuery("");
                      setStartupSource("all");
                      setVisibleCount(50);
                      setChecked(new Set());
                    } else {
                      changeView(
                        !hasActive && all.length > 0 ? "archived" : "all",
                      );
                    }
                  }}
                >
                  {hasStartupFilter
                    ? "Clear filters"
                    : !hasActive && all.length > 0
                      ? "View archived companies"
                      : "View all saved"}
                  <ArrowRight size={15} />
                </button>
              )}
            </Empty>
          ) : (
            <Empty
              title={
                hasQuery
                  ? "No jobs match these filters"
                  : hasSourceFilter
                    ? "No jobs match this source"
                    : stage === "recommended"
                      ? "No strong recommendations yet"
                      : hasActive
                        ? "No opportunities in this view"
                        : "Start with your next opportunity"
              }
              detail={
                hasQuery
                  ? "Try another company, title or skill, or clear your filters to see the jobs in this view."
                  : hasSourceFilter
                    ? `${sourceFilterLabel} has no jobs in this view. Choose another source or change the view.`
                    : stage === "recommended" && hasActive
                      ? `Recommendations need relevant experience at your ${data.preferences.essentialMatch}% minimum match and no confirmed preference conflict. All saved is ranked by fit, and jobs you are already pursuing stay in Applications.`
                      : "Search for jobs using your preferences. RoleLoop finds openings and evaluates them against your resume."
              }
            >
              {(hasQuery || hasSourceFilter || hasActive) && (
                <button
                  className="button secondary"
                  onClick={() => {
                    if (hasQuery || hasSourceFilter) {
                      setQuery("");
                      setChecked(new Set());
                      setSourceFilter("all");
                      setVisibleCount(stage === "recommended" ? 10 : 50);
                    } else changeView("all");
                  }}
                >
                  {hasQuery || hasSourceFilter
                    ? "Clear filters"
                    : "View all saved jobs"}
                  <ArrowRight size={15} />
                </button>
              )}
            </Empty>
          )}
          {visibleList.length < list.length && (
            <div className="job-list-more">
              <button
                className="button secondary"
                onClick={() =>
                  setVisibleCount(
                    (count) => count + (stage === "recommended" ? 10 : 50),
                  )
                }
              >
                Show{" "}
                {Math.min(
                  stage === "recommended" ? 10 : 50,
                  list.length - visibleList.length,
                )}{" "}
                more
              </button>
            </div>
          )}
        </div>
        {chosen && (
          <Modal
            title={kind === "startup" ? "Company details" : "Job details"}
            close={() => setSelected(null)}
          >
            {inspector}
          </Modal>
        )}
      </div>
    </section>
  );
}

function salary(o: Opportunity) {
  if (o.salaryMin === null && o.salaryMax === null) return "Salary to confirm";
  const currency = o.salaryCurrency || "USD";
  const amount = (n: number | null) => {
    if (n === null) return "?";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
        notation: n >= 1000 ? "compact" : "standard",
      }).format(n);
    } catch {
      return `${currency} ${n.toLocaleString()}`;
    }
  };
  const range =
    o.salaryMin === null
      ? `Up to ${amount(o.salaryMax)}`
      : o.salaryMax === null
        ? `${amount(o.salaryMin)}+`
        : o.salaryMin === o.salaryMax
          ? amount(o.salaryMin)
          : `${amount(o.salaryMin)}–${amount(o.salaryMax)}`;
  return o.salaryPeriod === "unknown"
    ? `${range} · period unconfirmed`
    : `${range} / ${o.salaryPeriod}`;
}
function NoticeList({
  title,
  items,
  kind,
}: {
  title: string;
  items: string[];
  kind: "error" | "warning" | "neutral";
}) {
  return (
    <div className={`notice-list ${kind}`}>
      <strong>
        {kind !== "neutral" && <AlertTriangle size={14} />}
        {title}
      </strong>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function PreferencesEditor({
  initial,
  perform,
  busy,
}: {
  initial: Preferences;
  perform: Perform;
  busy: boolean;
}) {
  const [prefs, setPrefs] = useState(initial);
  const dirty = JSON.stringify(prefs) !== JSON.stringify(initial);
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setPrefs((p) => ({ ...p, [key]: value }));
  return (
    <section
      className="page form-page editor-page preferences-page"
      aria-labelledby="preferences-title"
    >
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void perform(
            () => write("/preferences", prefs, "PUT"),
            "Search preferences saved.",
          );
        }}
      >
        <EditorHeader
          titleId="preferences-title"
          title="Search preferences"
          description="Applies to job opportunities and startup prospects."
          dirty={dirty}
          busy={busy}
        />
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Roles & location</h2>
          </div>
          <div className="form-grid">
            <TargetRolesInput
              roles={prefs.roles}
              disabled={busy}
              onSave={async (roles) => {
                const saved = await perform(async () => {
                  const { preferences } = await api<Bootstrap>("/bootstrap");
                  await write("/preferences", { ...preferences, roles }, "PUT");
                }, "Target roles saved.");
                if (saved) set("roles", roles);
                return saved;
              }}
            />
            <Field
              label="Working country"
              hint="Where you work from. Used for remote eligibility and application drafts."
            >
              <input
                required
                value={prefs.country}
                onChange={(e) => set("country", e.target.value)}
              />
            </Field>
            <Field label="Target company country">
              <input
                value={prefs.companyCountry}
                onChange={(e) => set("companyCountry", e.target.value)}
              />
            </Field>
          </div>
        </section>
        <section className="form-section industry-section">
          <div className="form-section-heading">
            <h2>Industries & interests</h2>
            <p>Set industry preferences for jobs and startups.</p>
          </div>
          <IndustryInterests
            industries={prefs.industries}
            industryPreference={prefs.industryPreference}
            topIndustries={prefs.topIndustries}
            disabled={busy}
            onChange={(values) =>
              setPrefs((current) => ({ ...current, ...values }))
            }
          />
        </section>
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Compensation</h2>
            <p>
              Set the lowest base salary you would accept. Enter a monthly or
              annual amount to see its equivalent.
            </p>
          </div>
          <div className="form-grid compensation-grid">
            <SalaryFields
              minimumSalary={prefs.minimumSalary}
              targetSalary={prefs.targetSalary}
              onChange={set}
            />
            <SalaryPolicies preferences={prefs} onChange={set} />
          </div>
        </section>
        <FreshnessPreferences preferences={prefs} onChange={set} />
        <MatchingPreferences
          preferences={prefs}
          onChange={set}
          disabled={busy}
        />
        <AutomationPreferences preferences={prefs} onChange={set} busy={busy} />
      </form>
    </section>
  );
}

function Drafts({
  data,
  perform,
  busy,
}: {
  data: Bootstrap;
  perform: Perform;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(() => {
      const id = routeOpportunity(location.hash);
      return id
        ? data.drafts.find((draft) => draft.opportunityId === id)?.id || null
        : null;
    }),
    [filter, setFilter] = useState("all");
  useEffect(() => {
    const selectFromLink = () => {
      const id = routeOpportunity(location.hash);
      if (!id) return;
      setSelected(
        data.drafts.find((draft) => draft.opportunityId === id)?.id || null,
      );
      setFilter("all");
    };
    window.addEventListener("hashchange", selectFromLink);
    return () => window.removeEventListener("hashchange", selectFromLink);
  }, [data.drafts]);
  const draft = data.drafts.find((d) => d.id === selected),
    list = data.drafts.filter((d) => filter === "all" || d.status === filter);
  return (
    <section className="page" aria-labelledby="drafts-title">
      <header className="page-heading">
        <div>
          <h1 id="drafts-title">Drafts</h1>
          <p>
            Review and download your application documents and outreach
            messages.
          </p>
        </div>
      </header>
      <div className="segmented" aria-label="Draft status">
        {["all", "draft", "approved"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={filter === s ? "active" : ""}
          >
            {s === "all" ? "All drafts" : statusLabels[s]}
            <span>
              {data.drafts.filter((d) => s === "all" || d.status === s).length}
            </span>
          </button>
        ))}
      </div>
      <div className="draft-layout">
        <div className="draft-list">
          {list.map((d) => {
            const o = data.opportunities.find((o) => o.id === d.opportunityId);
            return (
              <button
                className={`draft-row ${selected === d.id ? "selected" : ""}`}
                key={d.id}
                onClick={() => setSelected(d.id)}
              >
                <span className="draft-icon">
                  {d.kind === "application" ? (
                    <FileText size={23} />
                  ) : (
                    <Inbox size={23} />
                  )}
                </span>
                <span>
                  <strong>{o?.company || "Opportunity"}</strong>
                  <small>
                    {d.kind === "application"
                      ? "Application package"
                      : "Outreach message"}{" "}
                    · {date(d.createdAt)}
                  </small>
                  <span className="draft-subject">{d.subject}</span>
                </span>
                <Badge value={d.status} />
              </button>
            );
          })}
          {!list.length && (
            <Empty
              title="Your drafts will appear here"
              detail="Prepare an application from a To apply card in Applications, or an outreach message from a To contact card in Startup outreach."
            />
          )}
        </div>
        {draft ? (
          <DraftDetail
            key={draft.id}
            draft={draft}
            opportunity={data.opportunities.find(
              (o) => o.id === draft.opportunityId,
            )}
            perform={perform}
            busy={busy}
          />
        ) : (
          data.drafts.length > 0 && (
            <div className="draft-placeholder">
              <FileText size={34} />
              <h3>Make every word count.</h3>
              <p>Select a draft to review, edit or download it.</p>
            </div>
          )
        )}
      </div>
    </section>
  );
}

function DraftDetail({
  draft,
  opportunity,
  perform,
  busy,
}: {
  draft: Draft;
  opportunity?: Opportunity;
  perform: Perform;
  busy: boolean;
}) {
  const [tab, setTab] = useState<"body" | "resume" | "coverLetter" | "answers">(
      "body",
    ),
    [editing, setEditing] = useState(false),
    [content, setContent] = useState({
      subject: draft.subject,
      body: draft.body,
      resume: draft.resume,
      coverLetter: draft.coverLetter,
      answers: draft.answers,
    });
  useEffect(() => {
    if (!editing)
      setContent({
        subject: draft.subject,
        body: draft.body,
        resume: draft.resume,
        coverLetter: draft.coverLetter,
        answers: draft.answers,
      });
  }, [draft.updatedAt, editing]);
  const download = (format: string) =>
    void perform(() =>
      downloadFile(
        `/drafts/${draft.id}/download?format=${format}`,
        `roleloop-${draft.id}.${format}`,
      ),
    );
  return (
    <article className="draft-detail">
      <div className="draft-detail-top">
        <div>
          <Badge value={draft.status} />
          <h2>{opportunity?.company || draft.subject}</h2>
          <p>
            {draft.kind === "application"
              ? "Application package"
              : "Startup outreach"}{" "}
            ·{" "}
            {draft.generator === "openai"
              ? "OpenAI-assisted"
              : draft.generator === "legacy"
                ? "Previous generator"
                : "Evidence templates"}
          </p>
        </div>
        <IconButton
          label={editing ? "Cancel editing draft" : "Edit draft"}
          onClick={() => setEditing(!editing)}
        >
          <Pencil size={17} />
        </IconButton>
      </div>
      {draft.warnings.length > 0 && (
        <NoticeList
          title="Review notes"
          items={draft.warnings}
          kind="warning"
        />
      )}
      <div className="document-tabs">
        {(
          [
            "body",
            ...(draft.kind === "application"
              ? ["resume", "coverLetter", "answers"]
              : []),
          ] as (typeof tab)[]
        ).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={tab === t ? "active" : ""}
          >
            {
              {
                body: draft.kind === "outreach" ? "Email" : "Summary",
                resume: "Résumé",
                coverLetter: "Cover letter",
                answers: "Answers",
              }[t]
            }
          </button>
        ))}
      </div>
      {editing ? (
        <div className="draft-editor">
          <Field label="Subject">
            <input
              value={content.subject}
              onChange={(e) =>
                setContent((p) => ({ ...p, subject: e.target.value }))
              }
            />
          </Field>
          {tab === "answers" ? (
            content.answers.map((answer, index) => (
              <Field key={index} label={answer.question}>
                <textarea
                  rows={4}
                  value={answer.answer}
                  onChange={(e) =>
                    setContent((p) => ({
                      ...p,
                      answers: p.answers.map((a, i) =>
                        i === index ? { ...a, answer: e.target.value } : a,
                      ),
                    }))
                  }
                />
              </Field>
            ))
          ) : (
            <Field
              label={
                tab === "body"
                  ? "Draft text"
                  : tab === "resume"
                    ? "Résumé text"
                    : "Cover letter"
              }
            >
              <textarea
                className="document-textarea"
                rows={18}
                value={content[tab]}
                onChange={(e) =>
                  setContent((p) => ({ ...p, [tab]: e.target.value }))
                }
              />
            </Field>
          )}
          <p className="form-footnote">
            Keep claims grounded in your verified profile.
          </p>
          <div className="button-row">
            <button className="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                if (
                  await perform(
                    () => write(`/drafts/${draft.id}`, content, "PATCH"),
                    "Draft saved.",
                  )
                )
                  setEditing(false);
              }}
            >
              <Save size={15} />
              Save draft
            </button>
          </div>
        </div>
      ) : (
        <div className="document-preview">
          {tab === "body" && (
            <div className="email-heading">
              <small>
                {draft.kind === "outreach" ? "SUBJECT" : "APPLICATION"}
              </small>
              <h3>{draft.subject}</h3>
              {opportunity?.contactEmail && (
                <span>To: {opportunity.contactEmail}</span>
              )}
            </div>
          )}
          {tab === "answers" ? (
            draft.answers.length ? (
              draft.answers.map((a, i) => (
                <div className="answer" key={i}>
                  <h3>{a.question}</h3>
                  <p>{a.answer}</p>
                </div>
              ))
            ) : (
              <p className="muted">
                No question-specific answers in this package.
              </p>
            )
          ) : (
            <p className="document-body">
              {draft[tab] || "No content for this section."}
            </p>
          )}
        </div>
      )}
      <div className="draft-actions">
        <div className="button-row">
          {draft.kind === "application" && (
            <button
              className="button"
              disabled={busy}
              onClick={() => download("pdf")}
            >
              <Download size={15} />
              PDF
            </button>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() => download("txt")}
          >
            <Download size={15} />
            Text
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => download("json")}
          >
            JSON
          </button>
        </div>
      </div>
      <div className="evidence-count">
        <ShieldCheck size={14} />
        {draft.evidenceIds.length} verified evidence{" "}
        {draft.evidenceIds.length === 1 ? "reference" : "references"} · no
        external sending
      </div>
    </article>
  );
}
