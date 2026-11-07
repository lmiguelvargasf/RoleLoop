import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Unplug } from "lucide-react";
import type { ChatGPTConnection } from "../shared/types";
import { api, write } from "./api";

export function ChatGPTConnectionPanel() {
  const [connection, setConnection] = useState<ChatGPTConnection>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const alive = useRef(true);
  const loading = useRef(false);
  const current = useRef<ChatGPTConnection | undefined>(undefined);
  async function load() {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await api<ChatGPTConnection>("/account/chatgpt");
      if (alive.current) {
        setConnection(next);
        current.current = next;
      }
    } catch (err) {
      if (alive.current && (err as Error).name !== "AbortError")
        setError((err as Error).message);
    } finally {
      loading.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => {
      if (current.current?.pending) void load();
    }, 2000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, []);
  async function action(task?: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task?.();
      if (alive.current) await load();
    } catch (err) {
      if (alive.current && (err as Error).name !== "AbortError")
        setError((err as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function connect(profileId?: string) {
    // Open synchronously so the browser can allow this user-initiated window.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    void action(async () => {
      try {
        const result = await write<{ url: string }>(
          "/account/chatgpt/connect",
          { profileId },
        );
        if (!alive.current) {
          popup?.close();
          return;
        }
        if (popup) popup.location.href = result.url;
        else window.location.assign(result.url);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }
  const active = connection?.profiles.find((p) => p.id === connection.activeId);
  const usingPlan =
    connection?.mode === "chatgpt" && active?.connected && active.planEnabled;
  const usingApi = connection?.mode === "api" && connection.apiConfigured;
  return (
    <section
      className="form-section chatgpt-connection"
      aria-labelledby="chatgpt-title"
    >
      <div className="chatgpt-summary">
        <div className="chatgpt-summary-copy">
          <div className="chatgpt-title-row">
            <h2 id="chatgpt-title">ChatGPT</h2>
            <span
              className={`chatgpt-status ${usingPlan || usingApi ? "is-connected" : ""}`}
              role="status"
            >
              {!connection
                ? error
                  ? "Unavailable"
                  : "Loading…"
                : connection.pending
                  ? "Signing in…"
                  : usingPlan
                    ? "Connected"
                    : usingApi
                      ? "API billing"
                      : "Not connected"}
            </span>
          </div>
          <p>For résumé import and job matching.</p>
        </div>
        {!usingPlan && (
          <button
            type="button"
            className="button chatgpt-signin"
            data-oai-siwc-button
            disabled={busy || !connection || connection.pending}
            onClick={() =>
              connect(connection?.mode === "chatgpt" ? active?.id : undefined)
            }
          >
            {busy && <LoaderCircle className="spin" size={16} />}
            {active &&
            connection?.mode === "chatgpt" &&
            active.connected &&
            !active.planEnabled
              ? "Enable plan usage"
              : "Continue with ChatGPT"}
          </button>
        )}
      </div>
      {(error || connection?.error || connection?.modelsError) && (
        <div className="notice error" role="alert">
          {error || connection?.error || connection?.modelsError}
          {(!connection || connection.modelsError) && (
            <button
              type="button"
              className="text-button"
              onClick={() => void action()}
              disabled={busy}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {message && (
        <div className="notice neutral" role="status">
          {message}
        </div>
      )}
      {connection?.pending && (
        <p className="chatgpt-hint" role="status">
          Finish signing in in the browser window.
        </p>
      )}
      {connection?.mode === "chatgpt" &&
        active?.connected &&
        !active.planEnabled && (
          <p className="chatgpt-hint">Approve plan usage to start using AI.</p>
        )}
      {!!connection?.profiles.length && (usingPlan || usingApi) && (
        <div className="chatgpt-preferences">
          {connection.profiles.length > 1 ? (
            <label className="field">
              <span>Account</span>
              <select
                value={
                  connection.mode === "chatgpt" ? connection.activeId || "" : ""
                }
                disabled={busy}
                onChange={(e) =>
                  void action(() =>
                    write("/account/chatgpt/select", {
                      profileId: e.target.value,
                    }),
                  )
                }
              >
                <option value="" disabled>
                  Select an account
                </option>
                {connection.profiles.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.label}
                    {!p.connected
                      ? " · reconnect"
                      : !p.planEnabled
                        ? " · enable plan usage"
                        : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : connection.mode === "chatgpt" && active ? (
            <p className="chatgpt-account">{active.email || active.label}</p>
          ) : (
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  write("/account/chatgpt/select", {
                    profileId: connection.profiles[0].id,
                  }),
                )
              }
            >
              Use {connection.profiles[0].label}
            </button>
          )}
          {connection.mode === "chatgpt" && active?.error && (
            <div className="notice error" role="alert">
              {active.error}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void action(() => write("/account/chatgpt/retry"))
                }
              >
                Retry
              </button>
            </div>
          )}
          {usingPlan && active && (
            <label className="field">
              <span>Model</span>
              <select
                aria-label="Model"
                disabled={busy || !active.models.length}
                value={active.model || ""}
                onChange={(e) =>
                  void action(() =>
                    write("/account/chatgpt/select", {
                      profileId: active.id,
                      model: e.target.value,
                    }),
                  )
                }
              >
                {!active.models.length && (
                  <option value="">
                    {connection.modelsError
                      ? "Models unavailable"
                      : "Loading models…"}
                  </option>
                )}
                {active.models.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {connection &&
        (usingPlan || usingApi) &&
        !!connection.profiles.length && (
          <details className="chatgpt-settings">
            <summary>Connection settings</summary>
            <div className="chatgpt-actions">
              {!!connection.profiles.length && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || connection.pending}
                  onClick={() => connect()}
                >
                  Add account
                </button>
              )}
              {connection.mode === "chatgpt" && active?.connected && (
                <>
                  <a
                    className="text-button"
                    href="https://chatgpt.com/settings/usage"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Manage usage <ExternalLink size={13} />
                  </a>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await write("/account/chatgpt/disconnect", {
                          profileId: active.id,
                        });
                        if (alive.current) setMessage("Disconnected.");
                      })
                    }
                  >
                    <Unplug size={14} /> Disconnect
                  </button>
                </>
              )}
              {connection.apiConfigured && connection.mode !== "api" && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void action(() => write("/account/chatgpt/use-api"))
                  }
                >
                  Use API billing
                </button>
              )}
            </div>
          </details>
        )}
    </section>
  );
}
