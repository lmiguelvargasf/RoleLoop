import { useRef, useState } from "react";
import { FileText, Upload, Download, Check, LoaderCircle } from "lucide-react";
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
          description="One career profile. A résumé for every next move."
          dirty={dirty}
          busy={busy || importing}
        />
        <section className="resume-source-panel" aria-label="Master résumé">
          <div className="resume-source-symbol">
            <FileText size={28} />
          </div>
          <div className="resume-source-copy">
            <span className="eyebrow">YOUR MASTER RÉSUMÉ</span>
            <h2>
              {pending
                ? "Your profile is ready to review"
                : profile.source?.name || "Start with your experience"}
            </h2>
            <p>
              {pending
                ? "Check the overview and career details below. Saving confirms these facts for matching and drafts."
                : profile.source
                  ? "Your original stays private. Upload an updated CV whenever your experience changes."
                  : "Upload your complete CV. We’ll organize the details and use them to tailor your applications."}
            </p>
            <small>
              {profile.source
                ? `Imported ${new Date(profile.source.importedAt).toLocaleDateString()} · `
                : ""}
              PDF or Word · up to 2 MB · readable text
            </small>
          </div>
          <div className="resume-source-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx"
              hidden
              aria-label="Upload résumé"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <button
              className="button primary"
              type="button"
              disabled={busy || importing}
              onClick={() => fileInput.current?.click()}
            >
              {importing ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Upload size={16} />
              )}
              {importing
                ? "Reading your CV…"
                : profile.source
                  ? "Replace CV"
                  : "Upload CV"}
            </button>
            {profile.source && (
              <button
                className="button"
                type="button"
                onClick={() =>
                  void perform(() =>
                    downloadFile(
                      `/profile/sources/${profile.source!.id}/${profile.source!.kind}`,
                      profile.source!.name,
                    ),
                  )
                }
              >
                <Download size={15} /> Original
              </button>
            )}
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
            <h2>Professional overview</h2>
            <p>Your introduction and contact details.</p>
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
              <span>About you</span>
              <textarea
                rows={3}
                value={profile.summary}
                onChange={(e) => set("summary", e.target.value)}
              />
            </label>
            <label className="field wide">
              <span>
                Currently learning <small>Optional</small>
              </span>
              <input
                value={profile.learning}
                onChange={(e) => set("learning", e.target.value)}
                placeholder="For example: learning Vue through a personal project"
              />
              <small>
                Used to discuss learning gaps. These skills are labelled as
                learning in your drafts.
              </small>
            </label>
          </div>
        </section>
        <details
          className="form-section career-details"
          open={pending || undefined}
        >
          <summary>
            <span>Career details</span>
            <small>
              {profile.evidence.length}{" "}
              {profile.evidence.length === 1 ? "entry" : "entries"} ·{" "}
              {profile.skills.length} skills
            </small>
          </summary>
          <p className="career-details-intro">
            The facts behind your matches and drafts. Expand an entry to make a
            correction.
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
