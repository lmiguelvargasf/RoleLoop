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
  Check,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  FileUser,
  Inbox,
  Link2,
  LoaderCircle,
  LogOut,
  Users,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
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
  Activity,
  Company,
  AccountContext,
  WorkspaceAccess,
  Bootstrap,
  Draft,
  Opportunity,
  Preferences,
  Profile,
  RunAction,
} from "../shared/types";
import { api, date, downloadFile, safeUrl, uid, words, write } from "./api";
import {
  applicationCounts,
  followUpDue,
  matchesTargetRole,
} from "../shared/discovery";
import { SourcesPage as Sources } from "./SourcesPage";
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
import { WorkspaceStatus, serverUnavailable } from "./WorkspaceStatus";
import {
  industryPriorityBoost,
  preferredIndustryMatches,
} from "../shared/industries";

type Page =
  | "jobs"
  | "startups"
  | "drafts"
  | "profile"
  | "settings"
  | "sources"
  | "activity"
  | "account";
type Perform = (
  task: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;
const nav = [
  { id: "jobs", label: "Job opportunities", icon: Briefcase },
  { id: "startups", label: "Startup prospects", icon: Rocket },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "profile", label: "Resume", icon: FileUser },
  { id: "settings", label: "Search preferences", icon: SlidersHorizontal },
  { id: "sources", label: "Discovery", icon: Radio },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "account", label: "Account & access", icon: Users },
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
      <div className="button-row">{children}</div>
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
  workspace,
  onWorkspaceChange,
  onSignOut,
  accountPage,
  accountNotice,
}: {
  account: AccountContext;
  workspace: WorkspaceAccess;
  onWorkspaceChange: (id: string) => void;
  onSignOut: () => void;
  accountPage: ReactNode;
  accountNotice: string;
}) {
  const [data, setData] = useState<Bootstrap | null>(null),
    [failure, setFailure] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState<Page>(() =>
      nav.some((n) => n.id === location.hash.slice(1))
        ? (location.hash.slice(1) as Page)
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
      const next = location.hash.slice(1);
      if (nav.some((n) => n.id === next)) setPage(next as Page);
    };
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
        <div className="workspace-picker">
          <div className="workspace-picker-heading">
            <label htmlFor="workspace-picker">WORKSPACE</label>
            <IconButton
              label="Refresh workspace"
              onClick={() => void refresh()}
              disabled={busy}
            >
              <RefreshCw
                size={14}
                className={busy ? "spin" : ""}
                aria-hidden="true"
              />
            </IconButton>
          </div>
          <select
            id="workspace-picker"
            aria-label="Active workspace"
            value={workspace.id}
            onChange={(e) => onWorkspaceChange(e.target.value)}
          >
            {account.workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.role === "manager" ? " · manager" : ""}
              </option>
            ))}
          </select>
          <span>
            {workspace.role === "owner"
              ? "Your private workspace"
              : "Shared with you as a manager"}
          </span>
        </div>
        <nav aria-label="Main navigation">
          {nav.map(({ id, label, icon: Icon }, i) => (
            <button
              className={`nav-item ${page === id ? "active" : ""} ${i === 3 ? "nav-break" : ""}`}
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

        {running.length > 0 && (
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
        {(page === "jobs" || page === "startups") && (
          <Opportunities
            key={page}
            kind={page === "jobs" ? "job" : "startup"}
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
        {page === "sources" && (
          <Sources
            initial={data.sources}
            sourcesRevision={data.sourcesRevision}
            preferences={data.preferences}
            employerDiscovery={data.employerDiscovery}
            health={data.sourceHealth}
            latestSearch={
              data.runs
                .filter(
                  (run) =>
                    run.action === "discover" &&
                    (run.discoveryScope ?? "jobs") === "jobs" &&
                    !run.sourceId &&
                    ["completed", "failed"].includes(run.status),
                )
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
            }
            searching={data.runs.some(
              (r) =>
                r.action === "discover" &&
                ["queued", "running"].includes(r.status),
            )}
            perform={perform}
            busy={busy}
          />
        )}
        {page === "activity" && (
          <ActivityPage events={data.events} data={data} />
        )}
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
  data,
  perform,
  busy,
  navigate,
}: {
  kind: Opportunity["kind"];
  data: Bootstrap;
  perform: Perform;
  busy: boolean;
  navigate: (p: Page) => void;
}) {
  const [query, setQuery] = useState(""),
    [stage, setStage] = useState(kind === "job" ? "matches" : "all"),
    [selected, setSelected] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<Opportunity | null>(null),
    [discovering, setDiscovering] = useState(false);
  const potentialMatch = (opportunity: Opportunity) =>
    opportunity.stage !== "archived" &&
    opportunity.assessment?.recommendation !== "excluded" &&
    matchesTargetRole(
      opportunity.title,
      data.preferences.roles,
      opportunity.company,
    );
  const all = data.opportunities.filter((o) => o.kind === kind),
    outsideMatches = all.filter(
      (opportunity) =>
        opportunity.stage !== "archived" && !potentialMatch(opportunity),
    ).length,
    list = all.filter(
      (o) =>
        (stage === "matches"
          ? potentialMatch(o)
          : stage === "excluded"
            ? o.stage !== "archived" &&
              o.assessment?.recommendation === "excluded"
            : stage === "all"
              ? o.stage !== "archived"
              : stage === "followups"
                ? followUpDue(o, new Date().toLocaleDateString("en-CA"))
                : stage.startsWith("application:")
                  ? o.application?.status === stage.slice(12)
                  : o.stage === stage) &&
        `${o.company} ${o.title} ${o.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  const chosen = list.find((o) => o.id === selected);
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
  const canSearchJobs =
    data.sources.some(
      (source) => source.enabled && source.provider !== "hackernews",
    ) ||
    ((data.preferences.discoverEmployers ?? true) &&
      data.preferences.roles.some((role) => role.trim()) &&
      Boolean(data.preferences.country.trim()));
  return (
    <section
      className="page opportunities-page"
      aria-labelledby="opportunities-title"
    >
      <header className="page-heading">
        <div>
          <h1 id="opportunities-title">
            {kind === "job" ? "Job opportunities" : "Startup prospects"}
          </h1>
          <p>
            {kind === "job"
              ? "Find eligible roles. Build applications around your actual experience."
              : "Find companies worth a conversation, even before a role opens."}
          </p>
        </div>
        <div className="button-row">
          <button className="button" onClick={() => setAdding(true)}>
            <Plus size={16} />
            Add {kind === "job" ? "role" : "startup"}
          </button>
          <button
            className="button primary"
            disabled={busy || searching || (kind === "job" && !canSearchJobs)}
            onClick={() => {
              if (kind === "startup") setDiscovering(true);
              else
                void perform(
                  () =>
                    write("/runs", {
                      action: "discover",
                      discoveryScope: "jobs",
                    }),
                  "Job search queued. Follow progress in Activity.",
                );
            }}
          >
            <Search size={16} />
            {searching
              ? "Searching…"
              : kind === "job"
                ? "Search jobs"
                : "Find startup leads"}
          </button>
        </div>
      </header>
      {kind === "job" && !canSearchJobs && (
        <p className="discovery-setup-note">
          Set your target roles and working country, or follow a company to
          start searching.{" "}
          <button className="text-button" onClick={() => navigate("sources")}>
            Set up discovery
          </button>
        </p>
      )}
      {kind === "job" && (
        <p className="muted" role="status">
          {all.length} saved · {applicationCounts(all).applied} applied ·{" "}
          {applicationCounts(all).interview} reached interview ·{" "}
          {applicationCounts(all).offer} offers ·{" "}
          {
            all.filter(
              (o) =>
                o.application?.followUpOn &&
                o.application.followUpOn <=
                  new Date().toLocaleDateString("en-CA") &&
                !["rejected", "withdrawn", "offer"].includes(
                  o.application.status,
                ),
            ).length
          }{" "}
          follow-ups due
        </p>
      )}
      {kind === "job" && all.length > 0 && (
        <details>
          <summary>Results by source</summary>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Saved</th>
                <th>Applied</th>
                <th>Interviews</th>
                <th>Offers</th>
              </tr>
            </thead>
            <tbody>
              {[...new Set(all.map((o) => o.sourceId || o.source))].map(
                (id) => {
                  const items = all.filter(
                    (o) => (o.sourceId || o.source) === id,
                  );
                  const counts = applicationCounts(items);
                  return (
                    <tr key={id}>
                      <td>
                        {data.sources.find((s) => s.id === id)?.label ??
                          items[0].source}
                      </td>
                      <td>{items.length}</td>
                      <td>{counts.applied}</td>
                      <td>{counts.interview}</td>
                      <td>{counts.offer}</td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
          <p className="muted">
            Counts cover the opportunities currently loaded (up to 300).
            Interview and offer milestones remain counted after a rejection.
          </p>
        </details>
      )}
      <div className="flow-line">
        <span className="flow-current">
          <span>01</span>Discover
        </span>
        <i />
        <span>
          <span>02</span>
          {kind === "job" ? "Evaluate fit" : "Research"}
        </span>
        <i />
        <span>
          <span>03</span>
          {kind === "job" ? "Prepare application" : "Draft outreach"}
        </span>
        <i />
        <span>
          <span>04</span>
          {kind === "job" ? "Apply & follow up" : "Review"}
        </span>
      </div>
      <div className="list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search opportunities"
            placeholder="Search company, role or skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by stage"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
        >
          {kind === "job" && <option value="matches">Potential matches</option>}
          <option value="all">All active opportunities</option>
          {kind === "job" && (
            <option value="excluded">Excluded by preferences</option>
          )}
          {kind === "job" && <option value="followups">Follow-ups due</option>}
          {kind === "job" &&
            ["applied", "interview", "offer", "rejected", "withdrawn"].map(
              (status) => (
                <option key={status} value={`application:${status}`}>
                  {status[0].toUpperCase() + status.slice(1)}
                </option>
              ),
            )}
          {["new", "review", "ready", "drafted", "approved", "archived"].map(
            (s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ),
          )}
        </select>
        <span className="result-count">
          {list.length} {list.length === 1 ? "opportunity" : "opportunities"}
        </span>
      </div>
      {kind === "job" &&
        stage === "matches" &&
        outsideMatches > 0 &&
        list.length > 0 && (
          <p className="opportunity-filter-note">
            {outsideMatches} other saved{" "}
            {outsideMatches === 1 ? "role is" : "roles are"} outside this view.{" "}
            <button className="text-button" onClick={() => setStage("all")}>
              View all active opportunities
            </button>
          </p>
        )}
      <div className={`opportunity-workspace ${chosen ? "has-selection" : ""}`}>
        <div className="opportunity-list">
          {list.length ? (
            list.map((o) => (
              <button
                className={`opportunity-row ${chosen?.id === o.id ? "selected" : ""}`}
                key={o.id}
                onClick={() => setSelected(o.id)}
              >
                <span className={`company-monogram ${kind}`}>
                  {o.company.slice(0, 2).toUpperCase()}
                </span>
                <span className="opportunity-info">
                  <span className="company-name">
                    {o.company}
                    {o.isDemo && <span className="demo-tag">SAMPLE</span>}
                  </span>
                  <strong>{o.title}</strong>
                  {preferredIndustryMatches(o, data.preferences).length > 0 && (
                    <span className="industry-priority-badge">
                      {industryPriorityBoost(o, data.preferences) === 10
                        ? "Top industry interest"
                        : "Industry interest"}
                    </span>
                  )}
                  <span className="row-meta">
                    {o.location}
                    <span>·</span>
                    {kind === "job" ? salary(o) : o.source}
                  </span>
                </span>
                <span className="opportunity-trailing">
                  <Badge value={opportunityBadge(o)} />
                  {o.application && o.application.status !== "saved" && (
                    <span>{o.application.status}</span>
                  )}
                  <span
                    className={`score ${o.assessment?.recommendation === "ready" ? "good" : ""}`}
                  >
                    {kind === "job" && !o.requirements.some((r) => r.essential)
                      ? "—"
                      : o.assessment
                        ? `${Math.round(
                            kind === "job"
                              ? o.assessment.essentialScore
                              : o.assessment.score,
                          )}%`
                        : "—"}
                    <small>
                      {kind === "job" ? "required match" : "relevance"}
                    </small>
                  </span>
                </span>
              </button>
            ))
          ) : (
            <Empty
              title={
                query
                  ? "No matches in this view"
                  : kind === "job" && stage === "matches"
                    ? "No potential matches yet"
                    : all.length > 0
                      ? "No opportunities in this view"
                      : kind === "job"
                        ? "Start with your next opportunity"
                        : "Build your startup shortlist"
              }
              detail={
                query
                  ? "Try another search or change the stage filter."
                  : kind === "job" && stage === "matches" && outsideMatches > 0
                    ? "Saved roles outside your target roles or preferences remain available in All active opportunities."
                    : "Search for opportunities using your preferences, or add one manually."
              }
            >
              <button
                className="button primary"
                onClick={() => {
                  if (
                    kind === "job" &&
                    stage === "matches" &&
                    outsideMatches > 0
                  ) {
                    setQuery("");
                    setStage("all");
                  } else navigate("sources");
                }}
              >
                {kind === "job" && stage === "matches" && outsideMatches > 0
                  ? "View all active opportunities"
                  : "Set up discovery"}
                <ArrowRight size={15} />
              </button>
            </Empty>
          )}
        </div>
        {chosen ? (
          <aside className="inspector">
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
                  label="Edit opportunity details"
                  onClick={() => setEditing(chosen)}
                >
                  <Pencil size={16} />
                </IconButton>
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
                            stage:
                              chosen.stage === "archived" ? "new" : "archived",
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
                <IconButton
                  label="Close opportunity details"
                  onClick={() => setSelected(null)}
                >
                  <X size={18} />
                </IconButton>
              </div>
            </div>
            <div className="inspector-title">
              <div className={`company-monogram large ${kind}`}>
                {chosen.company.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <span className="company-name">{chosen.company}</span>
                <h2>{chosen.title}</h2>
              </div>
            </div>
            <div className="detail-grid">
              <div>
                <small>Location</small>
                <span>{chosen.location}</span>
              </div>
              <div>
                <small>
                  {kind === "job" ? "Compensation" : "Company country"}
                </small>
                <span>
                  {kind === "job" ? salary(chosen) : chosen.companyCountry}
                </span>
              </div>
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
              <div>
                <small>Published / signal date</small>
                <span>{date(chosen.publishedAt)}</span>
              </div>
            </div>
            <div className="inspector-links">
              <External url={chosen.url}>
                View source{chosen.source === "jobicy" ? " · Jobicy" : ""}
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
                {kind === "job" ? "Evaluate fit" : "Research & evaluate"}
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void run("draft", chosen.id)}
              >
                <FileText size={15} />
                Prepare draft
              </button>
            </div>
            {chosen.assessment && (
              <>
                {chosen.assessment.recommendation === "excluded" && (
                  <NoticeList
                    title="Outside your criteria"
                    items={
                      chosen.assessment.blockers.length > 0
                        ? chosen.assessment.blockers
                        : [
                            "This opportunity does not meet your saved search criteria.",
                          ]
                    }
                    kind="error"
                  />
                )}
                <div className="section-title">
                  <h3>
                    {kind === "job" ? "Required match" : "Startup assessment"}
                  </h3>
                  <span className="match-number">
                    {Math.round(
                      kind === "job"
                        ? chosen.assessment.essentialScore
                        : chosen.assessment.score,
                    )}
                    <small>%</small>
                  </span>
                </div>
                <div className="match-track">
                  <i
                    style={{
                      width: `${Math.min(
                        100,
                        kind === "job"
                          ? chosen.assessment.essentialScore
                          : chosen.assessment.score,
                      )}%`,
                    }}
                  />
                </div>
                <div className="match-note">
                  {kind === "job"
                    ? "Required qualifications supported by verified experience. Preferred skills help rank your matches."
                    : "Relevance to your experience; not a prediction of company success."}
                </div>
                {chosen.assessment.recommendation !== "excluded" &&
                  chosen.assessment.blockers.length > 0 && (
                    <NoticeList
                      title="Outside your criteria"
                      items={chosen.assessment.blockers}
                      kind="error"
                    />
                  )}
                {chosen.assessment.unknowns.length > 0 && (
                  <NoticeList
                    title="Needs clarification"
                    items={chosen.assessment.unknowns}
                    kind="warning"
                  />
                )}
                {chosen.assessment.reasons.length > 0 && (
                  <NoticeList
                    title="Evaluation notes"
                    items={chosen.assessment.reasons}
                    kind="neutral"
                  />
                )}
                {chosen.assessment.fitSummary && (
                  <div className="form-section">
                    <h3>Your fit</h3>
                    <p>{chosen.assessment.fitSummary}</p>
                  </div>
                )}
                {!!chosen.assessment.learningGaps?.length && (
                  <NoticeList
                    title="Learning gaps to consider"
                    items={chosen.assessment.learningGaps}
                    kind="neutral"
                  />
                )}
                {chosen.assessment.matches.length > 0 && (
                  <div className="requirements">
                    <h3>Requirements & evidence</h3>
                    {chosen.assessment.matches.map((m) => (
                      <div className="requirement" key={m.requirementId}>
                        <span className={`requirement-icon ${m.status}`}>
                          {m.status === "matched" ? (
                            <Check size={13} />
                          ) : m.status === "partial" ? (
                            "≈"
                          ) : (
                            "—"
                          )}
                        </span>
                        <div>
                          <strong>{m.requirement}</strong>
                          <small>
                            {m.essential ? "Essential" : "Preferred"} ·{" "}
                            {m.explanation}
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {kind === "startup" && (
              <div className="contact-detail">
                <h3>Founder contact</h3>
                <p>{chosen.contactName || "Contact not yet verified"}</p>
                {chosen.contactEmail && (
                  <span className="mono">{chosen.contactEmail}</span>
                )}
                {chosen.contactSource && (
                  <External url={chosen.contactSource}>
                    Contact evidence
                  </External>
                )}
                <small>
                  Only verified professional contact details belong here.
                </small>
              </div>
            )}
            <details className="description" open={!chosen.assessment}>
              <summary>
                {kind === "job" ? "Original description" : "Company research"}
              </summary>
              <p>
                {chosen.description ||
                  "No description yet. Edit this opportunity to add source information."}
              </p>
            </details>
            {chosen.signals.length > 0 && (
              <NoticeList
                title="Observed signals"
                items={chosen.signals}
                kind="neutral"
              />
            )}
            {chosen.notes && (
              <div className="notes">
                <h3>Your notes</h3>
                <p>{chosen.notes}</p>
              </div>
            )}
            {kind === "job" && (
              <ApplicationProgress
                key={`${chosen.id}:${JSON.stringify(chosen.application)}`}
                opportunity={chosen}
                busy={busy}
                perform={perform}
              />
            )}
            {relatedDrafts.length > 0 && (
              <button className="draft-link" onClick={() => navigate("drafts")}>
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
        ) : (
          list.length > 0 && (
            <aside className="inspector placeholder-inspector">
              <div className="orbit-illustration">
                <span />
                <span />
                <span />
                <Search size={28} />
              </div>
              <h3>A closer look at your next move.</h3>
              <p>
                Select an opportunity to inspect its source, evaluate the
                evidence and prepare a draft.
              </p>
              <span className="keyboard-hint">
                Your profile → their requirements → a better application
              </span>
            </aside>
          )
        )}
      </div>
      {(adding || editing) && (
        <OpportunityForm
          companies={data.companies ?? []}
          kind={kind}
          existing={editing || undefined}
          close={() => {
            setAdding(false);
            setEditing(null);
          }}
          perform={perform}
          busy={busy}
        />
      )}
      {discovering && (
        <Modal
          title={
            kind === "job"
              ? "Discover job opportunities"
              : "Discover startup prospects"
          }
          close={() => setDiscovering(false)}
        >
          <div className="modal-body">
            <p className="muted">
              Choose a source. New records will appear in your workspace with
              their source and any unconfirmed facts.
            </p>
            {data.sources
              .filter(
                (s) =>
                  s.enabled &&
                  (kind === "startup"
                    ? s.provider === "hackernews"
                    : s.provider !== "hackernews"),
              )
              .map((source) => (
                <button
                  className="source-choice"
                  disabled={busy}
                  key={source.id}
                  onClick={async () => {
                    if (
                      await perform(
                        () =>
                          write("/runs", {
                            action: "discover",
                            sourceId: source.id,
                            discoveryScope: "startups",
                          }),
                        "Discovery queued.",
                      )
                    )
                      setDiscovering(false);
                  }}
                >
                  <Radio size={18} />
                  <span>
                    <strong>{source.label}</strong>
                    <small>
                      {source.provider} · {source.board || "Show HN launches"}
                    </small>
                  </span>
                  <ArrowRight size={17} />
                </button>
              ))}
            {!data.sources.some(
              (s) =>
                s.enabled &&
                (kind === "startup"
                  ? s.provider === "hackernews"
                  : s.provider !== "hackernews"),
            ) && (
              <Empty
                title="Add a discovery source"
                detail={
                  kind === "job"
                    ? "Connect an Ashby, Greenhouse or Lever company board to discover its roles."
                    : "Enable a startup discovery feed in Sources."
                }
              >
                <button
                  className="button primary"
                  onClick={() => navigate("sources")}
                >
                  Manage sources
                </button>
              </Empty>
            )}
          </div>
        </Modal>
      )}
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

function OpportunityForm({
  companies,
  kind,
  existing,
  close,
  perform,
  busy,
}: {
  companies: Company[];
  kind: Opportunity["kind"];
  existing?: Opportunity;
  close: () => void;
  perform: Perform;
  busy: boolean;
}) {
  const [form, setForm] = useState({
    company: existing?.company || "",
    companyId: existing?.companyId || "",
    title: existing?.title || "",
    description: existing?.description || "",
    descriptionTruncated: existing?.descriptionTruncated ?? false,
    url: existing?.url || "",
    companyUrl: existing?.companyUrl || "",
    location: existing?.location || "Unknown",
    companyCountry: existing?.companyCountry || "Unknown",
    companyCountrySource: existing?.companyCountrySource || "",
    remoteScope: existing?.remoteScope || "unknown",
    salaryMin: existing?.salaryMin?.toString() || "",
    salaryMax: existing?.salaryMax?.toString() || "",
    salaryCurrency: existing?.salaryCurrency || "USD",
    salaryPeriod: existing?.salaryPeriod || "year",
    publishedAt: existing?.publishedAt?.slice(0, 10) || "",
    contactName: existing?.contactName || "",
    contactEmail: existing?.contactEmail || "",
    contactSource: existing?.contactSource || "",
    notes: existing?.notes || "",
    requirements:
      existing?.requirements
        .map(
          (r) =>
            `${r.hard ? "[hard] " : r.essential ? "[essential] " : "[preferred] "}${r.text} | ${r.skills.join(", ")}`,
        )
        .join("\n") || "",
    signals: existing?.signals.join("\n") || "",
  });
  const [captureError, setCaptureError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const capture = async () => {
    setCaptureError("");
    setCapturing(true);
    try {
      const result = await write<{
        description: string;
        descriptionTruncated: boolean;
        remoteScope: Opportunity["remoteScope"];
      }>("/opportunities/capture", { url: form.url });
      setForm((p) => ({
        ...p,
        description: result.description,
        descriptionTruncated: result.descriptionTruncated,
        remoteScope: result.remoteScope,
      }));
    } catch (error) {
      setCaptureError(
        error instanceof Error
          ? error.message
          : "Could not read this page. Paste the job description below.",
      );
    } finally {
      setCapturing(false);
    }
  };
  const update = (key: keyof typeof form, value: string) =>
    setForm((p) => ({ ...p, [key]: value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const requirements = form.requirements
      .split("\n")
      .filter((s) => s.trim())
      .map((row, i) => {
        const [text, skills = ""] = row.split("|");
        return {
          id: existing?.requirements[i]?.id || uid(),
          text: text.replace(/^\[(essential|preferred|hard)\]\s*/i, "").trim(),
          skills: words(skills),
          essential: !/^\[preferred\]/i.test(text),
          hard: /^\[hard\]/i.test(text),
        };
      });
    const payload = {
      ...form,
      companyCountrySource: form.companyCountrySource || undefined,
      companyId: form.companyId || undefined,
      kind,
      salaryMin: form.salaryMin ? Number(form.salaryMin) : null,
      salaryMax: form.salaryMax ? Number(form.salaryMax) : null,
      publishedAt: form.publishedAt
        ? new Date(`${form.publishedAt}T12:00:00Z`).toISOString()
        : null,
      requirements,
      signals: form.signals.split("\n").filter(Boolean),
    };
    if (
      await perform(
        () =>
          write(
            existing ? `/opportunities/${existing.id}` : "/opportunities",
            payload,
            existing ? "PATCH" : "POST",
          ),
        existing
          ? "Opportunity updated. Re-evaluate after changing facts."
          : "Opportunity added.",
      )
    )
      close();
  };
  return (
    <Modal
      title={`${existing ? "Edit" : "Add"} ${kind === "job" ? "job opportunity" : "startup prospect"}`}
      close={close}
    >
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <Field label="Company">
            <input
              required
              list="known-companies"
              value={form.company}
              onChange={(e) => {
                const matches = companies.filter(
                  (c) => c.name.toLowerCase() === e.target.value.toLowerCase(),
                );
                const company = matches.length === 1 ? matches[0] : undefined;
                setForm((p) => ({
                  ...p,
                  company: e.target.value,
                  companyId: company?.id ?? "",
                  companyCountry: company?.country ?? "Unknown",
                  companyCountrySource: company?.countrySource ?? "",
                }));
              }}
            />
            <datalist id="known-companies">
              {companies.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </Field>
          <Field
            label={kind === "job" ? "Role title" : "Product or opportunity"}
          >
            <input
              required
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </Field>
          <Field label="Source URL">
            <input
              type="url"
              value={form.url}
              onChange={(e) => update("url", e.target.value)}
              placeholder="https://…"
            />
          </Field>
          {kind === "job" && (
            <div className="wide">
              <button
                type="button"
                className="button"
                disabled={busy || capturing || !form.url}
                onClick={() => void capture()}
              >
                {capturing ? "Reading…" : "Read job page"}
              </button>
              <p className="muted">
                Or paste the description below. Requirements are extracted when
                you save; review the result before applying.
              </p>
              {captureError && <p role="alert">{captureError}</p>}
            </div>
          )}
          <Field label="Description / source text" wide>
            <textarea
              required
              rows={6}
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
            />
          </Field>
          <details className="wide" open={!!existing}>
            <summary>Location, compensation and other details</summary>
            <div className="form-grid">
              <Field
                label="Company country evidence URL"
                hint="Official company page supporting its country."
              >
                <input
                  type="url"
                  value={form.companyCountrySource}
                  onChange={(e) =>
                    update("companyCountrySource", e.target.value)
                  }
                />
              </Field>
              <Field label="Company website">
                <input
                  type="url"
                  value={form.companyUrl}
                  onChange={(e) => update("companyUrl", e.target.value)}
                  placeholder="https://…"
                />
              </Field>
              <Field label="Location">
                <input
                  value={form.location}
                  onChange={(e) => update("location", e.target.value)}
                />
              </Field>
              <Field label="Company country">
                <input
                  value={form.companyCountry}
                  onChange={(e) => update("companyCountry", e.target.value)}
                />
              </Field>
              <Field label="Remote arrangement">
                <select
                  value={form.remoteScope}
                  onChange={(e) => update("remoteScope", e.target.value)}
                >
                  <option value="unknown">To confirm</option>
                  <option value="worldwide">Worldwide</option>
                  <option value="latam">Latin America</option>
                  <option value="us">US only</option>
                  <option value="onsite">On-site</option>
                </select>
              </Field>
              <Field label="Published / signal date">
                <input
                  type="date"
                  value={form.publishedAt}
                  onChange={(e) => update("publishedAt", e.target.value)}
                />
              </Field>
              {kind === "job" && (
                <>
                  <Field label="Salary minimum">
                    <input
                      type="number"
                      min="0"
                      value={form.salaryMin}
                      onChange={(e) => update("salaryMin", e.target.value)}
                    />
                  </Field>
                  <Field label="Salary maximum">
                    <input
                      type="number"
                      min="0"
                      value={form.salaryMax}
                      onChange={(e) => update("salaryMax", e.target.value)}
                    />
                  </Field>
                  <Field label="Currency">
                    <input
                      maxLength={3}
                      value={form.salaryCurrency}
                      onChange={(e) =>
                        update("salaryCurrency", e.target.value.toUpperCase())
                      }
                    />
                  </Field>
                  <Field label="Salary period">
                    <select
                      value={form.salaryPeriod}
                      onChange={(e) => update("salaryPeriod", e.target.value)}
                    >
                      {["year", "month", "hour", "unknown"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Requirements"
                    hint="Optional override. Leave blank to extract from the description. One per line: [essential] Build APIs | TypeScript, PostgreSQL."
                    wide
                  >
                    <textarea
                      rows={4}
                      value={form.requirements}
                      onChange={(e) => update("requirements", e.target.value)}
                    />
                  </Field>
                </>
              )}
              {kind === "startup" && (
                <>
                  <Field label="Founder / contact name">
                    <input
                      value={form.contactName}
                      onChange={(e) => update("contactName", e.target.value)}
                    />
                  </Field>
                  <Field label="Verified professional email">
                    <input
                      type="email"
                      value={form.contactEmail}
                      onChange={(e) => update("contactEmail", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Contact source URL"
                    hint="Where this professional contact information is published."
                    wide
                  >
                    <input
                      type="url"
                      value={form.contactSource}
                      onChange={(e) => update("contactSource", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Observed company signals"
                    hint="One sourced fact per line. Keep assumptions separate."
                    wide
                  >
                    <textarea
                      rows={3}
                      value={form.signals}
                      onChange={(e) => update("signals", e.target.value)}
                    />
                  </Field>
                </>
              )}
              <Field label="Your notes" wide>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => update("notes", e.target.value)}
                />
              </Field>
            </div>
          </details>
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            <Save size={16} />
            {existing ? "Save changes" : "Add opportunity"}
          </button>
        </div>
      </form>
    </Modal>
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
  const [selected, setSelected] = useState<string | null>(null),
    [filter, setFilter] = useState("all");
  const draft = data.drafts.find((d) => d.id === selected),
    list = data.drafts.filter((d) => filter === "all" || d.status === filter);
  return (
    <section className="page" aria-labelledby="drafts-title">
      <header className="page-heading">
        <div>
          <h1 id="drafts-title">Drafts</h1>
          <p>
            Review and download your application documents and founder emails.
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
                      : "Founder email"}{" "}
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
              detail="Choose an opportunity, evaluate the evidence, then prepare an application or founder email."
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
              : "Founder outreach"}{" "}
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

function ActivityPage({
  events,
  data,
}: {
  events: Activity[];
  data: Bootstrap;
}) {
  return (
    <section className="page activity-page" aria-labelledby="activity-title">
      <header className="page-heading">
        <div>
          <h1 id="activity-title">Activity</h1>
          <p>Discovery runs and decisions, in one place.</p>
        </div>
      </header>
      {data.runs.length > 0 && (
        <section className="run-history">
          <h2>Recent runs</h2>
          {data.runs.slice(0, 12).map((run) => (
            <div className="run-history-row" key={run.id}>
              <span className={`run-state ${run.status}`}>
                {run.status === "running" || run.status === "queued" ? (
                  <LoaderCircle size={17} className="spin" />
                ) : run.status === "failed" ? (
                  <AlertTriangle size={17} />
                ) : (
                  <CheckCircle2 size={17} />
                )}
              </span>
              <div>
                <strong>
                  {run.action[0].toUpperCase() + run.action.slice(1)}
                </strong>
                <p>{run.message}</p>
              </div>
              <span>{run.status}</span>
              <time>{date(run.createdAt)}</time>
            </div>
          ))}
        </section>
      )}
      <section className="activity-history">
        <h2>Workspace history</h2>
        {events.length ? (
          events.map((event) => (
            <div className="activity-row" key={event.id}>
              <span className={`activity-dot ${event.kind}`} />
              <div>
                <p>{event.message}</p>
                <time>{new Date(event.createdAt).toLocaleString()}</time>
              </div>
            </div>
          ))
        ) : (
          <Empty
            icon={<Clock3 size={30} />}
            title="Your history starts here"
            detail="Actions you take in the workspace will appear here."
          />
        )}
      </section>
    </section>
  );
}
