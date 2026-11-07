import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
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
  searching = false,
  perform,
  busy,
}: {
  initial: Source[];
  sourcesRevision?: number;
  preferences: Preferences;
  employerDiscovery?: Bootstrap["employerDiscovery"];
  health?: Record<string, SourceHealth>;
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
  const suggestions = area === "startups" ? startupLibrary : sourceLibrary;
  const groups =
    area === "startups"
      ? [{ kind: "startup_feed", title: "Startup feeds" }]
      : [
          { kind: "company_board", title: "Companies you follow" },
          { kind: "job_feed", title: "Job feeds" },
        ];
  const [query, setQuery] = useState("");
  const [showAdded, setShowAdded] = useState(false);
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
  const missing = suggestions.filter((r) => !includes(r.source));
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
  const library = suggestions.filter(
    (r) =>
      (showAdded || !includes(r.source)) &&
      `${r.source.label} ${r.source.provider} ${r.description} ${r.coverage}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="page source-workspace" aria-labelledby="discovery-title">
      <header className="page-heading">
        <div>
          <h1 id="discovery-title">Discovery</h1>
          <p>
            Choose where to find jobs, research startups or browse other sites.
          </p>
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
              setQuery("");
              setEditing(null);
              setShowAdded(false);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
            aria-controls="discovery-purpose-panel"
            onClick={() => {
              setArea(id);
              setQuery("");
              setEditing(null);
              setShowAdded(false);
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
            ? "Search company boards and job feeds together. Review results and prepare applications in Job opportunities."
            : area === "startups"
              ? "Discover product launches for possible outreach. These are research leads, not advertised jobs. Results appear in Startup prospects."
              : "Open a job site, find a role, then bring its original listing into Add role. These sites are browsed manually."}
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
                  <a href="#settings">search preferences</a> and connect their
                  supported career pages.
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
                Set your target roles and working country to find new companies.
                Your followed companies can still be searched.
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
            <section
              className="source-section"
              aria-labelledby="your-sources-title"
            >
              <div className="source-section-heading">
                <div>
                  <h2 id="your-sources-title">
                    {area === "jobs"
                      ? "Your job search"
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
                  <section className="discovery-source-group" key={group.kind}>
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
                                      editing === source.id ? null : source.id,
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
                                            : { companyName: e.target.value }),
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
                                              <option key={value} value={value}>
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
                          ? "Follow a suggested company below or add a company’s careers link."
                          : group.kind === "job_feed"
                            ? "Add a job feed below to search across employers."
                            : "Add Show HN below to discover product launches."}
                      </p>
                    )}
                  </section>
                ))}
              </form>
            </section>
            {(area === "jobs" || missing.length > 0) && (
              <section
                className="source-section source-library"
                aria-labelledby="source-library-title"
              >
                <div className="source-section-heading">
                  <div>
                    <h2 id="source-library-title">
                      {area === "jobs"
                        ? "Suggested companies and feeds"
                        : "Suggested startup feeds"}
                    </h2>
                    <p>
                      {area === "jobs"
                        ? "US company references and working boards, checked 6 Nov 2026. Eligibility and pay are checked per job."
                        : "Show HN announcements help you find products and teams to research."}
                    </p>
                  </div>
                  <button
                    className="button"
                    disabled={busy || conflict || !missing.length}
                    onClick={() => void add(missing.map((r) => r.source))}
                  >
                    {missing.length
                      ? `Add suggestions (${missing.length})`
                      : "All suggestions added"}
                  </button>
                </div>
                {suggestions.length > 1 && (
                  <div className="source-library-toolbar">
                    <label className="source-library-search">
                      <Search size={16} />
                      <input
                        aria-label="Find a source"
                        placeholder="Find by company or type of work"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={showAdded}
                        onChange={(e) => setShowAdded(e.target.checked)}
                      />
                      Show added
                    </label>
                  </div>
                )}
                {library.map((research) => (
                  <div className="source-library-row" key={research.source.id}>
                    <div className="source-row-copy">
                      <strong>{sourceTitle(research.source)}</strong>
                      <span className="source-provider">
                        {sourceKind(research.source) === "company_board"
                          ? "Company"
                          : sourceKind(research.source) === "job_feed"
                            ? "Job feed"
                            : "Startup feed"}
                      </span>
                      <p>{research.description}</p>
                      <small>
                        {research.coverage}
                        {research.observedListings !== undefined
                          ? ` · ${research.observedListings} listings at board check`
                          : ""}
                      </small>
                    </div>
                    <div className="source-library-actions">
                      <a
                        href={safeUrl(research.careersUrl)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${research.source.label} official careers`}
                      >
                        <ArrowUpRight size={18} />
                      </a>
                      <button
                        className="button"
                        disabled={busy || conflict || includes(research.source)}
                        onClick={() => void add([research.source])}
                      >
                        {includes(research.source) ? (
                          <>
                            <Check size={14} />
                            Added
                          </>
                        ) : (
                          <>
                            <Plus size={14} />
                            Add
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
                {!library.length && (
                  <p className="source-empty">
                    {!missing.length && !showAdded && !query
                      ? "All suggestions are added. Start your search above."
                      : "No matching source. Try a profession or add a custom company board."}
                  </p>
                )}
                {area === "jobs" && (
                  <details className="source-method">
                    <summary>
                      How sources are selected <ChevronDown size={14} />
                    </summary>
                    <p>
                      Automatic company discovery uses{" "}
                      <a
                        href="https://himalayas.app/api"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Himalayas employer search
                      </a>{" "}
                      to find employers for your target roles and working
                      country. It connects up to five new companies per search
                      after checking their linked Ashby, Lever or Greenhouse
                      boards. Job openings come from those company boards.
                      Employer country, hiring eligibility and pay still need
                      evidence.
                    </p>
                    <p>
                      Working public boards, an official company-country
                      reference, and remote openings across professions. A board
                      check confirms access, not hiring eligibility or salary.
                      Jobicy covers recent listings and refreshes at most
                      hourly; its employers need a separate country check. Use
                      application and interview results to decide which sources
                      to keep.
                    </p>
                    <div>
                      {sourceLibrary
                        .filter((r) => r.source.countrySource)
                        .map((r) => (
                          <a
                            key={r.source.id}
                            href={safeUrl(r.source.countrySource!)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {r.source.label} country reference ↗
                          </a>
                        ))}
                    </div>
                  </details>
                )}
              </section>
            )}
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
