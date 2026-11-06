import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import type { Source, SourceHealth } from "../shared/types";
import {
  addRecommendedSources,
  normalizeSource,
  sourceLibrary,
  additionalJobBoards,
} from "../shared/discovery";
import { safeUrl, uid, write } from "./api";

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
export function SourcesPage({
  initial,
  health = {},
  searching = false,
  perform,
  busy,
}: {
  initial: Source[];
  health?: Record<string, SourceHealth>;
  searching?: boolean;
  perform: Perform;
  busy: boolean;
}) {
  const [sources, setSources] = useState(initial);
  const [query, setQuery] = useState("");
  const [showAdded, setShowAdded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const enabled = sources.filter((s) => s.enabled).length;
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
  const missing = sourceLibrary.filter((r) => !includes(r.source));
  const update = (id: string, patch: Partial<Source>) =>
    setSources((old) => old.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const save = async (next = sources, message = "Sources saved.") => {
    let normalized: Source[] = [];
    const ok = await perform(async () => {
      normalized = next.map(normalizeSource);
      await write("/sources", { sources: normalized }, "PUT");
    }, message);
    if (ok) setSources(normalized);
    return ok;
  };
  const add = async (additions: Source[]) => {
    let next: Source[] = [];
    const ok = await perform(async () => {
      next = addRecommendedSources(sources, additions);
      await write("/sources", { sources: next }, "PUT");
    }, "Sources added.");
    if (ok) setSources(next);
  };
  const discover = async (sourceId?: string) => {
    if (await save())
      await perform(
        () =>
          write("/runs", {
            action: "discover",
            ...(sourceId ? { sourceId } : {}),
          }),
        "Discovery queued. Follow progress in Activity.",
      );
  };
  const library = sourceLibrary.filter(
    (r) =>
      (showAdded || !includes(r.source)) &&
      `${r.source.label} ${r.source.provider} ${r.description} ${r.coverage}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="page source-workspace">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DISCOVERY</div>
          <h1>Sources</h1>
          <p>
            US employers with remote openings. Check location and pay for each
            role.
          </p>
        </div>
        <button
          className="button primary"
          disabled={busy || searching || !enabled}
          onClick={() => void discover()}
        >
          <Search size={16} />
          {searching ? "Searching…" : "Search enabled sources"}
        </button>
      </div>
      <section className="source-section" aria-labelledby="your-sources-title">
        <div className="source-section-heading">
          <div>
            <h2 id="your-sources-title">
              Your sources <span>{enabled} enabled</span>
            </h2>
            <p>Pause sources that produce few relevant leads.</p>
          </div>
          <button
            className="text-button"
            disabled={busy || sources.length >= 50}
            onClick={() => {
              const source: Source = {
                id: uid(),
                label: "",
                provider: "ashby",
                board: "",
                enabled: true,
              };
              setSources((old) => [...old, source]);
              setEditing(source.id);
            }}
          >
            <Plus size={16} />
            Custom source
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {sources.map((source) => {
            const research = researchFor(source),
              result = health[source.id];
            const feed = ["hackernews", "jobicy"].includes(source.provider);
            return (
              <div className="source-managed-row" key={source.id}>
                <div className="source-managed-top">
                  <div className="source-row-copy">
                    <strong>{source.label || "New source"}</strong>
                    <span className="source-provider">
                      {providers[source.provider]}
                    </span>
                    <p
                      className={
                        result?.status === "error" ? "source-error" : undefined
                      }
                    >
                      {result
                        ? result.status === "success"
                          ? `${result.found} listings read · ${result.evaluated} evaluated · ${new Date(result.checkedAt).toLocaleString()}`
                          : `Search failed · ${result.error}`
                        : (research?.coverage ??
                          (feed ? "Research feed" : "Company job board"))}
                    </p>
                  </div>
                  <div className="source-row-actions">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={source.enabled}
                      aria-label={`Enable ${source.label || "new source"}`}
                      className="source-toggle"
                      disabled={busy}
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
                        setEditing(editing === source.id ? null : source.id)
                      }
                    >
                      <Settings2 size={17} />
                    </button>
                    <button
                      type="button"
                      className="source-icon-action"
                      aria-label={`Search ${source.label || "new source"}`}
                      disabled={busy || searching || !source.enabled}
                      onClick={() => void discover(source.id)}
                    >
                      <Search size={17} />
                    </button>
                  </div>
                </div>
                {editing === source.id && (
                  <div className="source-settings">
                    <div className="form-grid">
                      <label className="field">
                        <span>Company or feed name</span>
                        <input
                          required
                          value={source.label}
                          onChange={(e) =>
                            update(source.id, { label: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Provider</span>
                        <select
                          value={source.provider}
                          onChange={(e) =>
                            update(source.id, {
                              provider: e.target.value as Source["provider"],
                              companyCountry: undefined,
                              countrySource: undefined,
                            })
                          }
                        >
                          {Object.entries(providers).map(([value, name]) => (
                            <option key={value} value={value}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field wide">
                        <span>
                          {feed
                            ? "Keyword (optional)"
                            : "Careers URL or board identifier"}
                        </span>
                        <input
                          required={!feed}
                          value={source.board}
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
                            <span>Official country evidence URL</span>
                            <input
                              type="url"
                              value={source.countrySource ?? ""}
                              onChange={(e) =>
                                update(source.id, {
                                  countrySource: e.target.value || undefined,
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                    </div>
                    <div className="source-settings-footer">
                      <button className="button" disabled={busy}>
                        Save sources
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void save(
                            sources.filter((s) => s.id !== source.id),
                            "Source removed.",
                          )
                        }
                      >
                        <Trash2 size={14} />
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!sources.length && (
            <div className="source-empty">
              Add the researched sources below to start finding roles.
            </div>
          )}
        </form>
      </section>
      <section
        className="source-section source-library"
        aria-labelledby="source-library-title"
      >
        <div className="source-section-heading">
          <div>
            <h2 id="source-library-title">Researched sources</h2>
            <p>
              Direct employer boards and a broad remote feed. Board checks dated
              6 Nov 2026.
            </p>
          </div>
          <button
            className="button"
            disabled={busy || !missing.length}
            onClick={() => void add(missing.map((r) => r.source))}
          >
            {missing.length
              ? `Add researched sources (${missing.length})`
              : "All sources added"}
          </button>
        </div>
        <div className="source-library-toolbar">
          <label className="source-library-search">
            <Search size={16} />
            <input
              aria-label="Find a source"
              placeholder="Find by company, profession or provider"
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
        {library.map((research) => (
          <div className="source-library-row" key={research.source.id}>
            <div className="source-row-copy">
              <strong>{research.source.label}</strong>
              <span className="source-provider">
                {providers[research.source.provider]}
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
                disabled={busy || includes(research.source)}
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
              ? "All researched sources are added. Search your enabled sources above."
              : "No matching source. Try a profession or add a custom company board."}
          </p>
        )}
        <details className="source-method">
          <summary>
            How sources are selected <ChevronDown size={14} />
          </summary>
          <p>
            Working public boards, an official company-country reference, and
            remote openings across professions. A board check confirms access,
            not hiring eligibility or salary. Jobicy covers recent listings and
            refreshes at most hourly; its employers need a separate country
            check. Use application and interview results to decide which sources
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
      </section>
      <section
        className="source-section source-manual"
        aria-labelledby="additional-boards-title"
      >
        <div className="source-section-heading">
          <div>
            <h2 id="additional-boards-title">More places to look</h2>
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
    </section>
  );
}
