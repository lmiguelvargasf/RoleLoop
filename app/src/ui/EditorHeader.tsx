import { Check, LoaderCircle, Pencil } from "lucide-react";

export function EditorHeader({
  titleId,
  title,
  description,
  dirty,
  busy,
}: {
  titleId: string;
  title: string;
  description: string;
  dirty: boolean;
  busy: boolean;
}) {
  return (
    <header className="editor-header">
      <div className="editor-heading">
        <h1 id={titleId}>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="editor-actions">
        <span
          className={`editor-save-state${dirty ? " is-dirty" : ""}`}
          role="status"
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : dirty ? (
            <Pencil size={13} aria-hidden="true" />
          ) : (
            <Check size={15} aria-hidden="true" />
          )}
          {busy ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
        </span>
        <button
          type="submit"
          className="button primary"
          disabled={busy || !dirty}
        >
          Save changes
        </button>
      </div>
    </header>
  );
}
