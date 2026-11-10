import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Unplug } from "lucide-react";
import type { ChatGPTConnection } from "../shared/types";
import { api, write } from "./api";
import { SelectField } from "./SelectField";

export function ChatGPTConnectionPanel() {
  const [connection, setConnection] = useState<ChatGPTConnection>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [callbackUrl, setCallbackUrl] = useState("");
  const remote =
    typeof window !== "undefined" &&
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      window.location.hostname,
    );
  const alive = useRef(true);
  const loading = useRef(false);
  const refreshRequested = useRef(false);
  const current = useRef<ChatGPTConnection | undefined>(undefined);
  async function load() {
    if (loading.current) {
      refreshRequested.current = true;
      return;
    }
    loading.current = true;
    try {
      const next = await api<ChatGPTConnection>("/account/chatgpt");
      if (alive.current) {
        setConnection(next);
        current.current = next;
        if (!next.pending) setCallbackUrl("");
      }
    } catch (err) {
      if (alive.current && (err as Error).name !== "AbortError")
        setError((err as Error).message);
    } finally {
      loading.current = false;
      if (refreshRequested.current && alive.current) {
        refreshRequested.current = false;
        void load();
      }
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
    setCallbackUrl("");
    // Open synchronously so the browser can allow this user-initiated window.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    void action(async () => {
      try {
        const result = await write<{ url: string; manual?: boolean }>(
          "/account/chatgpt/connect",
          { profileId, manual: remote },
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
        </div>
        {!usingPlan && (
          <button
            type="button"
            className="button chatgpt-signin"
            data-oai-siwc-button
            disabled={busy || !connection || connection.pending}
            onClick={() => connect(active?.connected ? active.id : undefined)}
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
      {connection?.pending && !remote && (
        <p className="chatgpt-hint" role="status">
          Finish signing in in the browser window.
        </p>
      )}
      {connection?.pending && remote && (
        <form
          className="chatgpt-preferences"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const result = await write<{ message: string }>(
                "/account/chatgpt/complete",
                { callbackUrl: callbackUrl.trim() },
              );
              if (alive.current) {
                setCallbackUrl("");
                setMessage(result.message);
              }
            });
          }}
        >
          <p className="chatgpt-hint" id="chatgpt-remote-instructions">
            Finish signing in with ChatGPT. When the browser reaches a localhost
            connection-error page, copy its full address from the address bar and
            paste it below. Keep this address private.
          </p>
          <label className="field">
            <span>Callback URL</span>
            <input
              type="url"
              required
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="chatgpt-remote-instructions"
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="chatgpt-actions">
            <button
              className="button primary"
              disabled={busy || !callbackUrl.trim()}
            >
              {busy && <LoaderCircle className="spin" size={16} />}
              Finish connection
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => connect(active?.connected ? active.id : undefined)}
            >
              Start again
            </button>
          </div>
        </form>
      )}
      {connection?.mode === "chatgpt" &&
        active?.connected &&
        !active.planEnabled && (
          <p className="chatgpt-hint">Approve plan usage to start using AI.</p>
        )}
      {usingPlan && active && (
        <div className="chatgpt-preferences">
          <p className="chatgpt-account">{active.email || active.label}</p>
          {active.error && (
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
          <SelectField
            label="Model"
            value={active.model || ""}
            disabled={busy || !active.models.length}
            placeholder={
              connection?.modelsError ? "Models unavailable" : "Loading models…"
            }
            onChange={(model) =>
              void action(() =>
                write("/account/chatgpt/select", {
                  profileId: active.id,
                  model,
                }),
              )
            }
            options={active.models.map((model) => ({
              value: model.slug,
              label: model.displayName,
            }))}
          />
        </div>
      )}
      {usingPlan && active && (
        <div className="chatgpt-actions">
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
                const result = await write<{ message: string }>(
                  "/account/chatgpt/disconnect",
                  {
                    profileId: active.id,
                  },
                );
                if (alive.current) setMessage(result.message);
              })
            }
          >
            <Unplug size={14} /> Disconnect
          </button>
          {connection?.apiConfigured && (
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
      )}
    </section>
  );
}
