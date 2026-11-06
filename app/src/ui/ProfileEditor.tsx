import { useRef, useState } from "react";
import {
  FileText,
  Upload,
  Download,
  Check,
  LoaderCircle,
  ChevronRight,
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
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(profile) !== JSON.stringify(initial);
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({ ...p, [key]: value }));
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
  return (
    <section
      className="page form-page editor-page profile-page"
      aria-labelledby="profile-title"
    >
      <form
        className="editor-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending && !reviewed) {
            setError(
              "Review your imported details and confirm them before saving.",
            );
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
          const saved = await perform(
            () => write("/profile", next, "PUT"),
            "Profile saved. Opportunities will use your updated experience.",
          );
          if (saved) {
            setProfile(next);
            setPending(false);
            setWarnings([]);
            setError("");
          }
        }}
      >
        <EditorHeader
          titleId="profile-title"
          title="My profile"
          dirty={dirty}
          busy={busy || importing}
        />
        <section
          className="form-section profile-source"
          aria-labelledby="resume-source-title"
        >
          <div className="form-section-heading">
            <h2 id="resume-source-title">Master résumé</h2>
            <p>Upload a CV to update your career details.</p>
          </div>
          <div className="resume-document" aria-busy={importing}>
            <FileText
              size={22}
              className="resume-document-icon"
              aria-hidden="true"
            />
            <div className="resume-document-copy">
              <span
                className="resume-document-name"
                title={profile.source?.name}
              >
                {profile.source?.name || "No CV attached"}
              </span>
              <span className="resume-document-meta" role="status">
                {importing
                  ? "Reading CV…"
                  : pending
                    ? "Review required before saving"
                    : profile.source
                      ? `Imported ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(profile.source.importedAt))}`
                      : "PDF or Word · Up to 2 MB"}
              </span>
            </div>
            <div className="resume-document-actions">
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.docx"
                hidden
                aria-label="Upload résumé"
                onChange={(e) => void upload(e.target.files?.[0])}
              />
              {profile.source && (
                <button
                  className="button"
                  type="button"
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
              <button
                className="button"
                type="button"
                disabled={busy || importing}
                onClick={() => fileInput.current?.click()}
              >
                {importing ? (
                  <LoaderCircle size={15} className="spin" aria-hidden="true" />
                ) : (
                  <Upload size={15} aria-hidden="true" />
                )}
                {importing
                  ? "Reading…"
                  : profile.source
                    ? "Replace CV"
                    : "Upload CV"}
              </button>
            </div>
          </div>
        </section>
        {error && (
          <p className="resume-import-error" role="alert">
            {error}
          </p>
        )}
        {pending && (
          <aside className="resume-import-review" aria-label="Import review">
            <strong>Review before using this profile</strong>
            <p>
              Importing replaces the saved career details when you save. Check
              names, dates, achievements and anything flagged below.
            </p>
            {warnings.length > 0 && (
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>
                I reviewed the imported details and confirm they are accurate.
              </span>
            </label>
            <button
              className="button"
              type="button"
              onClick={() => {
                setProfile(initial);
                setPending(false);
                setWarnings([]);
                setError("");
              }}
            >
              Discard import
            </button>
          </aside>
        )}
        <section className="form-section">
          <div className="form-section-heading">
            <h2>Personal details</h2>
            <p>Shown on your application documents.</p>
          </div>
          <div className="form-grid">
            {(
              [
                ["name", "Full name"],
                ["headline", "Professional headline"],
                ["email", "Email"],
                ["portfolio", "Portfolio / website"],
              ] as const
            ).map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  name={key}
                  autoComplete={
                    key === "name"
                      ? "name"
                      : key === "email"
                        ? "email"
                        : key === "portfolio"
                          ? "url"
                          : "organization-title"
                  }
                  spellCheck={key !== "email" && key !== "portfolio"}
                  required={key === "name"}
                  type={
                    key === "email"
                      ? "email"
                      : key === "portfolio"
                        ? "url"
                        : "text"
                  }
                  value={profile[key]}
                  onChange={(e) => set(key, e.target.value)}
                />
              </label>
            ))}
            <label className="field wide">
              <span>Summary</span>
              <textarea
                rows={4}
                name="summary"
                value={profile.summary}
                onChange={(e) => set("summary", e.target.value)}
              />
            </label>
            <label className="field wide">
              <span>
                Currently learning <small>Optional</small>
              </span>
              <input
                name="learning"
                value={profile.learning}
                onChange={(e) => set("learning", e.target.value)}
                placeholder="e.g. Vue through a personal project"
              />
              <small>Listed as learning in generated résumés.</small>
            </label>
          </div>
        </section>
        <details
          className="form-section career-details"
          open={pending || undefined}
        >
          <summary>
            <ChevronRight size={16} aria-hidden="true" />
            <span>Career details</span>
            <small>
              {profile.evidence.length}{" "}
              {profile.evidence.length === 1 ? "entry" : "entries"} ·{" "}
              {profile.skills.length} skills
            </small>
          </summary>
          <div className="career-details-content">
            <p className="career-details-intro">
              The facts behind your matches and drafts. Expand an entry to make
              a correction.
            </p>
            <label className="field">
              <span>Skills from your CV</span>
              <input
                value={profile.skills.join(", ")}
                onChange={(e) => set("skills", words(e.target.value))}
              />
            </label>
            {profile.evidence.map((entry, index) => (
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
            {!profile.evidence.length && (
              <p>Upload a CV to fill in your career history.</p>
            )}
          </div>
        </details>
        {dirty && (
          <div className="resume-save-footer">
            <button
              className="button primary"
              disabled={busy || importing || (pending && !reviewed)}
            >
              <Check size={16} />
              {pending ? "Confirm and save profile" : "Save changes"}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
