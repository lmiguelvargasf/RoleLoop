import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Upload,
  Download,
  LoaderCircle,
  Eye,
  X,
  CheckCircle2,
  RotateCcw,
  AlertCircle,
  ArrowUpRight,
} from "lucide-react";
import { careerFacts, type Profile } from "../shared/types";
import { resumeProcessingActive } from "../shared/resume-processing";
import { api, downloadFile, fileBlob, safeUrl } from "./api";
import { ResumeFacts } from "./ResumeFacts";
import "./resume.css";

type Props = {
  initial: Profile;
  busy: boolean;
  perform: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
};
export function ResumePage({ initial: profile, busy, perform }: Props) {
  const [confirmClear, setConfirmClear] = useState<{
    sourceId: string | null;
    cacheId: string | null;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    url: string;
    kind: "pdf" | "docx";
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (preview) dialog.current?.showModal();
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);
  const facts = careerFacts(profile);
  const ready = Boolean(facts);
  const activeExtraction = resumeProcessingActive(profile.cache);
  const interrupted =
    profile.cache?.status === "processing" && !activeExtraction;
  const processing = importing || activeExtraction;
  const failed = profile.cache?.status === "failed" || interrupted;
  const failureMessage = interrupted
    ? "Processing was interrupted or exceeded its time limit. Your original resume is saved. Retry extraction to continue."
    : profile.cache?.error === "The operation was aborted due to timeout"
      ? "The AI service took too long to respond. Your original resume is saved. Retry extraction; you don’t need to upload it again."
      : profile.cache?.error;
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
    setConfirmClear(null);
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
        if (!mounted.current)
          throw new DOMException("The active workspace changed.", "AbortError");
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
  const uploadButton = (label: string) => (
    <button
      type="button"
      className="button primary"
      disabled={busy || importing}
      onClick={() => fileInput.current?.click()}
    >
      {importing ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : (
        <Upload size={16} aria-hidden="true" />
      )}
      {importing ? "Reading resume…" : label}
    </button>
  );
  const processButton = source && !ready && !processing && (
    <button
      type="button"
      className="button primary"
      disabled={busy}
      onClick={() =>
        void perform(() =>
          api("/profile/process", { method: "POST", body: "{}" }),
        )
      }
    >
      <RotateCcw size={15} aria-hidden="true" />
      {failed ? "Retry extraction" : "Extract career details"}
    </button>
  );
  const portfolio = facts?.portfolio && safeUrl(facts.portfolio);
  return (
    <section className="page resume-page" aria-labelledby="resume-title">
      <header className="page-heading">
        <div>
          <h1 id="resume-title">Resume</h1>
          <p>Review the facts used for role matching and application drafts.</p>
        </div>
        <span
          className={`resume-status${ready && !importing ? " is-ready" : ""}`}
          role="status"
        >
          {processing ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : ready ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : failed ? (
            <AlertCircle size={14} aria-hidden="true" />
          ) : null}
          {processing
            ? "Extracting details"
            : ready
              ? "Ready for matching"
              : failed
                ? "Extraction didn’t finish"
                : source
                  ? "No extracted details"
                  : "No resume yet"}
        </span>
      </header>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".pdf,.docx"
        aria-label="Upload resume"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      {source && (
        <section className="resume-document" aria-label="Source resume">
          <FileText size={24} strokeWidth={1.5} aria-hidden="true" />
          <div className="resume-document-info">
            <span className="resume-field-label">Source resume</span>
            <strong title={source.name}>{source.name}</strong>
            <span>
              {source.kind.toUpperCase()} <span aria-hidden="true">·</span>{" "}
              Uploaded{" "}
              {new Intl.DateTimeFormat(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              }).format(new Date(source.importedAt))}
            </span>
          </div>
          <div className="resume-document-actions">
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
              className="icon-button"
              title="Download original"
              aria-label="Download original resume"
              disabled={busy}
              onClick={() =>
                void perform(() => downloadFile(sourcePath, source.name))
              }
            >
              <Download size={17} />
            </button>
            {uploadButton("Replace resume")}
          </div>
        </section>
      )}
      {error && (
        <p className="resume-import-error" role="alert">
          {error}
        </p>
      )}
      {ready && !importing && facts ? (
        <>
          {!!profile.cache?.warnings.length && (
            <details className="resume-notes">
              <summary>
                <AlertCircle size={15} aria-hidden="true" />
                {profile.cache.warnings.length} extraction{" "}
                {profile.cache.warnings.length === 1 ? "note" : "notes"}
              </summary>
              <ul>
                {profile.cache.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <ResumeFacts key={profile.cache!.id} facts={facts} />
          <footer className="resume-footer">
            <p>To correct a fact, update your resume and replace the source.</p>
            {portfolio && (
              <a
                className="text-link"
                href={portfolio}
                target="_blank"
                rel="noreferrer"
              >
                Portfolio
                <ArrowUpRight size={14} />
              </a>
            )}
          </footer>
        </>
      ) : (
        <div
          className={`resume-empty${dragging ? " is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!busy && !importing) void upload(event.dataTransfer.files[0]);
          }}
          aria-busy={processing}
        >
          <div className="resume-empty-mark" aria-hidden="true">
            {processing ? (
              <LoaderCircle size={32} className="spin" strokeWidth={1.3} />
            ) : (
              <FileText size={32} strokeWidth={1.3} />
            )}
          </div>
          <h2>
            {processing
              ? "Reading your resume"
              : failed
                ? "Extraction didn’t finish"
                : source
                  ? "Ready for a fresh extraction"
                  : "Add your resume"}
          </h2>
          <p>
            {processing
              ? "Organizing your career details and checking each statement against the original. This can take a few minutes."
              : failed
                ? failureMessage
                : source
                  ? "Your original is saved. Extract its details again, or replace it with an updated resume."
                  : "Your experience, skills and qualifications, organized with the source behind every detail."}
          </p>
          <div className="button-row">
            {source ? processButton : uploadButton("Upload resume")}
          </div>
          {!source && (
            <span className="resume-upload-hint">
              or drop a file here · PDF or Word · up to 2 MB
            </span>
          )}
          {processing && (
            <span className="resume-upload-hint">
              Your resume is saved. You can leave this page while extraction
              finishes.
            </span>
          )}
        </div>
      )}
      {!ready && !processing && (
        <div className="resume-outline" aria-label="What your resume provides">
          <div>
            <h3>Experience</h3>
            <p>Roles and projects, with their original achievements.</p>
          </div>
          <div>
            <h3>Skills</h3>
            <p>Connected to evidence, with listed skills kept distinct.</p>
          </div>
          <div>
            <h3>Qualifications</h3>
            <p>Education, certifications and languages.</p>
          </div>
        </div>
      )}
      {profile.cache && !importing && (
        <div className="resume-reset">
          {confirmClear ? (
            <div
              className="resume-reset-confirm"
              role="group"
              aria-label="Confirm clearing extracted details"
            >
              <p>
                Clear the extracted details? Your original resume and existing
                drafts stay saved. New drafts will need a fresh extraction.
              </p>
              <div className="button-row">
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmClear(null)}
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api("/profile/cache", {
                        method: "DELETE",
                        body: JSON.stringify(confirmClear),
                      });
                      setConfirmClear(null);
                    }, "Extracted details cleared.")
                  }
                >
                  Clear extracted details
                </button>
              </div>
            </div>
          ) : (
            <button
              className="text-link"
              type="button"
              disabled={busy}
              onClick={() =>
                setConfirmClear({
                  sourceId: profile.source?.id ?? null,
                  cacheId: profile.cache?.id ?? null,
                })
              }
            >
              Clear extracted details
            </button>
          )}
        </div>
      )}
      <dialog
        ref={dialog}
        className="cv-preview-dialog"
        aria-labelledby="cv-preview-title"
        onClose={() => setPreview(null)}
      >
        <header>
          <h2 id="cv-preview-title">Resume preview</h2>
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
            aria-label="Original resume preview"
          >
            <p>Use Download to open this resume.</p>
          </object>
        ) : (
          preview && (
            <iframe
              src={preview.url}
              title="Original resume preview"
              sandbox=""
            />
          )
        )}
      </dialog>
    </section>
  );
}
