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
type Confirmation =
  | { kind: "replace"; file: File }
  | { kind: "clear"; sourceId: string | null; cacheId: string | null };

export function ResumePage({ initial: profile, busy, perform }: Props) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<{
    kind: "upload" | "retry";
    sourceId: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    url: string;
    kind: "pdf" | "docx";
  } | null>(null);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const restorePreviewFocus = useRef(false);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const processingHeading = useRef<HTMLHeadingElement>(null);
  const hadPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (preview) previewDialog.current?.showModal();
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);
  useEffect(() => {
    if (confirmation) confirmDialog.current?.showModal();
  }, [confirmation]);

  const source = profile.source;
  const facts = careerFacts(profile);
  const ready = Boolean(facts?.evidence.length || facts?.sections.length);
  const activeExtraction = resumeProcessingActive(profile.cache);
  const uploading =
    pending?.kind === "upload" && (source?.id ?? null) === pending.sourceId;
  const starting = pending?.kind === "retry" && !activeExtraction && !ready;
  const processing = uploading || starting || activeExtraction;
  const interrupted =
    profile.cache?.status === "processing" && !activeExtraction;
  const failed = profile.cache?.status === "failed" || interrupted;
  const noDetails = Boolean(facts && !ready);
  const warnings = profile.cache?.warnings ?? [];
  const failureMessage = interrupted
    ? "Processing was interrupted or took too long. Try again using your saved resume."
    : profile.cache?.error === "The operation was aborted due to timeout"
      ? "Processing took too long. Try again using your saved resume."
      : profile.cache?.error ||
        "We couldn’t read the details in your resume. Try again, or replace it with a readable document.";
  const sourcePath = source
    ? `/profile/sources/${source.id}/${source.kind}`
    : "";
  const locked = busy || Boolean(pending);
  const portfolio = facts?.portfolio && safeUrl(facts.portfolio);

  useEffect(() => {
    if (!preview && !locked && restorePreviewFocus.current) {
      previewTrigger.current?.focus();
      restorePreviewFocus.current = false;
    }
  }, [preview, locked]);

  useEffect(() => {
    if (pending && !hadPending.current) processingHeading.current?.focus();
    if (
      !pending &&
      hadPending.current &&
      document.activeElement === document.body
    )
      heading.current?.focus();
    hadPending.current = Boolean(pending);
  }, [pending]);

  useEffect(() => {
    if (!uploading) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [uploading]);

  async function run(
    task: () => Promise<unknown>,
    nextAction: string,
    success?: string,
  ) {
    setError("");
    return perform(async () => {
      try {
        return await task();
      } catch (cause) {
        if (
          mounted.current &&
          !(cause instanceof DOMException && cause.name === "AbortError")
        ) {
          const message =
            cause instanceof Error
              ? cause.message
              : "The request didn’t finish.";
          setError(`${message} ${nextAction}`);
        }
        throw cause;
      }
    }, success);
  }
  function choose(file?: File) {
    if (!file || locked) return;
    setError("");
    if (!/\.(pdf|docx)$/i.test(file.name)) {
      setError(
        "This file type isn’t supported. Choose a PDF or Word (.docx) document.",
      );
    } else if (!file.size) {
      setError("This file is empty. Choose a resume that contains text.");
    } else if (file.size > 2 * 1024 * 1024) {
      setError(
        "This file is larger than 2 MB. Choose a smaller PDF or Word document.",
      );
    } else if (source) {
      setConfirmation({ kind: "replace", file });
    } else {
      void upload(file);
    }
  }
  async function upload(file: File) {
    confirmDialog.current?.close();
    setConfirmation(null);
    setPending({ kind: "upload", sourceId: source?.id ?? null });
    try {
      await run(async () => {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () =>
            reject(new Error("The resume could not be read."));
          reader.readAsDataURL(file);
        });
        if (!mounted.current)
          throw new DOMException("The active workspace changed.", "AbortError");
        return api("/profile/import", {
          method: "POST",
          body: JSON.stringify({ name: file.name, data }),
        });
      }, "Try uploading your resume again.");
    } finally {
      if (mounted.current) setPending(null);
    }
  }
  async function extract() {
    setPending({ kind: "retry", sourceId: source?.id ?? null });
    try {
      await run(
        () => api("/profile/process", { method: "POST", body: "{}" }),
        "Try again when you’re ready.",
      );
    } finally {
      if (mounted.current) setPending(null);
    }
  }
  const uploadButton = (label: string, primary = true) => (
    <button
      type="button"
      className={`button${primary ? " primary" : ""}`}
      disabled={locked}
      onClick={() => fileInput.current?.click()}
    >
      <Upload size={16} aria-hidden="true" />
      {label}
    </button>
  );
  const status = uploading
    ? "Uploading resume…"
    : processing
      ? "Processing resume…"
      : ready
        ? warnings.length
          ? "Some details need review"
          : "Resume ready"
        : failed
          ? "Couldn’t process resume"
          : source
            ? "No resume details yet"
            : "No resume yet";
  return (
    <section
      className="page form-page editor-page resume-page"
      aria-labelledby="resume-title"
    >
      <header className="editor-header">
        <div className="editor-heading">
          <h1 id="resume-title" ref={heading} tabIndex={-1}>
            Resume
          </h1>
          <p>
            Your experience, skills, and qualifications, organized for job matching.
          </p>
        </div>
        <span
          className={`editor-save-state resume-status${ready && !processing && !warnings.length ? " is-ready" : ""}`}
          role="status"
          aria-atomic="true"
        >
          {processing ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : failed || (ready && warnings.length) ? (
            <AlertCircle size={15} aria-hidden="true" />
          ) : ready ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : null}
          {status}
        </span>
      </header>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".pdf,.docx"
        aria-label="Upload resume"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          choose(file);
        }}
      />
      {source && (
        <section
          className="form-section resume-source-section"
          aria-labelledby="resume-source-title"
        >
          <div className="form-section-heading">
            <h2 id="resume-source-title">Original resume</h2>
            <p>The source for your experience, skills and qualifications.</p>
          </div>
          <div className="resume-document">
            <FileText size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="resume-document-info">
              <strong>{source.name}</strong>
              <span>
                {source.kind.toUpperCase()} <span aria-hidden="true">·</span>{" "}
                Uploaded{" "}
                {Number.isFinite(Date.parse(source.importedAt))
                  ? new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    }).format(new Date(source.importedAt))
                  : "date unavailable"}
              </span>
            </div>
            <div className="resume-document-actions">
              <button
                ref={previewTrigger}
                type="button"
                className="button"
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    const blob = await fileBlob(`${sourcePath}?preview=1`);
                    if (mounted.current)
                      setPreview({
                        url: URL.createObjectURL(blob),
                        kind: source.kind,
                      });
                  }, "Try Preview again, or download the original.")
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
                disabled={locked}
                onClick={() =>
                  void run(
                    () => downloadFile(sourcePath, source.name),
                    "Try downloading the original again.",
                  )
                }
              >
                <Download size={18} aria-hidden="true" />
              </button>
              {uploadButton("Replace resume", false)}
            </div>
          </div>
        </section>
      )}
      {error && !confirmation && (
        <p className="resume-import-error" role="alert">
          <AlertCircle size={17} aria-hidden="true" />
          {error}
        </p>
      )}
      {ready && !processing && facts ? (
        <>
          {!!warnings.length && (
            <aside
              className="resume-review-notice"
              aria-label="Some details need review"
            >
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>Some details may be missing</strong>
                <p>
                  Check the details below against your original resume before
                  relying on a match.
                </p>
                <details className="resume-notes">
                  <summary>
                    View {warnings.length}{" "}
                    {warnings.length === 1 ? "note" : "notes"}
                  </summary>
                  <ul>
                    {warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </details>
              </div>
            </aside>
          )}
          {!warnings.length && (
            <p className="resume-ready-note">
              Your resume is ready for job matching. Check the details below for
              accuracy.
            </p>
          )}
          <ResumeFacts key={profile.cache!.id} facts={facts} />
          <footer className="resume-footer">
            <p>
              Something missing or incorrect? Update your resume, then choose
              Replace resume.
            </p>
            {portfolio && (
              <a
                className="text-link"
                href={portfolio}
                target="_blank"
                rel="noreferrer"
              >
                Portfolio<span className="sr-only"> (opens in a new tab)</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            )}
          </footer>
        </>
      ) : (
        <div
          className={`resume-empty${dragging ? " is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!locked && !processing) setDragging(true);
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
            if (locked || processing) return;
            if (event.dataTransfer.files.length > 1)
              setError("Choose one resume at a time.");
            else choose(event.dataTransfer.files[0]);
          }}
        >
          <div className="resume-empty-mark" aria-hidden="true">
            {processing ? (
              <LoaderCircle size={30} className="spin" strokeWidth={1.5} />
            ) : (
              <FileText size={30} strokeWidth={1.5} />
            )}
          </div>
          <h2 ref={processingHeading} tabIndex={-1}>
            {uploading
              ? "Uploading your resume"
              : processing
                ? "Processing your resume"
                : failed
                  ? "Couldn’t process resume"
                  : noDetails
                    ? "No resume details found"
                    : source
                      ? "Ready to process your resume"
                      : "Add your resume"}
          </h2>
          <p>
            {uploading
              ? "Uploading and checking your document. Keep this page open until your resume is saved."
              : processing
                ? "We’re reading your resume and organizing your details. This may take a few minutes."
                : failed
                  ? failureMessage
                  : noDetails
                    ? "Your resume is saved, but no usable details were found. Replace it with a document that has selectable text."
                    : source
                      ? "Your original resume is saved. Process it again, or replace it with an updated resume."
                      : "Upload your resume to organize your experience, skills, and qualifications for job matching."}
          </p>
          <div className="button-row">
            {!processing &&
              (source
                ? !noDetails && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={locked}
                      onClick={() => void extract()}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                      {failed ? "Try again" : "Process resume"}
                    </button>
                  )
                : uploadButton("Upload resume"))}
          </div>
          {!source && !processing && (
            <span className="resume-upload-hint">
              or drop one file here · PDF or Word (.docx) · up to 2 MB
            </span>
          )}
          {activeExtraction && !uploading && (
            <span className="resume-upload-hint">
              Your original resume is saved. You can leave this page while
              processing finishes.
            </span>
          )}
          {failed && !processing && (
            <span className="resume-upload-hint">
              Your original resume is saved. You don’t need to upload it again.
            </span>
          )}
        </div>
      )}
      {!ready && !processing && !source && (
        <div className="resume-outline" aria-label="What your resume provides">
          <div>
            <h3>Experience</h3>
            <p>Roles and projects, with details you can inspect.</p>
          </div>
          <div>
            <h3>Skills</h3>
            <p>See demonstrated skills separately from listed skills.</p>
          </div>
          <div>
            <h3>Qualifications</h3>
            <p>Education, certifications and languages in one place.</p>
          </div>
        </div>
      )}
      {profile.cache && !processing && (
        <div className="resume-reset">
          <button
            className="text-link"
            type="button"
            disabled={locked}
            onClick={() => {
              setError("");
              setConfirmation({
                kind: "clear",
                sourceId: source?.id ?? null,
                cacheId: profile.cache?.id ?? null,
              });
            }}
          >
            Clear extracted details
          </button>
          <span>Keeps your original resume and saved drafts.</span>
        </div>
      )}
      <dialog
        ref={confirmDialog}
        className="resume-confirm-dialog"
        aria-labelledby="resume-confirm-title"
        aria-describedby="resume-confirm-description"
        onCancel={(event) => {
          if (locked) event.preventDefault();
        }}
        onClose={(event) => {
          // A queued close event must not clear a confirmation opened since then.
          if (!event.currentTarget.open) setConfirmation(null);
        }}
      >
        {confirmation && (
          <>
            <h2 id="resume-confirm-title">
              {confirmation.kind === "replace"
                ? "Replace your resume?"
                : "Clear extracted details?"}
            </h2>
            <div id="resume-confirm-description">
              {confirmation.kind === "replace" ? (
                <>
                  <p className="resume-selected-file">
                    <FileText size={18} aria-hidden="true" />
                    {confirmation.file.name}
                  </p>
                  <p>
                    This becomes your active resume. Its details will replace
                    the current extraction for future matches and drafts.
                  </p>
                  <p>
                    Previous uploads, saved drafts and preferences stay saved.
                    Existing drafts must be regenerated before approval.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    This removes the experience, skills and qualifications used
                    for matching and new drafts.
                  </p>
                  <p>
                    Your original resume, saved drafts and preferences stay
                    saved. To approve drafts, extract the details again and
                    regenerate the drafts.
                  </p>
                </>
              )}
            </div>
            {error && (
              <p className="resume-import-error" role="alert">
                {error}
              </p>
            )}
            <div className="button-row">
              <button
                type="button"
                className="button"
                autoFocus
                disabled={locked}
                onClick={() => confirmDialog.current?.close()}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`button ${confirmation.kind === "clear" ? "danger" : "primary"}`}
                disabled={locked}
                onClick={() => {
                  if (confirmation.kind === "replace")
                    void upload(confirmation.file);
                  else
                    void run(
                      () =>
                        api("/profile/cache", {
                          method: "DELETE",
                          body: JSON.stringify({
                            sourceId: confirmation.sourceId,
                            cacheId: confirmation.cacheId,
                          }),
                        }),
                      "Try clearing the details again.",
                      "Extracted details cleared. Your original resume is still saved.",
                    ).then((success) => {
                      if (success) {
                        confirmDialog.current?.close();
                        heading.current?.focus();
                      }
                    });
                }}
              >
                {locked
                  ? "Clearing…"
                  : confirmation.kind === "replace"
                    ? "Replace and extract"
                    : "Clear extracted details"}
              </button>
            </div>
          </>
        )}
      </dialog>
      <dialog
        ref={previewDialog}
        className="cv-preview-dialog"
        aria-labelledby="cv-preview-title"
        onClose={(event) => {
          if (!event.currentTarget.open) {
            restorePreviewFocus.current = true;
            setPreview(null);
          }
        }}
      >
        <header>
          <h2 id="cv-preview-title">Original resume</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close preview"
            onClick={() => previewDialog.current?.close()}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {preview?.kind === "pdf" ? (
          <object
            data={preview.url}
            type="application/pdf"
            aria-label="Original resume preview"
          >
            <p className="resume-preview-fallback">
              Preview unavailable in this browser. Close the preview and choose
              Download original resume.
            </p>
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
