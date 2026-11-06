import { useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Mail,
  Save,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import type {
  AccountContext,
  AuthConfig,
  WorkspaceAccess,
} from "../shared/types";
import type { ManagedUser, WorkspaceMember } from "./account-types";
import { ChatGPTConnectionPanel } from "./ChatGPTConnectionPanel";
import { api, write } from "./api";

export function AccountPage({
  account,
  workspace,
  config,
  client,
  notice,
  reloadAccount,
  onClaimed,
}: {
  account: AccountContext;
  workspace: WorkspaceAccess;
  config: AuthConfig;
  client: SupabaseClient;
  notice: string;
  reloadAccount: (preferredWorkspaceId?: string) => Promise<void>;
  onClaimed: () => void;
}) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]),
    [users, setUsers] = useState<ManagedUser[]>([]);
  const [name, setName] = useState(workspace.name),
    [managerEmail, setManagerEmail] = useState(""),
    [setupToken, setSetupToken] = useState("");
  const [userName, setUserName] = useState(""),
    [userEmail, setUserEmail] = useState(""),
    [userPassword, setUserPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState(notice);
  const owner = workspace.role === "owner";
  async function loadMembers() {
    const result = await api<{ members: WorkspaceMember[] }>(
      `/workspaces/${encodeURIComponent(workspace.id)}/members`,
    );
    setMembers(result.members);
  }
  async function loadUsers() {
    if (!account.isAdmin) return;
    const result = await api<{ users: ManagedUser[] }>("/admin/users");
    setUsers(result.users);
  }
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([
      api<{ members: WorkspaceMember[] }>(
        `/workspaces/${encodeURIComponent(workspace.id)}/members`,
      ),
      account.isAdmin
        ? api<{ users: ManagedUser[] }>("/admin/users")
        : Promise.resolve({ users: [] }),
    ])
      .then(([memberResult, userResult]) => {
        if (live) {
          setMembers(memberResult.members);
          setUsers(userResult.users);
        }
      })
      .catch((err) => {
        if (live && err.name !== "AbortError")
          setError(err.message || "Unable to load account access.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspace.id, account.isAdmin]);
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
  const saveName = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      await write(
        `/workspaces/${encodeURIComponent(workspace.id)}`,
        { name: name.trim() },
        "PATCH",
      );
      await reloadAccount();
    }, "Workspace name saved.");
  };
  const grant = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      await write(`/workspaces/${encodeURIComponent(workspace.id)}/members`, {
        email: managerEmail.trim(),
      });
      setManagerEmail("");
      await loadMembers();
    }, "Manager access granted.");
  };
  const remove = (member: WorkspaceMember) =>
    void perform(async () => {
      await write(
        `/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.userId)}`,
        {},
        "DELETE",
      );
      await loadMembers();
    }, `Manager access removed for ${member.email}.`);
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
  const claim = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const result = await write<{ workspaceId: string }>(
        "/account/claim-owner",
        { token: setupToken.trim() },
      );
      setSetupToken("");
      onClaimed();
      await reloadAccount(result.workspaceId);
    }, "Your existing workspace is linked to your account.");
  };
  return (
    <section className="page form-page account-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCOUNT & WORKSPACE ACCESS</div>
          <h1>Account & access</h1>
          <p>Manage your account and choose who can work with you.</p>
        </div>
      </div>
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
      <section className="form-section">
        <div className="section-heading">
          <div>
            <h2>Your account</h2>
            <p>You’re signed in as {account.user.email}.</p>
          </div>
          <span className="badge badge-ready">
            {account.isAdmin ? "Installation administrator" : "Account"}
          </span>
        </div>
        <div className="account-identity">
          <span className="account-avatar">
            {(account.user.name || account.user.email)
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <div>
            <strong>{account.user.name || "Your account"}</strong>
            <span>{account.user.email}</span>
          </div>
          <button
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
            <KeyRound size={15} />
            Reset password
          </button>
        </div>
      </section>
      <ChatGPTConnectionPanel key={account.user.id} />
      <section className="form-section">
        <div className="section-heading">
          <div>
            <h2>Workspace access</h2>
            <p>
              {owner
                ? "Managers can work with your opportunities, profile and drafts. Only you can change access."
                : "You can work in this workspace. Its owner manages who has access."}
            </p>
          </div>
          <span className="badge badge-review">
            {owner ? "You are the owner" : "You are a manager"}
          </span>
        </div>
        {owner ? (
          <form className="workspace-name-form" onSubmit={saveName}>
            <label className="field">
              <span>Workspace name</span>
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={busy || !name.trim() || name === workspace.name}
            >
              <Save size={15} />
              Save name
            </button>
          </form>
        ) : (
          <div className="workspace-name-readonly">
            <strong>{workspace.name}</strong>
          </div>
        )}
        {loading ? (
          <div className="access-loading">
            <LoaderCircle className="spin" size={18} />
            Loading access…
          </div>
        ) : (
          <div className="access-list">
            {members.map((member) => (
              <div className="access-row" key={member.userId}>
                <span className="account-avatar small">
                  {(member.name || member.email).slice(0, 1).toUpperCase()}
                </span>
                <div className="access-person">
                  <strong>
                    {member.name || member.email}
                    {member.userId === account.user.id && <small> · you</small>}
                  </strong>
                  <span>{member.email}</span>
                </div>
                <span className="badge">
                  {member.role === "owner" ? "Owner" : "Manager"}
                </span>
                {owner && member.role === "manager" && (
                  <button
                    className="icon-button"
                    type="button"
                    disabled={busy}
                    aria-label={`Remove access for ${member.email}`}
                    title={`Remove access for ${member.email}`}
                    onClick={() => remove(member)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {owner && (
          <form onSubmit={grant} className="grant-access-form">
            <label className="field">
              <span>Add a manager</span>
              <input
                type="email"
                required
                value={managerEmail}
                onChange={(e) => setManagerEmail(e.target.value)}
                placeholder="Existing account email"
                autoComplete="off"
              />
              <small>The person must already have a RoleLoop account.</small>
            </label>
            <button className="button primary" disabled={busy}>
              <UserPlus size={16} />
              Grant access
            </button>
          </form>
        )}
      </section>
      {config.setupAvailable && (
        <section className="form-section">
          <div className="section-heading">
            <div>
              <h2>Claim the existing workspace</h2>
              <p>
                Your earlier local data is preserved until the installation
                owner claims it.
              </p>
            </div>
            <ShieldCheck size={22} />
          </div>
          <p className="setup-instructions">
            Run <code>npm run account:setup</code> in the project terminal. Open
            its setup link, or paste the key below.
          </p>
          <form onSubmit={claim} className="grant-access-form">
            <label className="field">
              <span>Local setup key</span>
              <input
                type="password"
                autoComplete="off"
                required
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy}>
              <KeyRound size={16} />
              Claim workspace
            </button>
          </form>
        </section>
      )}
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
      <div className="account-footer">
        <Mail size={16} />
        <span>
          Passwords and sessions are managed by Supabase Auth. Applications and
          outreach stay in local test mode.
        </span>
      </div>
    </section>
  );
}
