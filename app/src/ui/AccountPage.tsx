import { useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  UserPlus,
  Users,
} from "lucide-react";
import type { AccountContext } from "../shared/types";
import type { ManagedUser } from "./account-types";
import { ChatGPTConnectionPanel } from "./ChatGPTConnectionPanel";
import { api, write } from "./api";

export function AccountPage({
  account,
  client,
  notice,
}: {
  account: AccountContext;
  client: SupabaseClient;
  notice: string;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [userName, setUserName] = useState(""),
    [userEmail, setUserEmail] = useState(""),
    [userPassword, setUserPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState(notice);
  async function loadUsers() {
    if (!account.isAdmin) return;
    const result = await api<{ users: ManagedUser[] }>("/admin/users");
    setUsers(result.users);
  }
  useEffect(() => {
    if (!account.isAdmin) return;
    let live = true;
    setLoading(true);
    void api<{ users: ManagedUser[] }>("/admin/users")
      .then((result) => {
        if (live) setUsers(result.users);
      })
      .catch((err) => {
        if (live && err.name !== "AbortError")
          setError(err.message || "Unable to load accounts.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [account.isAdmin]);
  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError"))
        setError(
          err instanceof Error
            ? err.message
            : "Unable to complete this request.",
        );
    } finally {
      setBusy(false);
    }
  }
  const createUser = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      await write("/admin/users", {
        name: userName.trim(),
        email: userEmail.trim(),
        password: userPassword,
      });
      setUserPassword("");
      setUserEmail("");
      setUserName("");
      await loadUsers();
    }, "Account created. It will open its own private workspace when the user signs in.");
  };
  return (
    <section
      className="page form-page account-page"
      aria-labelledby="account-title"
    >
      <header className="page-heading">
        <h1 id="account-title">Account</h1>
      </header>
      {error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}
      {message && (
        <div className="notice neutral" role="status">
          <CheckCircle2 size={18} />
          <span>{message}</span>
        </div>
      )}
      <div className="account-identity">
        <span className="account-avatar" aria-hidden="true">
          {(account.user.name || account.user.email)
            .slice(0, 1)
            .toUpperCase()}
        </span>
        <div>
          <strong>{account.user.name || account.user.email}</strong>
          {account.user.name && <span>{account.user.email}</span>}
          {account.isAdmin && <small>Administrator</small>}
        </div>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const { error } = await client.auth.resetPasswordForEmail(
                account.user.email,
                { redirectTo: `${location.origin}/?recovery=1` },
              );
              if (error) throw error;
            }, "Password reset instructions have been sent to your email address.")
          }
        >
          <KeyRound size={15} aria-hidden="true" />
          Reset password
        </button>
      </div>
      <ChatGPTConnectionPanel key={account.user.id} />
      {account.isAdmin && (
        <section className="form-section admin-accounts">
          <div className="section-heading">
            <div>
              <h2>Manage accounts</h2>
              <p>
                Create accounts for this local installation. Account
                administration does not grant access to their workspaces.
              </p>
            </div>
            <Users size={23} />
          </div>
          {loading && (
            <div className="access-loading">
              <LoaderCircle className="spin" size={18} />
              Loading accounts…
            </div>
          )}
          <div className="access-list">
            {users.map((user) => (
              <div className="access-row" key={user.id}>
                <span className="account-avatar small">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <div className="access-person">
                  <strong>{user.name || user.email}</strong>
                  <span>{user.email}</span>
                </div>
                <span className="muted account-created">
                  {user.createdAt &&
                    new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    }).format(new Date(user.createdAt))}
                </span>
              </div>
            ))}
          </div>
          <form onSubmit={createUser} className="create-account-form">
            <h3>Create an account</h3>
            <div className="form-grid">
              <label className="field">
                <span>Name</span>
                <input
                  required
                  maxLength={200}
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Email address</span>
                <input
                  type="email"
                  required
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="field wide">
                <span>Initial password</span>
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)}
                />
                <small>
                  At least 12 characters. Share it privately with the account
                  owner.
                </small>
              </label>
            </div>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                <UserPlus size={16} />
                Create account
              </button>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
