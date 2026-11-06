import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Upload,
  Download,
  LoaderCircle,
  Eye,
  X,
  CheckCircle2,
} from "lucide-react";
import { careerFacts, type Profile } from "../shared/types";
import { api, downloadFile, fileBlob } from "./api";

type Props = {
  initial: Profile;
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
};
export function ProfileEditor({ initial: profile, busy, perform }: Props) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    url: string;
    kind: "pdf" | "docx";
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (preview) dialog.current?.showModal();
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);
  const ready = Boolean(careerFacts(profile));
  const processing = importing || profile.cache?.status === "processing";
  const failed = profile.cache?.status === "failed";
  const source = profile.source;
  const sourcePath = source
    ? `/profile/sources/${source.id}/${source.kind}`
    : "";
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (
      !/\.(pdf|docx)$/i.test(file.name) ||
      !file.size ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Choose a PDF or Word (.docx) document smaller than 2 MB.");
      return;
    }
    dialog.current?.close();
    setImporting(true);
    try {
      await perform(async () => {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () =>
            reject(new Error("The CV could not be read. Try again."));
          reader.readAsDataURL(file);
        });
        return api("/profile/import", {
          method: "POST",
          body: JSON.stringify({ name: file.name, data }),
        });
      });
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  return (
    <section
      className="page form-page profile-library"
      aria-labelledby="profile-title"
    >
      <div className="page-heading">
        <div>
          <h1 id="profile-title">My profile</h1>
          <p>
            Your master CV supplies the facts for matching and every
            application.
          </p>
        </div>
      </div>
      <section className="cv-library" aria-labelledby="master-cv-title">
        <div className="cv-library-heading">
          <h2 id="master-cv-title">Master CV</h2>
          <span
            className={`cv-state${ready && !importing ? " is-ready" : ""}`}
            role="status"
          >
            {processing
              ? "Processing CV…"
              : ready
                ? "Ready to use"
                : failed
                  ? "Processing failed"
                  : source
                    ? "Processing needed"
                    : "Upload needed"}
          </span>
        </div>
        <div className="cv-library-document">
          <div className="cv-file-mark" aria-hidden="true">
            <FileText size={30} />
            <span>{source?.kind.toUpperCase() || "CV"}</span>
          </div>
          <div className="cv-file-details">
            <strong title={source?.name}>
              {source?.name || "No CV uploaded"}
            </strong>
            <span>
              {source
                ? `Added ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(source.importedAt))}`
                : "PDF or Word · Up to 2 MB"}
            </span>
          </div>
          <div className="cv-file-actions">
            {source && (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const blob = await fileBlob(`${sourcePath}?preview=1`);
                      setPreview({
                        url: URL.createObjectURL(blob),
                        kind: source.kind,
                      });
                    })
                  }
                >
                  <Eye size={15} aria-hidden="true" />
                  Preview
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(() => downloadFile(sourcePath, source.name))
                  }
                >
                  <Download size={15} aria-hidden="true" />
                  Download
                </button>
              </>
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
              {importing ? "Processing…" : source ? "Replace CV" : "Upload CV"}
            </button>
          </div>
        </div>
        <div className="cv-library-knowledge" aria-live="polite">
          <div>
            <span className="cv-knowledge-label">
              {processing ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : ready ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <FileText size={15} aria-hidden="true" />
              )}
              {processing
                ? "Reading career facts from your CV"
                : ready
                  ? "Career facts ready"
                  : failed
                    ? "Career facts unavailable"
                    : "Upload once, reuse for every application"}
            </span>
            <p>
              {processing
                ? "Matching and new drafts will use this CV when processing finishes."
                : ready
                  ? "Facts are reused for matching. Each application selects experience for its role and company. To change a fact, update and replace your CV."
                  : profile.cache?.error ||
                    (source
                      ? "Process this CV to prepare its career facts for matching and drafts."
                      : "Your original stays private to this workspace. Applications use your account email.")}
            </p>
            {ready && Boolean(profile.cache?.warnings.length) && (
              <details className="cv-processing-notes">
                <summary>Processing notes</summary>
                <ul>
                  {profile.cache!.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {source && !ready && !importing && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  api("/profile/process", { method: "POST", body: "{}" }),
                )
              }
            >
              {failed || processing ? "Retry processing" : "Process CV"}
            </button>
          )}
        </div>
      </section>
      {error && (
        <p className="resume-import-error" role="alert">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        className="cv-preview-dialog"
        aria-labelledby="cv-preview-title"
        onClose={() => setPreview(null)}
      >
        <header>
          <h2 id="cv-preview-title">CV preview</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close preview"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </header>
        {preview?.kind === "pdf" ? (
          <object
            data={preview.url}
            type="application/pdf"
            aria-label="Master CV preview"
          >
            <p>Use Download to open this CV.</p>
          </object>
        ) : (
          preview && (
            <iframe src={preview.url} title="Master CV preview" sandbox="" />
          )
        )}
      </dialog>
    </section>
  );
}
