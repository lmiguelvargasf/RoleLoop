import { Clock3, RefreshCw } from "lucide-react";
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
        <h2 id="automation-title">Local automation</h2>
        <p>Schedules run while RoleLoop is open.</p>
      </div>
      <div className="form-grid">
        <label className="checkbox-field wide">
          <input
            type="checkbox"
            checked={preferences.scheduleEnabled}
            disabled={busy}
            onChange={(e) => onChange("scheduleEnabled", e.target.checked)}
          />
          <span>Refresh discovery sources automatically</span>
        </label>
        <label className="field">
          <span>
            Refresh interval <small>minutes</small>
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
        </label>
        <div className="automation-status" role="status">
          {preferences.scheduleEnabled ? (
            <Clock3 size={15} aria-hidden="true" />
          ) : (
            <RefreshCw size={15} aria-hidden="true" />
          )}
          <div>
            <strong>
              {preferences.scheduleEnabled
                ? "Automatic refresh"
                : "Manual refresh"}
            </strong>
            <span>
              {preferences.scheduleEnabled
                ? `Every ${new Intl.NumberFormat().format(preferences.scheduleMinutes)} minutes across enabled sources.`
                : "Run discovery manually from Discovery sources."}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
