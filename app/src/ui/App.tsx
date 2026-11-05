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
  ChevronRight,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
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
  AccountContext,
  WorkspaceAccess,
  Bootstrap,
  Draft,
  Opportunity,
  Preferences,
  Profile,
  RunAction,
  Source,
} from "../shared/types";
import { api, date, downloadFile, safeUrl, uid, words, write } from "./api";
import { SalaryFields } from "./SalaryFields";

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
  { id: "profile", label: "My profile", icon: UserRound },
  { id: "settings", label: "Search preferences", icon: SlidersHorizontal },
  { id: "sources", label: "Discovery sources", icon: Radio },
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
    [failure, setFailure] = useState(""),
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
      setFailure("");
    } catch (e) {
      if (
        !mounted.current ||
        (e instanceof DOMException && e.name === "AbortError")
      )
        return;
      setFailure(
        e instanceof Error
          ? e.message
          : "Unable to connect to the local service.",
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
    return (
      <main className="connection-screen">
        <div className="brand">
          <span className="brand-mark" />
          RoleLoop<span className="brand-period">.</span>
        </div>
        <div className="connection-content">
          {failure ? (
            <AlertTriangle size={32} />
          ) : (
            <LoaderCircle className="spin" size={32} />
          )}
          <h1>
            {failure
              ? "Let’s connect your workspace."
              : "Opening your workspace…"}
          </h1>
          <p>{failure || "Connecting to your local database."}</p>
          {failure && (
            <>
              <p className="muted">
                Start the local services with <code>npm run setup</code>, then{" "}
                <code>npm run dev</code>.
              </p>
              <button className="button primary" onClick={() => void refresh()}>
                <RefreshCw size={16} />
                Try again
              </button>
            </>
          )}
        </div>
      </main>
    );
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
          <label htmlFor="workspace-picker">WORKSPACE</label>
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
        <header className="topbar">
          <div className="breadcrumb">
            <span className="breadcrumb-workspace">{workspace.name}</span>
            <ChevronRight size={13} />
            <strong>{nav.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-dot" />
            On your computer
            <IconButton
              label="Refresh workspace"
              onClick={() => void refresh()}
              disabled={busy}
            >
              <RefreshCw size={15} className={busy ? "spin" : ""} />
            </IconButton>
          </div>
        </header>
        {accountNotice && page !== "account" && (
          <div className="notice neutral" role="status">
            <ShieldCheck size={16} />
            <span>{accountNotice}</span>
          </div>
        )}
        {failure && (
          <div className="notice error" role="alert">
            <AlertTriangle size={16} />
            Connection interrupted: {failure}
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        {data.profile.isDemo && (
          <div className="demo-ribbon">
            <span>
              <strong>Sample workspace</strong> You’re testing with a fictional
              profile and clearly marked examples.
            </span>
            <button onClick={() => navigate("profile")}>
              Add your experience
              <ArrowRight size={14} />
            </button>
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
          <ProfileEditor initial={data.profile} perform={perform} busy={busy} />
        )}
        {page === "settings" && (
          <PreferencesEditor
            initial={data.preferences}
            perform={perform}
            busy={busy}
            ollamaAvailable={data.status.ollamaAvailable}
          />
        )}
        {page === "sources" && (
          <Sources initial={data.sources} perform={perform} busy={busy} />
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
    [stage, setStage] = useState("all"),
    [selected, setSelected] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<Opportunity | null>(null),
    [discovering, setDiscovering] = useState(false);
  const all = data.opportunities.filter((o) => o.kind === kind),
    list = all.filter(
      (o) =>
        (stage === "all" ? o.stage !== "archived" : o.stage === stage) &&
        `${o.company} ${o.title} ${o.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  const chosen = data.opportunities.find((o) => o.id === selected);
  const run = (action: RunAction, id: string) =>
    perform(
      () => write("/runs", { action, opportunityId: id }),
      `${action === "draft" ? "Draft preparation" : action === "research" ? "Research" : "Evaluation"} queued.`,
    );
  const relatedDrafts = chosen
    ? data.drafts.filter((d) => d.opportunityId === chosen.id)
    : [];
  return (
    <section className="page opportunities-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {kind === "job" ? "THE APPLICATION PATH" : "THE FOUNDER PATH"}
          </div>
          <h1>{kind === "job" ? "Job opportunities" : "Startup prospects"}</h1>
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
            disabled={busy}
            onClick={() => setDiscovering(true)}
          >
            <Radio size={16} />
            Discover
          </button>
        </div>
      </div>
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
          <span>04</span>Review
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
          <option value="all">Active opportunities</option>
          {[
            "new",
            "review",
            "ready",
            "drafted",
            "approved",
            "archived",
          ].map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
        <span className="result-count">
          {list.length} {list.length === 1 ? "opportunity" : "opportunities"}
        </span>
      </div>
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
                  <span className="row-meta">
                    {o.location}
                    <span>·</span>
                    {kind === "job" ? salary(o) : o.source}
                  </span>
                </span>
                <span className="opportunity-trailing">
                  <Badge value={opportunityBadge(o)} />
                  <span
                    className={`score ${o.assessment?.recommendation !== "excluded" && o.assessment?.score && o.assessment.score >= data.preferences.minimumMatch ? "good" : ""}`}
                  >
                    {o.assessment ? `${Math.round(o.assessment.score)}%` : "—"}
                    <small>
                      {kind === "job" ? "evidence fit" : "relevance"}
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
                  : kind === "job"
                    ? "Start with your next opportunity"
                    : "Build your startup shortlist"
              }
              detail={
                query
                  ? "Try another search or change the stage filter."
                  : "Connect a source to discover opportunities, or add one manually."
              }
            >
              <button
                className="button primary"
                onClick={() => navigate("sources")}
              >
                Manage sources
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
              <External url={chosen.url}>View source</External>
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
                    {kind === "job" ? "Evidence match" : "Startup assessment"}
                  </h3>
                  <span className="match-number">
                    {Math.round(chosen.assessment.score)}
                    <small>%</small>
                  </span>
                </div>
                <div className="match-track">
                  <i
                    style={{
                      width: `${Math.min(100, chosen.assessment.score)}%`,
                    }}
                  />
                </div>
                <div className="match-note">
                  {kind === "job"
                    ? `${Math.round(chosen.assessment.essentialScore)}% essential coverage · internal score, not an employer ATS score`
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
  return `${amount(o.salaryMin)}${o.salaryMax !== null ? `–${amount(o.salaryMax)}` : "+"} / ${o.salaryPeriod}`;
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
  kind,
  existing,
  close,
  perform,
  busy,
}: {
  kind: Opportunity["kind"];
  existing?: Opportunity;
  close: () => void;
  perform: Perform;
  busy: boolean;
}) {
  const [form, setForm] = useState({
    company: existing?.company || "",
    title: existing?.title || "",
    description: existing?.description || "",
    url: existing?.url || "",
    companyUrl: existing?.companyUrl || "",
    location: existing?.location || "Unknown",
    companyCountry: existing?.companyCountry || "Unknown",
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
              value={form.company}
              onChange={(e) => update("company", e.target.value)}
            />
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
          <Field label="Company website">
            <input
              type="url"
              value={form.companyUrl}
              onChange={(e) => update("companyUrl", e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <Field label="Description / source text" wide>
            <textarea
              required
              rows={6}
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
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
                hint="One per line: [essential] Build APIs | TypeScript, PostgreSQL. Use [preferred] or [hard] where appropriate."
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

function ProfileEditor({
  initial,
  perform,
  busy,
}: {
  initial: Profile;
  perform: Perform;
  busy: boolean;
}) {
  const [profile, setProfile] = useState<Profile>(initial),
    [skills, setSkills] = useState(initial.skills.join(", "));
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({ ...p, [key]: value }));
  const updateEvidence = (id: string, key: string, value: unknown) =>
    setProfile((p) => ({
      ...p,
      evidence: p.evidence.map((e) =>
        e.id === id ? { ...e, [key]: value } : e,
      ),
    }));
  return (
    <section className="page form-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">THE SOURCE OF TRUTH</div>
          <h1>My profile</h1>
          <p>
            Your verified experience is the foundation of every application.
          </p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(
            () =>
              write("/profile", { ...profile, skills: words(skills) }, "PUT"),
            "Profile saved. Re-evaluate existing opportunities to use these facts.",
          );
        }}
      >
        <section className="form-section">
          <div className="form-section-heading">
            <h2>The essentials</h2>
            <p>Use the details you want recruiters and founders to see.</p>
          </div>
          <div className="form-grid">
            <Field label="Full name">
              <input
                required
                value={profile.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label="Professional headline">
              <input
                value={profile.headline}
                onChange={(e) => set("headline", e.target.value)}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={profile.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </Field>
            <Field label="Portfolio / professional website">
              <input
                value={profile.portfolio}
                type="url"
                onChange={(e) => set("portfolio", e.target.value)}
              />
            </Field>
            <Field label="Location">
              <input
                value={profile.location}
                onChange={(e) => set("location", e.target.value)}
              />
            </Field>
            <Field label="Working country">
              <input
                value={profile.country}
                onChange={(e) => set("country", e.target.value)}
              />
            </Field>
            <Field label="Professional summary" wide>
              <textarea
                rows={4}
                value={profile.summary}
                onChange={(e) => set("summary", e.target.value)}
              />
            </Field>
            <Field
              label="Skills"
              hint="Separate skills with commas. Support your strongest skills with evidence below."
              wide
            >
              <input
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
              />
            </Field>
            {profile.isDemo && (
              <label className="checkbox-field wide">
                <input
                  type="checkbox"
                  checked={profile.isDemo}
                  onChange={(e) => set("isDemo", e.target.checked)}
                />
                <span>
                  This is a fictional test profile
                  <small>
                    Uncheck after replacing the sample information with your own.
                  </small>
                </span>
              </label>
            )}
          </div>
        </section>
        <section className="form-section">
          <div className="form-section-heading row-heading">
            <div>
              <h2>Experience & evidence</h2>
              <p>
                Specific achievements, projects and responsibilities. Only
                verified entries can support generated claims.
              </p>
            </div>
            <button
              className="button"
              type="button"
              onClick={() =>
                set("evidence", [
                  ...profile.evidence,
                  {
                    id: uid(),
                    text: "",
                    skills: [],
                    verified: false,
                    role: "",
                    company: "",
                    period: "",
                  },
                ])
              }
            >
              <Plus size={16} />
              Add evidence
            </button>
          </div>
          {profile.evidence.map((evidence, i) => (
            <div className="evidence-editor" key={evidence.id}>
              <div className="evidence-heading">
                <span className="eyebrow">
                  EVIDENCE {String(i + 1).padStart(2, "0")}
                </span>
                <IconButton
                  label={`Remove evidence ${i + 1}`}
                  onClick={() =>
                    set(
                      "evidence",
                      profile.evidence.filter((e) => e.id !== evidence.id),
                    )
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <div className="form-grid">
                <Field label="Role">
                  <input
                    value={evidence.role}
                    onChange={(e) =>
                      updateEvidence(evidence.id, "role", e.target.value)
                    }
                  />
                </Field>
                <Field label="Company / project">
                  <input
                    value={evidence.company}
                    onChange={(e) =>
                      updateEvidence(evidence.id, "company", e.target.value)
                    }
                  />
                </Field>
                <Field label="Period">
                  <input
                    value={evidence.period}
                    onChange={(e) =>
                      updateEvidence(evidence.id, "period", e.target.value)
                    }
                    placeholder="2022–2025"
                  />
                </Field>
                <Field label="Related skills">
                  <input
                    defaultValue={evidence.skills.join(", ")}
                    onBlur={(e) =>
                      updateEvidence(
                        evidence.id,
                        "skills",
                        words(e.target.value),
                      )
                    }
                  />
                </Field>
                <Field label="What you accomplished" wide>
                  <textarea
                    required
                    rows={3}
                    value={evidence.text}
                    onChange={(e) =>
                      updateEvidence(evidence.id, "text", e.target.value)
                    }
                    placeholder="Describe a real contribution and its outcome. Include metrics only when you can support them."
                  />
                </Field>
                <label className="checkbox-field wide">
                  <input
                    type="checkbox"
                    checked={evidence.verified}
                    onChange={(e) =>
                      updateEvidence(evidence.id, "verified", e.target.checked)
                    }
                  />
                  <span>I confirm this statement is accurate.</span>
                </label>
              </div>
            </div>
          ))}
          {profile.evidence.length === 0 && (
            <div className="inline-empty">
              Add your first achievement or project to enable evidence-based
              drafting.
            </div>
          )}
        </section>
        <div className="form-save">
          <span className="muted">
            <ShieldCheck size={15} />
            Stored in your local workspace
          </span>
          <button className="button primary" disabled={busy}>
            <Save size={16} />
            Save profile
          </button>
        </div>
      </form>
    </section>
  );
}

function PreferencesEditor({
  initial,
  perform,
  busy,
  ollamaAvailable,
}: {
  initial: Preferences;
  perform: Perform;
  busy: boolean;
  ollamaAvailable: boolean;
}) {
  const [prefs, setPrefs] = useState(initial),
    [roles, setRoles] = useState(initial.roles.join(", ")),
    [industries, setIndustries] = useState(initial.industries.join(", "));
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setPrefs((p) => ({ ...p, [key]: value }));
  return (
    <section className="page form-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DEFINE YOUR SEARCH</div>
          <h1>Search preferences</h1>
          <p>Set the boundaries. Let both discovery paths work within them.</p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(
            () =>
              write(
                "/preferences",
                {
                  ...prefs,
                  roles: words(roles),
                  industries: words(industries),
                },
                "PUT",
              ),
            "Search preferences saved.",
          );
        }}
      >
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Roles & location</h2>
          </div>
          <div className="form-grid">
            <Field
              label="Target roles"
              hint="Separate titles with commas."
              wide
            >
              <input value={roles} onChange={(e) => setRoles(e.target.value)} />
            </Field>
            <Field label="Working country">
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
            <Field label="Industries / interests" wide>
              <input
                value={industries}
                onChange={(e) => setIndustries(e.target.value)}
                placeholder="Developer tools, climate, infrastructure"
              />
            </Field>
          </div>
        </section>
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Compensation</h2>
            <p>
              Set your base salary in either period. The other amount updates
              automatically.
            </p>
          </div>
          <div className="form-grid compensation-grid">
            <SalaryFields
              minimumSalary={prefs.minimumSalary}
              targetSalary={prefs.targetSalary}
              onChange={set}
            />
            <Field label="Salary range policy">
              <select
                value={prefs.salaryPolicy}
                onChange={(e) =>
                  set(
                    "salaryPolicy",
                    e.target.value as Preferences["salaryPolicy"],
                  )
                }
              >
                <option value="overlap">Range may reach my minimum</option>
                <option value="strict">
                  Advertised minimum must meet mine
                </option>
              </select>
            </Field>
            <Field label="When salary is missing">
              <select
                value={prefs.missingSalary}
                onChange={(e) =>
                  set(
                    "missingSalary",
                    e.target.value as Preferences["missingSalary"],
                  )
                }
              >
                <option value="review">Keep for review</option>
                <option value="include">
                  Include with uncertainty visible
                </option>
                <option value="exclude">Exclude advertised jobs</option>
              </select>
            </Field>
          </div>
        </section>
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Freshness & fit</h2>
            <p>
              Today is always included. A window of zero days means today only.
            </p>
          </div>
          <div className="form-grid">
            <Field label="Look back">
              <input
                type="number"
                min="0"
                max="365"
                value={prefs.lookback}
                onChange={(e) => set("lookback", +e.target.value)}
              />
            </Field>
            <Field label="Window unit">
              <select
                value={prefs.lookbackUnit}
                onChange={(e) =>
                  set(
                    "lookbackUnit",
                    e.target.value as Preferences["lookbackUnit"],
                  )
                }
              >
                <option value="days">Previous days + today</option>
                <option value="months">Previous calendar months + today</option>
              </select>
            </Field>
            <Field label="Date policy">
              <select
                value={prefs.dateMode}
                onChange={(e) =>
                  set("dateMode", e.target.value as Preferences["dateMode"])
                }
              >
                <option value="emphasize">
                  Prioritize recent opportunities
                </option>
                <option value="strict">Exclude older opportunities</option>
              </select>
            </Field>
            <Field label="Timezone">
              <input
                required
                value={prefs.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              />
            </Field>
            <Field label="Minimum overall match (%)">
              <input
                type="number"
                min="0"
                max="100"
                value={prefs.minimumMatch}
                onChange={(e) => set("minimumMatch", +e.target.value)}
              />
            </Field>
            <Field label="Minimum essential coverage (%)">
              <input
                type="number"
                min="0"
                max="100"
                value={prefs.essentialMatch}
                onChange={(e) => set("essentialMatch", +e.target.value)}
              />
            </Field>
          </div>
          <p className="form-footnote">
            Match thresholds apply to advertised requirements. Startups are
            assessed for relevance and verified signals separately.
          </p>
        </section>
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Local automation</h2>
            <p>
              Scheduled work runs while the app and your computer are awake.
            </p>
          </div>
          <div className="form-grid">
            <label className="checkbox-field wide">
              <input
                type="checkbox"
                checked={prefs.scheduleEnabled}
                onChange={(e) => set("scheduleEnabled", e.target.checked)}
              />
              <span>Automatically refresh enabled discovery sources</span>
            </label>
            <Field label="Refresh every (minutes)">
              <input
                type="number"
                min="15"
                max="1440"
                value={prefs.scheduleMinutes}
                onChange={(e) => set("scheduleMinutes", +e.target.value)}
              />
            </Field>
            <Field label="Daily draft limit">
              <input
                type="number"
                min="1"
                max="100"
                value={prefs.dailyLimit}
                onChange={(e) => set("dailyLimit", +e.target.value)}
              />
            </Field>
            <Field
              label="Draft preparation"
              hint="Ollama ranks your verified evidence. Final text uses evidence templates to keep claims grounded."
            >
              <select
                value={prefs.modelMode}
                onChange={(e) =>
                  set("modelMode", e.target.value as Preferences["modelMode"])
                }
              >
                <option value="templates">
                  Evidence templates — no model required
                </option>
                <option value="ollama">
                  Ollama evidence ranking + templates
                </option>
              </select>
            </Field>
            <Field
              label="Ollama model"
              hint={
                ollamaAvailable
                  ? "Ollama is available locally."
                  : "Ollama is not currently reachable. Templates work without it."
              }
            >
              <input
                value={prefs.ollamaModel}
                onChange={(e) => set("ollamaModel", e.target.value)}
                placeholder="Installed model name"
                disabled={prefs.modelMode !== "ollama"}
              />
            </Field>
          </div>
        </section>
        <div className="form-save">
          <span className="muted">
            <ShieldCheck size={15} />
            Live sending remains disabled
          </span>
          <button className="button primary" disabled={busy}>
            <Save size={16} />
            Save preferences
          </button>
        </div>
      </form>
    </section>
  );
}

function Sources({
  initial,
  perform,
  busy,
}: {
  initial: Source[];
  perform: Perform;
  busy: boolean;
}) {
  const [sources, setSources] = useState(initial);
  const update = (id: string, patch: Partial<Source>) =>
    setSources((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  return (
    <section className="page form-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WHERE OPPORTUNITIES BEGIN</div>
          <h1>Discovery sources</h1>
          <p>Connect public company boards and startup launch feeds.</p>
        </div>
        <button
          className="button"
          onClick={() =>
            setSources((p) => [
              ...p,
              {
                id: uid(),
                provider: "ashby",
                label: "",
                board: "",
                enabled: true,
              },
            ])
          }
        >
          <Plus size={16} />
          Add source
        </button>
      </div>
      <div className="notice neutral">
        <Radio size={18} />
        <span>
          For job boards, use the company identifier from its Ashby, Greenhouse
          or Lever URL. Startup launches are leads to research; location,
          funding and hiring eligibility remain unverified until supported.
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(
            () => write("/sources", { sources }, "PUT"),
            "Sources saved.",
          );
        }}
      >
        {sources.map((source) => (
          <section className="source-editor" key={source.id}>
            <div className="source-editor-top">
              <span className="source-icon">
                {source.provider === "hackernews" ? (
                  <Rocket size={20} />
                ) : (
                  <Briefcase size={20} />
                )}
              </span>
              <h2>{source.label || "New discovery source"}</h2>
              <IconButton
                label={`Remove ${source.label || "source"}`}
                onClick={() =>
                  setSources((p) => p.filter((s) => s.id !== source.id))
                }
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
            <div className="form-grid">
              <Field label="Display name">
                <input
                  required
                  value={source.label}
                  onChange={(e) => update(source.id, { label: e.target.value })}
                  placeholder="Acme careers"
                />
              </Field>
              <Field label="Provider">
                <select
                  value={source.provider}
                  onChange={(e) =>
                    update(source.id, {
                      provider: e.target.value as Source["provider"],
                    })
                  }
                >
                  <option value="ashby">Ashby</option>
                  <option value="greenhouse">Greenhouse</option>
                  <option value="lever">Lever</option>
                  <option value="hackernews">
                    Hacker News · Show HN launches
                  </option>
                </select>
              </Field>
              <Field
                label={
                  source.provider === "hackernews"
                    ? "Search keyword (optional)"
                    : "Company board identifier"
                }
                hint={
                  source.provider === "hackernews"
                    ? "A topic to narrow startup launches, such as developer tools."
                    : "Example: acme from jobs.ashbyhq.com/acme"
                }
                wide
              >
                <input
                  value={source.board}
                  required={source.provider !== "hackernews"}
                  onChange={(e) => update(source.id, { board: e.target.value })}
                />
              </Field>
              <label className="checkbox-field wide">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  onChange={(e) =>
                    update(source.id, { enabled: e.target.checked })
                  }
                />
                <span>Include in discovery</span>
              </label>
            </div>
            <div className="source-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy || !source.enabled || !source.label}
                onClick={async () => {
                  if (
                    await perform(() => write("/sources", { sources }, "PUT"))
                  )
                    await perform(
                      () =>
                        write("/runs", {
                          action: "discover",
                          sourceId: source.id,
                        }),
                      "Discovery queued.",
                    );
                }}
              >
                <Play size={14} />
                Save & discover now
              </button>
            </div>
          </section>
        ))}
        {!sources.length && (
          <Empty
            title="Connect your first source"
            detail="Add a company job board or a startup launch feed above."
          />
        )}
        <div className="form-save">
          <span className="muted">
            Public sources only · evidence preserved
          </span>
          <button className="button primary" disabled={busy}>
            <Save size={16} />
            Save sources
          </button>
        </div>
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
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">REVIEW BEFORE THE NEXT STEP</div>
          <h1>Drafts</h1>
          <p>
            Review and download your application documents and founder emails.
          </p>
        </div>
      </div>
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
            {draft.generator === "templates"
              ? "Evidence templates"
              : "Local AI"}
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
    <section className="page activity-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">THE WORK BEHIND YOUR WORKSPACE</div>
          <h1>Activity</h1>
          <p>Discovery runs and decisions, in one place.</p>
        </div>
      </div>
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
