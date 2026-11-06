import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Upload,
  Download,
  LoaderCircle,
  ChevronRight,
  X,
  CheckCircle2,
} from "lucide-react";
import type { Profile } from "../shared/types";
import { api, downloadFile, words, write } from "./api";
import { EditorHeader } from "./EditorHeader";

type Props = {
  initial: Profile;
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
};
export function ProfileEditor({ initial, busy, perform }: Props) {
  const [profile, setProfile] = useState(initial);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (pending) dialog.current?.showModal();
  }, [pending]);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(profile) !== JSON.stringify(initial);
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setProfile((p) => ({ ...p, [key]: value }));
    setError("");
    if (pending) setReviewed(false);
  };
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (!/\.(pdf|docx)$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
      setError("Choose a PDF or Word (.docx) document smaller than 2 MB.");
      return;
    }
    setImporting(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await api<{ profile: Profile; warnings: string[] }>(
        "/profile/import",
        {
          method: "POST",
          body: JSON.stringify({ name: file.name, data }),
        },
      );
      setProfile(result.profile);
      setWarnings(result.warnings);
      setPending(true);
      setReviewed(false);
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setError((err as Error).message);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  const ready = profile.evidence.some((item) => item.verified);
  const hasInformation = profile.evidence.length > 0;
  const filtered = profile.evidence.filter((item) =>
    `${item.role} ${item.company} ${item.text} ${item.skills.join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section
      className="page form-page profile-library"
      aria-labelledby="profile-title"
    >
      <form
        id="profile-form"
        className="editor-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (!profile.name.trim()) {
            setError("Enter your full name before saving.");
            dialog.current?.close();
            nameInput.current?.focus();
            return;
          }
          if (profile.evidence.some((item) => !item.text.trim())) {
            setError(
              "Each career entry needs details. Update or remove empty entries.",
            );
            dialog.current?.showModal();
            return;
          }
          if (pending && !reviewed) {
            dialog.current?.showModal();
            setError("Review the imported information before saving.");
            return;
          }
          const next = pending
            ? {
                ...profile,
                evidence: profile.evidence.map((item) => ({
                  ...item,
                  verified: true,
                })),
              }
            : profile;
          let saved = next;
          if (
            await perform(async () => {
              try {
                saved = await write<Profile>("/profile", next, "PUT");
                return saved;
              } catch (err) {
                setError((err as Error).message);
                throw err;
              }
            }, "Profile saved.")
          ) {
            setProfile(saved);
            setPending(false);
            setWarnings([]);
            setError("");
            dialog.current?.close();
          } else {
            setError(
              (current) =>
                current || "Your changes could not be saved. Try again.",
            );
          }
        }}
      >
        <EditorHeader
          titleId="profile-title"
          title="My profile"
          dirty={dirty}
          busy={busy || importing}
        />
        <div className="profile-name-row">
          <label className="field">
            <span>Full name</span>
            <input
              ref={nameInput}
              name="name"
              autoComplete="name"
              required
              value={profile.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
        </div>
        <section className="cv-library" aria-labelledby="master-cv-title">
          <div className="cv-library-heading">
            <h2 id="master-cv-title">Master CV</h2>
            <span className={`cv-state${ready && !pending ? " is-ready" : ""}`}>
              {pending || (hasInformation && !ready)
                ? "Review needed"
                : ready
                  ? "Ready to use"
                  : "Upload needed"}
            </span>
          </div>
          <div className="cv-library-document">
            <div className="cv-file-mark" aria-hidden="true">
              <FileText size={30} />
              <span>{profile.source?.kind.toUpperCase() || "CV"}</span>
            </div>
            <div className="cv-file-details">
              <strong title={profile.source?.name}>
                {profile.source?.name || "No original file attached"}
              </strong>
              <span>
                {profile.source
                  ? `Added ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(profile.source.importedAt))}`
                  : "PDF or Word · Up to 2 MB"}
              </span>
            </div>
            <div className="cv-file-actions">
              {profile.source && (
                <button
                  type="button"
                  className="button"
                  disabled={busy || importing}
                  onClick={() =>
                    void perform(() =>
                      downloadFile(
                        `/profile/sources/${profile.source!.id}/${profile.source!.kind}`,
                        profile.source!.name,
                      ),
                    )
                  }
                >
                  <Download size={15} aria-hidden="true" />
                  Download
                </button>
              )}
              <input
                hidden
                ref={fileInput}
                type="file"
                accept=".pdf,.docx"
                aria-label="Upload CV"
                onChange={(e) => void upload(e.target.files?.[0])}
              />
              <button
                type="button"
                className="button primary"
                disabled={busy || importing}
                onClick={() => fileInput.current?.click()}
              >
                {importing ? (
                  <LoaderCircle size={15} className="spin" aria-hidden="true" />
                ) : (
                  <Upload size={15} aria-hidden="true" />
                )}
                {importing
                  ? "Reading CV…"
                  : profile.source
                    ? "Replace CV"
                    : "Upload CV"}
              </button>
            </div>
          </div>
          <div className="cv-library-knowledge">
            <div>
              <span className="cv-knowledge-label">
                {ready ? (
                  <CheckCircle2 size={15} aria-hidden="true" />
                ) : (
                  <FileText size={15} aria-hidden="true" />
                )}
                {pending
                  ? "Check your imported information"
                  : ready
                    ? "Career information available"
                    : hasInformation
                      ? "Review career information"
                      : "No career information yet"}
              </span>
              <p>
                {ready && !pending
                  ? "Used to match opportunities and select relevant experience for each application."
                  : hasInformation
                    ? "Confirm the facts you want available for matching and drafts."
                    : "Upload your CV to create the career information used for matching and drafts."}
              </p>
            </div>
            <button
              type="button"
              className="button"
              disabled={!profile.evidence.length || importing}
              onClick={() => dialog.current?.showModal()}
            >
              Review information
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </section>
        {error && (
          <p className="resume-import-error" role="alert">
            {error}
          </p>
        )}
        {pending && (
          <div className="cv-review-actions">
            <span>
              Review the imported information, then confirm to update your
              profile.
            </span>
            <button
              type="button"
              className="button"
              onClick={() => {
                setProfile(initial);
                setPending(false);
                setReviewed(false);
                setWarnings([]);
                setError("");
                dialog.current?.close();
              }}
            >
              Discard import
            </button>
            <button className="button primary" disabled={busy || !reviewed}>
              Confirm and save
            </button>
          </div>
        )}
      </form>
      <dialog
        ref={dialog}
        className="cv-review-dialog"
        aria-labelledby="cv-review-title"
      >
        <header>
          <div>
            <h2 id="cv-review-title">Extracted information</h2>
            <p>Check the facts used for matching and application drafts.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close review"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </header>
        <div className="cv-review-body">
          {error && (
            <p className="resume-import-error" role="alert">
              {error}
            </p>
          )}
          <label className="field">
            <span>Portfolio / website</span>
            <input
              type="url"
              value={profile.portfolio}
              onChange={(e) => set("portfolio", e.target.value)}
              placeholder="https://"
            />
          </label>
          {warnings.length > 0 && (
            <div className="resume-import-review" role="status">
              <strong>Check these details</strong>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="field cv-review-search">
            <span>Find information</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search experience, projects or education"
            />
          </label>
          {filtered.map((entry, index) => (
            <details className="career-entry" key={entry.id}>
              <summary>
                <ChevronRight size={14} aria-hidden="true" />
                <span>
                  {entry.role || entry.category || "Experience"}
                  {entry.company ? ` · ${entry.company}` : ""}
                </span>
                <small>{entry.period || `Entry ${index + 1}`}</small>
              </summary>
              <div className="form-grid">
                {(
                  [
                    ["role", "Role / qualification"],
                    ["company", "Company / institution"],
                    ["period", "Period"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <input
                      value={entry[key]}
                      onChange={(e) =>
                        set(
                          "evidence",
                          profile.evidence.map((item) =>
                            item.id === entry.id
                              ? { ...item, [key]: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                <label className="field">
                  <span>Related skills</span>
                  <input
                    defaultValue={entry.skills.join(", ")}
                    onChange={(e) =>
                      set(
                        "evidence",
                        profile.evidence.map((item) =>
                          item.id === entry.id
                            ? { ...item, skills: words(e.target.value) }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label className="field wide">
                  <span>Details</span>
                  <textarea
                    required
                    rows={3}
                    value={entry.text}
                    onChange={(e) =>
                      set(
                        "evidence",
                        profile.evidence.map((item) =>
                          item.id === entry.id
                            ? { ...item, text: e.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    set(
                      "evidence",
                      profile.evidence.filter((item) => item.id !== entry.id),
                    )
                  }
                >
                  Remove entry
                </button>
                {!pending && (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={entry.verified}
                      onChange={(e) =>
                        set(
                          "evidence",
                          profile.evidence.map((item) =>
                            item.id === entry.id
                              ? { ...item, verified: e.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    <span>Accurate and available for drafts</span>
                  </label>
                )}
              </div>
            </details>
          ))}
          {!filtered.length && <p>No information matches your search.</p>}
        </div>
        <footer>
          {pending && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>
                I reviewed this information and confirm it is accurate.
              </span>
            </label>
          )}
          <div className="cv-review-footer-actions">
            <button
              type="button"
              className="button"
              onClick={() => dialog.current?.close()}
            >
              Done
            </button>
            <button
              type="submit"
              form="profile-form"
              className="button primary"
              disabled={busy || importing || !dirty || (pending && !reviewed)}
            >
              {pending ? "Confirm and save" : "Save changes"}
            </button>
          </div>
        </footer>
      </dialog>
    </section>
  );
}
