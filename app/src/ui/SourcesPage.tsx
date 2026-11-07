import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import type {
  Bootstrap,
  Preferences,
  Source,
  SourceHealth,
} from "../shared/types";
import {
  addRecommendedSources,
  normalizeSource,
  sourceLibrary,
  additionalJobBoards,
  sourceKind,
  startupLibrary,
} from "../shared/discovery";
import { api, ApiError, safeUrl, uid, write } from "./api";

type Perform = (
  task: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;
const providers: Record<Source["provider"], string> = {
  ashby: "Ashby",
  greenhouse: "Greenhouse",
  lever: "Lever",
  jobicy: "Jobicy",
  hackernews: "Show HN",
};
function sourceTitle(source: Source): string {
  if (sourceKind(source) !== "company_board") return source.label || "New feed";
  const company = source.companyName || source.label;
  return company ? `Jobs at ${company}` : "New company";
}
type SavedSources = { sources: Source[]; sourcesRevision: number };
export function SourcesPage({
  initial,
  sourcesRevision = 0,
  preferences,
  employerDiscovery,
  health = {},
  latestSearch,
  searching = false,
  perform,
  busy,
}: {
  initial: Source[];
  sourcesRevision?: number;
  preferences: Preferences;
  employerDiscovery?: Bootstrap["employerDiscovery"];
  health?: Record<string, SourceHealth>;
  latestSearch?: Bootstrap["runs"][number];
  searching?: boolean;
  perform: Perform;
  busy: boolean;
}) {
  const [sources, setSources] = useState(initial);
  const saved = useRef<SavedSources>({ sources: initial, sourcesRevision });
  const [conflict, setConflict] = useState(false);
  const dirty =
    JSON.stringify(sources) !== JSON.stringify(saved.current.sources);
  useEffect(() => {
    if (sourcesRevision <= saved.current.sourcesRevision) return;
    if (dirty) {
      setConflict(true);
      return;
    }
    saved.current = { sources: initial, sourcesRevision };
    setSources(initial);
    setConflict(false);
  }, [initial, sourcesRevision, dirty]);
  const adoptSources = (next: SavedSources) => {
    saved.current = next;
    setSources(next.sources);
    setConflict(false);
  };
  const [area, setArea] = useState<"jobs" | "startups" | "browse">("jobs");
  const visibleSources = sources.filter((s) =>
    area === "startups"
      ? sourceKind(s) === "startup_feed"
      : sourceKind(s) !== "startup_feed",
  );
  const groups =
    area === "startups"
      ? [{ kind: "startup_feed", title: "Startup feeds" }]
      : [
          { kind: "company_board", title: "Companies you follow" },
          { kind: "job_feed", title: "Job feeds" },
        ];
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const enabled = visibleSources.filter((s) => s.enabled).length;
  const automatic = preferences.discoverEmployers ?? true;
  const searchReady =
    preferences.roles.some((role) => role.trim()) &&
    Boolean(preferences.country.trim());
  const canSearch =
    enabled > 0 || (area === "jobs" && automatic && searchReady);
  const researchFor = (s: Source) =>
    sourceLibrary.find(
      (r) =>
        r.source.provider === s.provider &&
        r.source.board.toLowerCase() === s.board.toLowerCase(),
    );
  const includes = (candidate: Source) =>
    sources.some((s) => {
      try {
        const normalized = normalizeSource(s);
        return (
          normalized.provider === candidate.provider &&
          normalized.board.toLowerCase() === candidate.board.toLowerCase()
        );
      } catch {
        return false;
      }
    });
  const missing = startupLibrary.filter((r) => !includes(r.source));
  const update = (id: string, patch: Partial<Source>) =>
    setSources((old) => old.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const save = async (
    next: Source[] | (() => Source[]) = sources,
    message = "Sources saved.",
  ) => {
    if (conflict) return false;
    return perform(async () => {
      try {
        const result = await write<SavedSources>(
          "/sources",
          {
            sources: (typeof next === "function" ? next() : next).map(
              normalizeSource,
            ),
            expectedRevision: saved.current.sourcesRevision,
          },
          "PUT",
        );
        adoptSources(result);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setConflict(true);
          throw new Error(
            "The company list changed while you were editing. Reload the latest list before saving.",
          );
        }
        throw error;
      }
    }, message);
  };
  const add = async (additions: Source[]) => {
    await save(
      () => addRecommendedSources(sources, additions),
      "Sources added.",
    );
  };
  const discover = async (sourceId?: string) => {
    if (!dirty || (await save()))
      await perform(
        () =>
          write("/runs", {
            action: "discover",
            discoveryScope: area === "startups" ? "startups" : "jobs",
            ...(sourceId ? { sourceId } : {}),
          }),
        "Discovery queued. Follow progress in Activity.",
      );
  };
  const toggleAutomatic = () =>
    perform(
      async () => {
        const { preferences: current } = await api<Bootstrap>("/bootstrap");
        await write(
          "/preferences",
          { ...current, discoverEmployers: !automatic },
          "PUT",
        );
      },
      automatic
        ? "New company discovery paused."
        : "New company discovery enabled.",
    );
  const companyCount = visibleSources.filter(
    (source) => source.enabled && sourceKind(source) === "company_board",
  ).length;
  const feedCount = visibleSources.filter(
    (source) => source.enabled && sourceKind(source) === "job_feed",
  ).length;
  const roles = preferences.roles.filter((role) => role.trim());
  const sourceErrors = visibleSources.filter(
    (source) => source.enabled && health[source.id]?.status === "error",
  ).length;
  return (
    <section
      className="page source-workspace"
      aria-labelledby="discovery-title"
    >
      <header className="page-heading">
        <div>
          <h1 id="discovery-title">Discovery</h1>
          <p>Find your next role or a startup worth a conversation.</p>
        </div>
        {area !== "browse" && (
          <button
            className="button primary"
            disabled={busy || searching || !canSearch || conflict}
            onClick={() => void discover()}
          >
            <Search size={16} />
            {searching
              ? "Searching…"
              : area === "startups"
                ? "Find startup leads"
                : "Search jobs"}
          </button>
        )}
      </header>
      <div
        className="discovery-tabs"
        role="tablist"
        aria-label="Discovery purpose"
      >
        {(
          [
            ["jobs", "Find jobs"],
            ["startups", "Research startups"],
            ["browse", "Browse job sites"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`discovery-tab-${id}`}
            role="tab"
            type="button"
            aria-selected={area === id}
            tabIndex={area === id ? 0 : -1}
            onKeyDown={(event) => {
              const ids = ["jobs", "startups", "browse"] as const;
              const index = ids.indexOf(area);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % 3
                  : event.key === "ArrowLeft"
                    ? (index + 2) % 3
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setArea(ids[next]);
              setEditing(null);
              setAdvancedOpen(ids[next] === "startups");
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
            aria-controls="discovery-purpose-panel"
            onClick={() => {
              setArea(id);
              setEditing(null);
              setAdvancedOpen(id === "startups");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="discovery-purpose-panel"
        aria-labelledby={`discovery-tab-${area}`}
      >
        <p className="discovery-purpose-note">
          {area === "jobs"
            ? "RoleLoop manages job sources for you and checks openings against your search preferences."
            : area === "startups"
              ? "Discover product launches for possible outreach. These are research leads, not advertised jobs. Results appear in Startup prospects."
              : "Open a job site, find a role, then bring its original listing into Add role. These sites are browsed manually."}
        </p>
        {area === "jobs" && (
          <section
            className="discovery-overview"
            aria-labelledby="search-overview-title"
          >
            <div className="discovery-overview-heading">
              <h2 id="search-overview-title">Your job search</h2>
              <a className="text-button" href="#settings">
                Edit preferences
              </a>
            </div>
            <dl className="discovery-preferences">
              <div>
                <dt>Target roles</dt>
                <dd>
                  {roles.length
                    ? roles.slice(0, 3).join(", ")
                    : "Choose your target roles"}
                  {roles.length > 3 && (
                    <span className="muted"> +{roles.length - 3} more</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Working from</dt>
                <dd>{preferences.country || "Choose your country"}</dd>
              </div>
              <div>
                <dt>Minimum annual pay</dt>
                <dd>
                  {preferences.minimumSalary > 0
                    ? new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      }).format(preferences.minimumSalary) + " USD"
                    : "No minimum"}
                </dd>
              </div>
            </dl>
            <div className="discovery-coverage">
              <p>
                {enabled > 0
                  ? `${companyCount} ${companyCount === 1 ? "company" : "companies"} and ${feedCount} job ${feedCount === 1 ? "feed" : "feeds"} enabled.`
                  : "No companies or job feeds enabled yet."}{" "}
                {automatic
                  ? "RoleLoop looks for new companies when you search."
                  : "Automatic company discovery is paused."}
              </p>
              <a className="text-button" href="#jobs">
                View job opportunities <ArrowUpRight size={15} />
              </a>
            </div>
            {!searchReady && (
              <p className="discovery-setup-note">
                <a href="#settings">
                  Set your target roles and working country
                </a>{" "}
                to find relevant employers.
                {enabled > 0 &&
                  " You can still search your enabled companies and feeds."}
              </p>
            )}
            {!canSearch && (
              <p className="discovery-setup-note">
                {automatic
                  ? "Complete your search preferences to start searching."
                  : "Enable automatic company discovery or a company in advanced settings to start searching."}
                {!automatic && (
                  <>
                    {" "}
                    <button
                      className="text-button"
                      onClick={() => setAdvancedOpen(true)}
                    >
                      Open advanced settings
                    </button>
                  </>
                )}
              </p>
            )}
            {latestSearch && (
              <div
                className={`discovery-last-result${latestSearch.status === "failed" ? " source-error" : ""}`}
                role="status"
              >
                <p>
                  <strong>
                    {latestSearch.status === "failed"
                      ? "Last search failed"
                      : "Last search"}
                    :
                  </strong>{" "}
                  {latestSearch.message}
                </p>
                <small>
                  {new Date(latestSearch.updatedAt).toLocaleString()} ·{" "}
                  <a href="#activity">View activity</a>
                </small>
              </div>
            )}
            {sourceErrors > 0 && (
              <p className="discovery-setup-note">
                {sourceErrors}{" "}
                {sourceErrors === 1 ? "source needs" : "sources need"} attention
                based on their latest checks.{" "}
                <button
                  className="text-button"
                  onClick={() => setAdvancedOpen(true)}
                >
                  View details
                </button>
              </p>
            )}
            {automatic &&
              employerDiscovery &&
              ["error", "partial"].includes(employerDiscovery.status) && (
                <p className="discovery-setup-note">
                  Automatic company discovery needs attention.{" "}
                  {enabled > 0 &&
                    "Your enabled companies and feeds can still be searched. "}
                  <button
                    className="text-button"
                    onClick={() => setAdvancedOpen(true)}
                  >
                    View discovery details
                  </button>
                </p>
              )}
          </section>
        )}
        {area !== "browse" && (
          <>
            {conflict && (
              <div className="discovery-conflict" role="alert">
                <p>
                  The company list changed while you were editing. Your edits
                  are still here; reload to use the latest list.
                </p>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const current = await api<Bootstrap>("/bootstrap");
                      adoptSources({
                        sources: current.sources,
                        sourcesRevision: current.sourcesRevision ?? 0,
                      });
                      setEditing(null);
                    }, "Latest company list loaded.")
                  }
                >
                  Discard edits and reload
                </button>
              </div>
            )}
            <details
              className="discovery-advanced"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>
                <Settings2 size={16} />
                <span>
                  {area === "jobs"
                    ? "Advanced search settings"
                    : "Research settings"}
                </span>
                <ChevronDown size={16} />
              </summary>
              <p className="discovery-advanced-note">
                {area === "jobs"
                  ? "Optional: follow a specific company, pause a source or inspect its latest search."
                  : "Choose which startup feeds to include in your research."}
              </p>
              {area === "jobs" && (
                <section
                  className="employer-discovery"
                  aria-labelledby="employer-discovery-title"
                >
                  <div className="employer-discovery-heading">
                    <div>
                      <h2 id="employer-discovery-title">
                        Find new companies automatically
                      </h2>
                      <p>
                        Discover employers using your{" "}
                        <a href="#settings">search preferences</a> and connect
                        their supported career pages.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={automatic}
                      aria-label="Find new companies automatically"
                      className="source-toggle"
                      disabled={busy}
                      onClick={() => void toggleAutomatic()}
                    >
                      <span />
                    </button>
                  </div>
                  {automatic && !searchReady && (
                    <p className="discovery-setup-note">
                      Set your target roles and working country to find new
                      companies. Your followed companies can still be searched.
                    </p>
                  )}
                  {employerDiscovery && (
                    <div
                      className={`discovery-last-result${employerDiscovery.status === "error" ? " source-error" : ""}`}
                      role="status"
                    >
                      <p>{employerDiscovery.message}</p>
                      <small>
                        Last checked{" "}
                        {new Date(employerDiscovery.checkedAt).toLocaleString()}
                      </small>
                    </div>
                  )}
                </section>
              )}
              <section
                className="source-section"
                aria-labelledby="your-sources-title"
              >
                <div className="source-section-heading">
                  <div>
                    <h2 id="your-sources-title">
                      {area === "jobs"
                        ? "Companies and feeds"
                        : "Your startup research"}{" "}
                      <span>{enabled} enabled</span>
                    </h2>
                    <p>Choose what to include in your next search.</p>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy || conflict || sources.length >= 50}
                    onClick={() => {
                      const source: Source = {
                        id: uid(),
                        label: area === "startups" ? "Show HN" : "",
                        provider: area === "startups" ? "hackernews" : "ashby",
                        board: "",
                        enabled: true,
                      };
                      setSources((old) => [...old, source]);
                      setEditing(source.id);
                    }}
                  >
                    <Plus size={16} />
                    {area === "startups" ? "Add startup feed" : "Add company"}
                  </button>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  {groups.map((group) => (
                    <section
                      className="discovery-source-group"
                      key={group.kind}
                    >
                      <h3>{group.title}</h3>
                      {visibleSources
                        .filter((source) => sourceKind(source) === group.kind)
                        .map((source) => {
                          const research = researchFor(source),
                            result = health[source.id];
                          const feed = ["hackernews", "jobicy"].includes(
                            source.provider,
                          );
                          return (
                            <div className="source-managed-row" key={source.id}>
                              <div className="source-managed-top">
                                <div className="source-row-copy">
                                  <strong>{sourceTitle(source)}</strong>
                                  <p
                                    className={
                                      result?.status === "error"
                                        ? "source-error"
                                        : undefined
                                    }
                                  >
                                    {result
                                      ? result.status === "success"
                                        ? `${result.found} listings read · ${result.evaluated} evaluated · ${new Date(result.checkedAt).toLocaleString()}`
                                        : `Search failed · ${result.error}`
                                      : (research?.coverage ??
                                        (feed
                                          ? "Research feed"
                                          : "Company job board"))}
                                  </p>
                                </div>
                                <div className="source-row-actions">
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={source.enabled}
                                    aria-label={`Enable ${source.label || "new source"}`}
                                    className="source-toggle"
                                    disabled={busy || conflict}
                                    onClick={() =>
                                      void save(
                                        sources.map((s) =>
                                          s.id === source.id
                                            ? { ...s, enabled: !s.enabled }
                                            : s,
                                        ),
                                      )
                                    }
                                  >
                                    <span />
                                  </button>
                                  <button
                                    type="button"
                                    className="source-icon-action"
                                    aria-label={`Settings for ${source.label || "new source"}`}
                                    aria-expanded={editing === source.id}
                                    onClick={() =>
                                      setEditing(
                                        editing === source.id
                                          ? null
                                          : source.id,
                                      )
                                    }
                                  >
                                    <Settings2 size={17} />
                                  </button>
                                  <button
                                    type="button"
                                    className="source-icon-action"
                                    aria-label={`Search ${source.label || "new source"}`}
                                    disabled={
                                      busy ||
                                      searching ||
                                      conflict ||
                                      !source.enabled
                                    }
                                    onClick={() => void discover(source.id)}
                                  >
                                    <Search size={17} />
                                  </button>
                                </div>
                              </div>
                              {editing === source.id && (
                                <div className="source-settings">
                                  <div className="form-grid">
                                    {source.discoveredFrom && (
                                      <p className="wide discovery-source-origin">
                                        Found automatically.{" "}
                                        <a
                                          href={safeUrl(source.discoveredFrom)}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          View discovery source ↗
                                        </a>
                                      </p>
                                    )}
                                    <label className="field">
                                      <span>
                                        {feed ? "Feed name" : "Company name"}
                                      </span>
                                      <input
                                        required
                                        value={source.label}
                                        onChange={(e) =>
                                          update(source.id, {
                                            label: e.target.value,
                                            ...(feed
                                              ? {}
                                              : {
                                                  companyName: e.target.value,
                                                }),
                                          })
                                        }
                                      />
                                    </label>
                                    {!feed && (
                                      <details className="wide discovery-connection">
                                        <summary>Connection details</summary>
                                        <label className="field">
                                          <span>Job board platform</span>
                                          <select
                                            value={source.provider}
                                            onChange={(e) =>
                                              update(source.id, {
                                                provider: e.target
                                                  .value as Source["provider"],
                                                companyCountry: undefined,
                                                countrySource: undefined,
                                              })
                                            }
                                          >
                                            {Object.entries(providers)
                                              .filter(
                                                ([provider]) =>
                                                  ![
                                                    "hackernews",
                                                    "jobicy",
                                                  ].includes(provider),
                                              )
                                              .map(([value, name]) => (
                                                <option
                                                  key={value}
                                                  value={value}
                                                >
                                                  {name}
                                                </option>
                                              ))}
                                          </select>
                                        </label>
                                      </details>
                                    )}
                                    <label className="field wide">
                                      <span>
                                        {feed
                                          ? "Keyword (optional)"
                                          : "Company careers link"}
                                      </span>
                                      <input
                                        required={!feed}
                                        value={
                                          feed ||
                                          !source.board ||
                                          /^https:\/\//.test(source.board)
                                            ? source.board
                                            : source.provider === "ashby"
                                              ? `https://jobs.ashbyhq.com/${source.board}`
                                              : source.provider === "greenhouse"
                                                ? `https://job-boards.greenhouse.io/${source.board}`
                                                : `https://jobs.lever.co/${source.board}`
                                        }
                                        placeholder={
                                          feed
                                            ? "e.g. customer support"
                                            : "https://jobs.ashbyhq.com/company"
                                        }
                                        onChange={(e) =>
                                          update(source.id, {
                                            board: e.target.value,
                                            companyCountry: undefined,
                                            countrySource: undefined,
                                          })
                                        }
                                      />
                                    </label>
                                    {!feed && (
                                      <>
                                        {source.countrySource && (
                                          <a
                                            className="text-button wide"
                                            href={safeUrl(source.countrySource)}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            View company country reference{" "}
                                            <ArrowUpRight size={14} />
                                          </a>
                                        )}
                                        <label className="field">
                                          <span>Company country</span>
                                          <input
                                            value={source.companyCountry ?? ""}
                                            placeholder="United States"
                                            onChange={(e) =>
                                              update(source.id, {
                                                companyCountry: e.target.value,
                                              })
                                            }
                                          />
                                        </label>
                                        <label className="field">
                                          <span>
                                            Official country evidence URL
                                          </span>
                                          <input
                                            type="url"
                                            value={source.countrySource ?? ""}
                                            onChange={(e) =>
                                              update(source.id, {
                                                countrySource:
                                                  e.target.value || undefined,
                                              })
                                            }
                                          />
                                        </label>
                                      </>
                                    )}
                                  </div>
                                  <div className="source-settings-footer">
                                    <button
                                      className="button"
                                      disabled={busy || conflict}
                                    >
                                      Save sources
                                    </button>
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={busy}
                                      onClick={() => {
                                        const original =
                                          saved.current.sources.find(
                                            (item) => item.id === source.id,
                                          );
                                        setSources((current) =>
                                          original
                                            ? current.map((item) =>
                                                item.id === source.id
                                                  ? original
                                                  : item,
                                              )
                                            : current.filter(
                                                (item) => item.id !== source.id,
                                              ),
                                        );
                                        setEditing(null);
                                      }}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={busy || conflict}
                                      onClick={() =>
                                        void save(
                                          sources.filter(
                                            (s) => s.id !== source.id,
                                          ),
                                          "Source removed.",
                                        )
                                      }
                                    >
                                      <Trash2 size={14} />
                                      {feed ? "Remove feed" : "Stop following"}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      {!visibleSources.some(
                        (s) => sourceKind(s) === group.kind,
                      ) && (
                        <p className="source-empty">
                          {group.kind === "company_board"
                            ? "New companies are found when automatic discovery is enabled. You can also add a company’s careers link."
                            : group.kind === "job_feed"
                              ? "No job feeds connected. Company searches can still find openings."
                              : "Add Show HN below to discover product launches."}
                          {group.kind === "job_feed" && (
                            <>
                              {" "}
                              <button
                                type="button"
                                className="text-button"
                                disabled={
                                  busy || conflict || sources.length >= 50
                                }
                                onClick={() =>
                                  void add(
                                    sourceLibrary
                                      .filter(
                                        (r) =>
                                          sourceKind(r.source) === "job_feed",
                                      )
                                      .map((r) => r.source),
                                  )
                                }
                              >
                                Restore job feed
                              </button>
                            </>
                          )}
                        </p>
                      )}
                    </section>
                  ))}
                </form>
              </section>
              {area === "startups" && missing.length > 0 && (
                <section
                  className="source-section"
                  aria-labelledby="startup-feeds-title"
                >
                  <div className="source-section-heading">
                    <div>
                      <h2 id="startup-feeds-title">Startup feeds</h2>
                      <p>
                        Show HN announcements help you find products and teams
                        to research.
                      </p>
                    </div>
                    <button
                      className="button"
                      disabled={busy || conflict}
                      onClick={() => void add(missing.map((r) => r.source))}
                    >
                      <Plus size={14} /> Add Show HN
                    </button>
                  </div>
                </section>
              )}
            </details>
          </>
        )}
        {area === "browse" && (
          <section
            className="source-section source-manual"
            aria-labelledby="additional-boards-title"
          >
            <div className="source-section-heading">
              <div>
                <h2 id="additional-boards-title">Job sites to browse</h2>
                <p>
                  Browse these boards, then bring the original listing into Add
                  role. Some features require an account.
                </p>
              </div>
            </div>
            {additionalJobBoards.map((board) => (
              <a
                className="source-library-row"
                key={board.name}
                href={board.url}
                target="_blank"
                rel="noreferrer"
              >
                <div className="source-row-copy">
                  <strong>{board.name}</strong>
                  <p>{board.description}</p>
                </div>
                <ArrowUpRight size={18} />
              </a>
            ))}
          </section>
        )}
      </div>
    </section>
  );
}
