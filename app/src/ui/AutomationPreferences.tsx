import type { Preferences } from "../shared/types";

export function AutomationPreferences({
  preferences,
  onChange,
  busy,
}: {
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(
    key: K,
    value: Preferences[K],
  ) => void;
  busy: boolean;
}) {
  return (
    <section
      className="form-section automation-preferences"
      aria-labelledby="automation-title"
    >
      <div className="form-section-heading">
        <h2 id="automation-title">Automatic search</h2>
        <p>
          Find employers for your target roles and working country. Scheduled
          searches run while RoleLoop is running.
        </p>
      </div>
      <div className="form-grid">
        <label className="checkbox-field wide">
          <input
            type="checkbox"
            checked={preferences.discoverEmployers ?? true}
            disabled={busy}
            onChange={(e) => onChange("discoverEmployers", e.target.checked)}
          />
          <span>Find new companies automatically</span>
        </label>
        <label className="checkbox-field wide">
          <input
            type="checkbox"
            checked={preferences.scheduleEnabled}
            disabled={busy}
            onChange={(e) => onChange("scheduleEnabled", e.target.checked)}
          />
          <span>Check for new opportunities automatically</span>
        </label>
        <label className="field">
          <span>
            Check every <small>minutes</small>
          </span>
          <input
            type="number"
            name="scheduleMinutes"
            min="15"
            max="1440"
            required
            disabled={busy || !preferences.scheduleEnabled}
            value={preferences.scheduleMinutes}
            onChange={(e) => onChange("scheduleMinutes", +e.target.value)}
          />
        </label>
        <label className="field">
          <span>Daily draft limit</span>
          <input
            type="number"
            name="dailyLimit"
            min="1"
            max="100"
            required
            disabled={busy}
            value={preferences.dailyLimit}
            onChange={(e) => onChange("dailyLimit", +e.target.value)}
          />
          <small>Maximum new drafts per day.</small>
        </label>
      </div>
    </section>
  );
}
