import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Unplug,
} from "lucide-react";
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
  async function action(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
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
  return (
    <section
      className="form-section chatgpt-connection"
      aria-labelledby="chatgpt-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="chatgpt-title">AI connection</h2>
          <p>
            Connect your ChatGPT plan for résumé import and matching on this
            computer.
          </p>
        </div>
        <span className={`badge ${usingPlan ? "badge-ready" : "badge-review"}`}>
          {usingPlan
            ? "Using ChatGPT plan"
            : connection?.mode === "api" && connection.apiConfigured
              ? "Using API billing"
              : "Not connected"}
        </span>
      </div>
      <p className="chatgpt-explanation">
        Eligible ChatGPT Plus and Pro accounts can approve plan usage. Your
        allowance and app limits apply. This connection belongs to your RoleLoop
        account.
      </p>
      {(error || connection?.error) && (
        <div className="notice error" role="alert">
          {error || connection?.error}
        </div>
      )}
      {message && (
        <div className="notice neutral" role="status">
          {message}
        </div>
      )}
      {!connection && !error && (
        <p>
          <LoaderCircle size={16} className="spin" /> Loading connection…
        </p>
      )}
      {connection?.pending && (
        <p role="status">
          <LoaderCircle size={16} className="spin" /> Complete sign-in in the
          browser window.
        </p>
      )}
      {!!connection?.profiles.length && (
        <label className="field">
          <span>ChatGPT account</span>
          <select
            value={
              connection.mode === "chatgpt" ? connection.activeId || "" : ""
            }
            disabled={busy}
            onChange={(e) =>
              void action(() =>
                write("/account/chatgpt/select", { profileId: e.target.value }),
              )
            }
          >
            <option value="" disabled>
              Select a connected account
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
      )}
      {connection?.mode === "chatgpt" && active && (
        <div className="chatgpt-active">
          <p>
            {active.connected ? (
              <>
                <CheckCircle2 size={16} /> Connected as{" "}
                {active.email || active.label}.
              </>
            ) : (
              "Reconnect this account to use your ChatGPT plan."
            )}
          </p>
          {active.error && (
            <div className="notice error" role="alert">
              {active.error}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(() => write("/account/chatgpt/retry"))
                }
              >
                Retry AI requests
              </button>
            </div>
          )}
          {active.connected && !active.planEnabled && (
            <p>
              Sign-in is complete, but plan usage has not been approved. Choose
              Enable plan usage below.
            </p>
          )}
          {active.connected && active.planEnabled && (
            <label className="field">
              <span>Model</span>
              <div className="chatgpt-model-row">
                <select
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
                    <option value="">Load available models</option>
                  )}
                  {active.models.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void action(() => write("/account/chatgpt/models"))
                  }
                >
                  <RefreshCw size={15} />
                  Refresh models
                </button>
              </div>
            </label>
          )}
        </div>
      )}
      <div className="button-row chatgpt-actions">
        <button
          type="button"
          className="button chatgpt-signin"
          data-oai-siwc-button
          disabled={busy || connection?.pending}
          onClick={() =>
            connect(connection?.mode === "chatgpt" ? active?.id : undefined)
          }
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : null}
          {active && connection?.mode === "chatgpt" && !active.planEnabled
            ? "Enable plan usage"
            : "Continue with ChatGPT"}
        </button>
        {!!connection?.profiles.length && (
          <button
            type="button"
            className="button"
            disabled={busy || connection.pending}
            onClick={() => connect()}
          >
            Add another account
          </button>
        )}
        {connection?.mode === "chatgpt" && active?.connected && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await write<{ message: string }>(
                  "/account/chatgpt/disconnect",
                  { profileId: active.id },
                );
                if (alive.current) setMessage(result.message);
              })
            }
          >
            <Unplug size={15} />
            Disconnect
          </button>
        )}
        {connection?.apiConfigured && connection.mode !== "api" && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void action(() => write("/account/chatgpt/use-api"))}
          >
            Use API billing
          </button>
        )}
        <a
          className="button"
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
        >
          Manage usage <ExternalLink size={14} />
        </a>
      </div>
      <small>
        Background schedules use the server’s API configuration. Your
        subscription is used for requests you initiate, including queued tasks.
      </small>
    </section>
  );
}
