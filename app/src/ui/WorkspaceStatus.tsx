import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { ApiError } from "./api";

export function serverUnavailable(error: Error) {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && [502, 504].includes(error.status))
  );
}

export function WorkspaceStatus({
  failure,
  onRetry,
}: {
  failure: Error | null;
  onRetry: () => void;
}) {
  const unavailable = failure && serverUnavailable(failure);
  return (
    <main className="connection-screen">
      <div className="brand">
        <span className="brand-mark" />
        RoleLoop<span className="brand-period">.</span>
      </div>
      <div className="connection-content" aria-live="polite">
        {failure ? (
          <AlertTriangle size={32} />
        ) : (
          <LoaderCircle className="spin" size={32} />
        )}
        <h1>
          {failure
            ? unavailable
              ? "RoleLoop is unavailable."
              : "Couldn’t load your workspace."
            : "Opening your workspace…"}
        </h1>
        <p>
          {failure
            ? unavailable
              ? "Cannot reach the local server."
              : "The server responded, but couldn’t load your workspace."
            : "Connecting to your local database."}
        </p>
        {failure && (
          <>
            <p className="muted">
              {unavailable ? (
                <>
                  Start RoleLoop with <code>npm run dev</code>, then try again.
                </>
              ) : (
                "Try again. If this continues, restart RoleLoop."
              )}
            </p>
            <details className="connection-details">
              <summary>Technical details</summary>
              <p>{failure.message}</p>
            </details>
            <button className="button primary" onClick={onRetry}>
              <RefreshCw size={16} />
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
