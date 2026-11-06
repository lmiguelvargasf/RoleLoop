import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Undo2,
  X,
} from "lucide-react";

const cleanTitle = (title: string) => title.trim().replace(/\s+/g, " ");
const titleKey = (title: string) => cleanTitle(title).toLowerCase();

export function mergeTargetRoles(
  roles: string[],
  additions: string[],
): string[] {
  const seen = new Set<string>();
  return [...roles, ...additions].flatMap((role) => {
    const title = cleanTitle(role);
    const key = titleKey(title);
    if (!title || seen.has(key)) return [];
    seen.add(key);
    return [title];
  });
}

type SaveRoles = (roles: string[]) => Promise<boolean>;

export function TargetRolesInput({
  roles,
  onSave,
  disabled = false,
}: {
  roles: string[];
  onSave: SaveRoles;
  disabled?: boolean;
}) {
  const id = useId();
  const manageButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  function close() {
    setOpen(false);
    requestAnimationFrame(() => manageButton.current?.focus());
  }

  return (
    <div className="field wide target-roles" aria-labelledby={id}>
      <span id={id}>Target roles</span>
      <div className="role-overview">
        <div className="role-overview-heading">
          <div className="role-overview-count">
            <strong>{roles.length}</strong>
            <span>
              {roles.length === 1
                ? "title in your search"
                : "titles in your search"}
            </span>
          </div>
          <button
            ref={manageButton}
            type="button"
            className="button role-manage-button"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            {roles.length ? "Manage roles" : "Add a role"}
            <Pencil size={13} aria-hidden="true" />
          </button>
        </div>
        {roles.length > 0 ? (
          <ul className="role-overview-list" aria-label="Target role preview">
            {roles.slice(0, 6).map((role, index) => (
              <li key={`${role}-${index}`}>{role}</li>
            ))}
          </ul>
        ) : (
          <p className="role-overview-empty">
            Add the job titles you want to explore.
          </p>
        )}
        {roles.length > 6 && (
          <button
            type="button"
            className="role-overview-more"
            onClick={() => setOpen(true)}
            disabled={disabled}
          >
            +{roles.length - 6} more titles
          </button>
        )}
      </div>
      {open &&
        createPortal(
          <RoleEditor
            initial={roles}
            onSave={onSave}
            close={close}
            busy={disabled}
          />,
          document.body,
        )}
    </div>
  );
}

function RoleEditor({
  initial,
  onSave,
  close,
  busy,
}: {
  initial: string[];
  onSave: SaveRoles;
  close: () => void;
  busy: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [roles, setRoles] = useState(() => mergeTargetRoles(initial, []));
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(initial.length === 0);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{
    title: string;
    draft: string;
  } | null>(null);
  const [removed, setRemoved] = useState<{
    title: string;
    index: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const changed =
    JSON.stringify(roles) !== JSON.stringify(initial) ||
    Boolean(draft.trim()) ||
    Boolean(editing);
  const visible = roles
    .filter((role) => titleKey(role).includes(titleKey(query)))
    .sort((a, b) => a.localeCompare(b));

  function focusSearch() {
    requestAnimationFrame(() => searchInput.current?.focus());
  }

  function saveFailed() {
    setError("Could not save roles. Your changes are still here; try again.");
    requestAnimationFrame(() => saveButton.current?.focus());
  }

  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    (initial.length ? searchInput.current : addInput.current)?.focus();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function add(titles = [draft]) {
    const next = mergeTargetRoles(roles, titles);
    const count = next.length - roles.length;
    if (!count) {
      setError(
        titles.some((title) => title.trim())
          ? "That title is already in your list."
          : "Enter a job title.",
      );
      return;
    }
    setRoles(next);
    setDraft("");
    setQuery("");
    setError("");
    setMessage(`${count === 1 ? "Role" : `${count} roles`} added.`);
    setRemoved(null);
    addInput.current?.focus();
  }

  function rename(current = roles): string[] | null {
    if (!editing) return current;
    const title = cleanTitle(editing.draft);
    if (!title) {
      setError("Enter a job title before saving the edit.");
      return null;
    }
    if (
      current.some(
        (role) => role !== editing.title && titleKey(role) === titleKey(title),
      )
    ) {
      setError("That title is already in your list.");
      return null;
    }
    return current.map((role) => (role === editing.title ? title : role));
  }

  function finishEdit() {
    const next = rename();
    if (!next) return;
    setRoles(next);
    setEditing(null);
    setError("");
    setMessage("Role updated.");
    setRemoved(null);
    focusSearch();
  }

  async function save() {
    let next = rename();
    if (!next) return;
    if (draft.trim()) next = mergeTargetRoles(next, [draft]);
    setError("");
    try {
      if (await onSave(next)) close();
      else saveFailed();
    } catch {
      saveFailed();
    }
  }

  return (
    <dialog
      ref={dialog}
      className="roles-editor"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        className="roles-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }}
      >
        <header className="roles-editor-header">
          <div>
            <div className="roles-editor-title">
              <h2 id={`${id}-title`}>Target roles</h2>
              <span className="roles-editor-total">{roles.length}</span>
            </div>
            <p id={`${id}-description`}>The job titles you want to explore.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close role editor"
            disabled={busy}
            onClick={close}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        {(roles.length > 0 || !adding) && (
          <div className="roles-editor-toolbar">
            <div className="roles-editor-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInput}
                aria-label="Find a target role"
                disabled={busy || Boolean(editing)}
                placeholder="Find a role…"
                autoFocus={!adding}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
              />
              {query && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear role search"
                  onClick={() => {
                    setQuery("");
                    focusSearch();
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            {!adding && (
              <button
                type="button"
                className="button primary"
                disabled={busy || Boolean(editing)}
                onClick={() => {
                  setAdding(true);
                  setError("");
                }}
              >
                <Plus size={15} aria-hidden="true" /> Add role
              </button>
            )}
          </div>
        )}
        {adding && (
          <div className="roles-editor-add">
            <label htmlFor={`${id}-new`}>New role title</label>
            <div className="roles-editor-add-controls">
              <input
                ref={addInput}
                id={`${id}-new`}
                placeholder="e.g. Software Engineer, AI Agents"
                autoFocus
                autoComplete="off"
                disabled={busy}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    add();
                  }
                }}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  if (!/[\r\n]/.test(pasted)) return;
                  event.preventDefault();
                  const { selectionStart, selectionEnd } = event.currentTarget;
                  const text =
                    draft.slice(0, selectionStart ?? draft.length) +
                    pasted +
                    draft.slice(selectionEnd ?? draft.length);
                  add(text.split(/[\r\n]+/));
                }}
              />
              <button
                type="button"
                className="button"
                disabled={busy || !draft.trim()}
                onClick={() => add()}
              >
                Add
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel adding a role"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setDraft("");
                  setError("");
                  focusSearch();
                }}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <small>Paste multiple titles on separate lines.</small>
          </div>
        )}
        {roles.length > 0 && (
          <div className="roles-editor-list-header">
            <span>
              {query.trim()
                ? `${visible.length} ${visible.length === 1 ? "match" : "matches"}`
                : "Your roles"}
            </span>
            <span>A–Z</span>
          </div>
        )}
        <div className="roles-editor-scroll">
          {visible.length > 0 ? (
            <ul className="roles-editor-list" aria-label="Target roles">
              {visible.map((role) => (
                <li
                  className={`roles-editor-row ${editing?.title === role ? "is-editing" : ""}`}
                  key={role}
                >
                  {editing?.title === role ? (
                    <>
                      <input
                        autoFocus
                        aria-label={`Edit ${role}`}
                        value={editing.draft}
                        disabled={busy}
                        onChange={(event) => {
                          setEditing({
                            title: role,
                            draft: event.target.value,
                          });
                          setError("");
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            finishEdit();
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            setEditing(null);
                            setError("");
                            focusSearch();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="icon-button role-edit-confirm"
                        aria-label="Confirm role edit"
                        disabled={busy}
                        onClick={finishEdit}
                      >
                        <Check size={17} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Cancel role edit"
                        disabled={busy}
                        onClick={() => {
                          setEditing(null);
                          setError("");
                          focusSearch();
                        }}
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="roles-editor-row-title">{role}</span>
                      <button
                        type="button"
                        className="icon-button role-row-action"
                        aria-label={`Edit ${role}`}
                        disabled={busy}
                        onClick={() => {
                          setEditing({ title: role, draft: role });
                          setError("");
                        }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button role-row-action role-row-remove"
                        aria-label={`Remove ${role}`}
                        disabled={busy}
                        onClick={() => {
                          setRemoved({
                            title: role,
                            index: roles.indexOf(role),
                          });
                          setRoles(roles.filter((title) => title !== role));
                          setError("");
                          setMessage(`${role} removed.`);
                          focusSearch();
                        }}
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="roles-editor-empty">
              <strong>
                {query.trim()
                  ? "No matching roles"
                  : "Start with a role you want"}
              </strong>
              <p>
                {query.trim()
                  ? "Try a different search, or add this title."
                  : "Add a title, then build your list from there."}
              </p>
              {query.trim() && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(query);
                    setQuery("");
                    setAdding(true);
                    requestAnimationFrame(() => addInput.current?.focus());
                  }}
                >
                  Add “{query.trim()}”
                </button>
              )}
            </div>
          )}
        </div>
        {(error || removed || message) && (
          <div className={`roles-editor-feedback ${error ? "has-error" : ""}`}>
            <span role={error ? "alert" : "status"}>
              {error || (removed ? `Removed “${removed.title}”` : message)}
            </span>
            {removed && !error && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  const next = [...roles];
                  if (
                    !next.some(
                      (role) => titleKey(role) === titleKey(removed.title),
                    )
                  )
                    next.splice(
                      Math.min(removed.index, next.length),
                      0,
                      removed.title,
                    );
                  setRoles(next);
                  setRemoved(null);
                  setMessage("Role restored.");
                }}
              >
                <Undo2 size={13} aria-hidden="true" /> Undo
              </button>
            )}
          </div>
        )}
        <footer className="roles-editor-footer">
          <span className="roles-editor-save-state">
            {changed ? "Unsaved changes" : "No changes"}
          </span>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button
            ref={saveButton}
            type="submit"
            className="button primary"
            disabled={busy || !changed}
          >
            {busy && (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            )}
            {busy ? "Saving…" : "Save roles"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
