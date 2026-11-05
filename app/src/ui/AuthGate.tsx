import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  RefreshCw,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { App } from "./App";
import { getAuthClient } from "./auth-client";
import { api, clearApiContext, setApiContext, write } from "./api";
import { AccountPage } from "./AccountPage";
import type { AccountContext, AuthConfig } from "../shared/types";

// A setup key is kept in memory only and removed before any other navigation.
const incomingSetupToken = (() => {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("setup") || "";
  if (token) {
    url.searchParams.delete("setup");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return token;
})();
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" />
      RoleLoop<span className="brand-period">.</span>
    </div>
  );
}
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-intro">
        <Brand />
        <div className="auth-intro-copy">
          <div className="eyebrow">YOUR PERSONAL WORKSPACE</div>
          <h1>
            Your next move.
            <br />
            Your own space.
          </h1>
          <p>
            Keep your experience, opportunities and application drafts together,
            with access you control.
          </p>
          <div className="auth-path">
            <span>
              <span className="auth-path-dot" />
              Find opportunities
            </span>
            <i />
            <span>
              <span className="auth-path-dot" />
              Build on your experience
            </span>
            <i />
            <span>
              <span className="auth-path-dot" />
              Review every draft
            </span>
          </div>
        </div>
        <div className="auth-local-note">
          <ShieldCheck size={17} />
          <span>Local test mode · no live applications or outreach</span>
        </div>
      </section>
      <section className="auth-form-side">{children}</section>
    </main>
  );
}
function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
  return (
    <div
      className={`notice ${error ? "error" : "neutral"}`}
      role={error ? "alert" : "status"}
    >
      {error ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
      <span>{children}</span>
    </div>
  );
}
function AuthForm({
  client,
  config,
  notice,
}: {
  client: SupabaseClient;
  config: AuthConfig;
  notice: string;
}) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  function changeMode(next: typeof mode) {
    setMode(next);
    setError("");
    setMessage("");
    setPassword("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "reset") {
        const { error } = await client.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: `${location.origin}/?recovery=1` },
        );
        if (error) throw error;
        setMessage(
          "If an account exists for this address, you’ll receive a password reset link.",
        );
      } else if (mode === "signup") {
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { name: name.trim() },
            emailRedirectTo: location.origin,
          },
        });
        if (error) throw error;
        if (!data.session)
          setMessage("Check your email to confirm your account, then sign in.");
      } else {
        const { error } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to complete this request. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-form">
      <div className="auth-form-icon">
        {mode === "signup" ? (
          <UserPlus size={24} />
        ) : mode === "reset" ? (
          <KeyRound size={24} />
        ) : (
          <LogIn size={24} />
        )}
      </div>
      <h2>
        {mode === "signup"
          ? "Create your account"
          : mode === "reset"
            ? "Reset your password"
            : "Welcome back"}
      </h2>
      <p>
        {mode === "signup"
          ? "Start with a private workspace for your own job search."
          : mode === "reset"
            ? "We’ll send a recovery link to your email address."
            : "Sign in to open your workspace."}
      </p>
      {notice && <Notice>{notice}</Notice>}
      {incomingSetupToken && (
        <div className="notice neutral">
          <LockKeyhole size={17} />
          <span>
            Sign in or create your account to claim the existing workspace with
            your local setup key.
          </span>
        </div>
      )}
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <form onSubmit={submit}>
        {mode === "signup" && (
          <label className="field">
            <span>Your name</span>
            <input
              required
              maxLength={200}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
        )}
        <label className="field">
          <span>Email address</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus={mode !== "signup"}
          />
        </label>
        {mode !== "reset" && (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              required
              minLength={mode === "signup" ? 12 : undefined}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "signup" && <small>Use at least 12 characters.</small>}
          </label>
        )}
        <button className="button primary auth-submit" disabled={busy}>
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : mode === "reset" ? (
            <KeyRound size={17} />
          ) : (
            <ArrowRight size={17} />
          )}
          {mode === "signup"
            ? "Create account"
            : mode === "reset"
              ? "Send reset link"
              : "Sign in"}
        </button>
      </form>
      <div className="auth-form-links">
        {mode === "login" ? (
          <>
            <button className="text-button" onClick={() => changeMode("reset")}>
              Forgot your password?
            </button>
            <span>
              New here?{" "}
              <button
                className="text-button"
                onClick={() => changeMode("signup")}
              >
                Create an account
              </button>
            </span>
          </>
        ) : (
          <button className="text-button" onClick={() => changeMode("login")}>
            <ArrowLeft size={14} />
            Back to sign in
          </button>
        )}
      </div>
      {config.setupAvailable && !incomingSetupToken && (
        <details className="setup-help">
          <summary>Already have a local workspace?</summary>
          <p>
            Run <code>npm run account:setup</code> in the project terminal and
            open the link it prints. Your existing data stays protected until
            you claim it.
          </p>
        </details>
      )}
    </div>
  );
}
function RecoveryForm({
  client,
  complete,
}: {
  client: SupabaseClient;
  complete: () => void;
}) {
  const [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      await client.auth.signOut({ scope: "local" });
      complete();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update your password.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-form">
      <div className="auth-form-icon">
        <KeyRound size={24} />
      </div>
      <h2>Choose a new password</h2>
      <p>Use a password you haven’t used for this account before.</p>
      {error && <Notice error>{error}</Notice>}
      <form onSubmit={submit}>
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <small>Use at least 12 characters.</small>
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button className="button primary auth-submit" disabled={busy}>
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <CheckCircle2 size={16} />
          )}
          Save password
        </button>
      </form>
    </div>
  );
}

export function AuthGate() {
  const [config, setConfig] = useState<AuthConfig | null>(null),
    [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null),
    [sessionReady, setSessionReady] = useState(false),
    [account, setAccount] = useState<AccountContext | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState(
    new URLSearchParams(location.search).has("recovery"),
  );
  const sessionRef = useRef<Session | null>(null),
    workspaceRef = useRef<string | null>(null),
    generation = useRef(0),
    claimAttempted = useRef(false),
    accountRef = useRef<AccountContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    clearApiContext();
    void (async () => {
      try {
        const response = await fetch("/api/auth/config");
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error || "The local service is unavailable.");
        if (cancelled) return;
        const next = getAuthClient(value.supabaseUrl, value.anonKey);
        setConfig(value);
        setClient(next);
        const listener = next.auth.onAuthStateChange((event, nextSession) => {
          if (cancelled) return;
          const userChanged =
            sessionRef.current?.user.id !== nextSession?.user.id;
          sessionRef.current = nextSession;
          if (userChanged) {
            generation.current++;
            accountRef.current = null;
            workspaceRef.current = null;
            setAccount(null);
            setWorkspaceId(null);
            if (nextSession)
              setNotice((previous) =>
                previous === "Password updated. Sign in with your new password."
                  ? ""
                  : previous,
              );
          }
          if (event === "PASSWORD_RECOVERY") setRecovery(true);
          setApiContext({
            token: nextSession?.access_token || null,
            userId: nextSession?.user.id || null,
            workspaceId: workspaceRef.current,
          });
          setSession(nextSession);
          setSessionReady(true);
        });
        unsubscribe = () => listener.data.subscription.unsubscribe();
        const { data, error } = await next.auth.getSession();
        if (error) throw error;
        if (!cancelled) {
          sessionRef.current = data.session;
          setApiContext({
            token: data.session?.access_token || null,
            userId: data.session?.user.id || null,
            workspaceId: workspaceRef.current,
          });
          setSession(data.session);
          setSessionReady(true);
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error
              ? err.message
              : "Unable to connect to authentication.",
          );
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  const reloadAccount = useCallback(async (preferredWorkspaceId?: string) => {
    const current = sessionRef.current;
    if (!current) return;
    const requestGeneration = generation.current;
    const next = await api<AccountContext>("/account");
    if (
      requestGeneration !== generation.current ||
      sessionRef.current?.user.id !== current.user.id
    )
      return;
    const preferred =
      preferredWorkspaceId ||
      workspaceRef.current ||
      localStorage.getItem(`roleloop-workspace:${current.user.id}`);
    const selected =
      next.workspaces.find((w) => w.id === preferred) ||
      next.workspaces.find((w) => w.role === "owner") ||
      next.workspaces[0];
    if (!selected)
      throw new Error(
        "Your account does not have a workspace. Please reload or contact the installation administrator.",
      );
    if (workspaceRef.current !== selected.id) generation.current++;
    workspaceRef.current = selected.id;
    accountRef.current = next;
    localStorage.setItem(`roleloop-workspace:${current.user.id}`, selected.id);
    setApiContext({
      token: sessionRef.current!.access_token,
      userId: current.user.id,
      workspaceId: selected.id,
    });
    setWorkspaceId(selected.id);
    setAccount(next);
    setError("");
  }, []);
  useEffect(() => {
    if (!session || recovery) return;
    let cancelled = false;
    void (async () => {
      try {
        let claimed: string | undefined;
        if (incomingSetupToken && !claimAttempted.current) {
          claimAttempted.current = true;
          try {
            const result = await write<{ workspaceId: string }>(
              "/account/claim-owner",
              { token: incomingSetupToken },
            );
            claimed = result.workspaceId;
            setConfig((c) => (c ? { ...c, setupAvailable: false } : c));
            setNotice("Your existing workspace is now linked to your account.");
          } catch (err) {
            setNotice(
              err instanceof Error
                ? `The existing workspace was not claimed: ${err.message}`
                : "The existing workspace was not claimed. You can retry from Account & access.",
            );
          }
        }
        if (!cancelled) await reloadAccount(claimed);
      } catch (err) {
        if (
          !cancelled &&
          !(err instanceof DOMException && err.name === "AbortError")
        )
          setError(
            err instanceof Error ? err.message : "Unable to open your account.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, recovery, reloadAccount]);
  const signOut = useCallback(
    async (preserveNotice = false) => {
      if (!preserveNotice) setNotice("");
      generation.current++;
      accountRef.current = null;
      workspaceRef.current = null;
      setAccount(null);
      setWorkspaceId(null);
      clearApiContext();
      const result = await client?.auth.signOut({ scope: "local" });
      if (result?.error)
        setNotice("Your local session could not be closed. Please try again.");
    },
    [client],
  );
  useEffect(() => {
    if (!session || recovery) return;
    const refreshAccess = () => {
      void reloadAccount().catch(() => {});
    };
    const timer = setInterval(refreshAccess, 15000);
    window.addEventListener("focus", refreshAccess);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshAccess);
    };
  }, [Boolean(session), recovery, reloadAccount]);
  useEffect(() => {
    const invalid = (event: Event) => {
      const detail = (
        event as CustomEvent<{ status: number; workspaceId: string | null }>
      ).detail;
      if (detail.status === 401) {
        setNotice("Your session expired. Sign in again to continue.");
        void signOut(true);
      } else if (detail.workspaceId === workspaceRef.current) {
        generation.current++;
        accountRef.current = null;
        setAccount(null);
        setNotice(
          "Workspace access changed. Your available workspaces have been refreshed.",
        );
        void reloadAccount().catch((err) =>
          setError(
            err instanceof Error ? err.message : "Workspace access changed.",
          ),
        );
      }
    };
    window.addEventListener("roleloop-access-error", invalid);
    return () => window.removeEventListener("roleloop-access-error", invalid);
  }, [reloadAccount, signOut]);
  const switchWorkspace = (id: string) => {
    const current = sessionRef.current;
    if (!current || !account?.workspaces.some((w) => w.id === id)) return;
    generation.current++;
    workspaceRef.current = id;
    setApiContext({
      token: current.access_token,
      userId: current.user.id,
      workspaceId: id,
    });
    localStorage.setItem(`roleloop-workspace:${current.user.id}`, id);
    setWorkspaceId(id);
    setNotice("");
  };
  if (!config || !client || !sessionReady)
    return (
      <AuthShell>
        <div className="auth-form">
          {error ? (
            <>
              <AlertTriangle size={28} />
              <h2>Let’s connect your accounts.</h2>
              <p role="alert">{error}</p>
              <button
                className="button primary"
                onClick={() => location.reload()}
              >
                <RefreshCw size={16} />
                Try again
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="spin" size={28} />
              <h2>Opening RoleLoop…</h2>
              <p>Connecting to your local account service.</p>
            </>
          )}
        </div>
      </AuthShell>
    );
  if (session && recovery)
    return (
      <AuthShell>
        <RecoveryForm
          client={client}
          complete={() => {
            const url = new URL(location.href);
            url.searchParams.delete("recovery");
            history.replaceState(null, "", url.pathname + url.search);
            setRecovery(false);
            setNotice("Password updated. Sign in with your new password.");
          }}
        />
      </AuthShell>
    );
  if (!session)
    return (
      <AuthShell>
        <AuthForm client={client} config={config} notice={notice} />
      </AuthShell>
    );
  if (!account || !workspaceId)
    return (
      <AuthShell>
        <div className="auth-form">
          {error ? (
            <>
              <AlertTriangle size={28} />
              <h2>Unable to open your workspace</h2>
              <p role="alert">{error}</p>
              <div className="button-row">
                <button
                  className="button primary"
                  onClick={() =>
                    void reloadAccount().catch((err) => setError(err.message))
                  }
                >
                  Try again
                </button>
                <button className="button" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <LoaderCircle className="spin" size={28} />
              <h2>Opening your workspace…</h2>
              <p>Checking your account and workspace access.</p>
            </>
          )}
        </div>
      </AuthShell>
    );
  const workspace = account.workspaces.find((w) => w.id === workspaceId)!;
  return (
    <App
      key={`${account.user.id}:${workspaceId}`}
      account={account}
      workspace={workspace}
      onWorkspaceChange={switchWorkspace}
      onSignOut={() => void signOut()}
      accountNotice={notice}
      accountPage={
        <AccountPage
          account={account}
          workspace={workspace}
          config={config}
          client={client}
          notice={notice}
          reloadAccount={reloadAccount}
          onClaimed={() =>
            setConfig((c) => (c ? { ...c, setupAvailable: false } : c))
          }
        />
      }
    />
  );
}
