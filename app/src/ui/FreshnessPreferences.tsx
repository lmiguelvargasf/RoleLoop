import { useId, useState } from "react";
import type { Preferences } from "../shared/types";
import { PolicySelect } from "./PolicySelect";

type FreshnessKey = "lookback" | "lookbackUnit" | "dateMode";

const ages = [0, 7, 14, 30];
const ageLabel = (days: number) =>
  days === 0 ? "Today only" : `Up to ${days} ${days === 1 ? "day" : "days"} old`;

export function FreshnessPreferences({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: <K extends FreshnessKey>(key: K, value: Preferences[K]) => void;
}) {
  const id = useId();
  const { lookback, lookbackUnit, dateMode } = preferences;
  const [customAge, setCustomAge] = useState(
    lookbackUnit === "days" && !ages.includes(lookback),
  );
  const legacyMonths = lookbackUnit === "months";
  const selectedAge = legacyMonths
    ? "saved"
    : customAge
      ? "custom"
      : `${lookback}`;

  function changeAge(value: string) {
    if (value === "saved") return;
    setCustomAge(value === "custom");
    onChange("lookbackUnit", "days");
    onChange(
      "lookback",
      value === "custom" ? (legacyMonths ? 30 : lookback) : Number(value),
    );
  }

  return (
    <section className="form-section">
      <div className="form-section-heading">
        <h2>Opportunity age</h2>
        <p>Choose how recent opportunities should be.</p>
      </div>
      <div className="freshness-preferences">
        <div className="freshness-controls">
          <div className="freshness-age">
            <PolicySelect
              label="Preferred age"
              value={selectedAge}
              onChange={changeAge}
              hint="Uses the job posting date or startup update date."
              options={[
                ...(legacyMonths
                  ? [
                      {
                        value: "saved",
                        label:
                          lookback === 0
                            ? "Today only"
                            : `Up to ${lookback} ${lookback === 1 ? "month" : "months"} old`,
                      },
                    ]
                  : []),
                ...ages.map((days) => ({
                  value: `${days}`,
                  label: ageLabel(days),
                })),
                {
                  value: "custom",
                  label: "Custom age",
                },
              ]}
            />
            {customAge && !legacyMonths && (
              <div className="freshness-custom-age">
                <label htmlFor={`${id}-days`}>Days to look back</label>
                <div className="preference-number-input">
                  <input
                    id={`${id}-days`}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="365"
                    required
                    value={lookback}
                    aria-describedby={`${id}-days-hint`}
                    onChange={(event) =>
                      onChange("lookback", +event.target.value)
                    }
                  />
                  <span aria-hidden="true">days</span>
                </div>
                <p className="preference-hint" id={`${id}-days-hint`}>
                  Use 0 for today only.
                </p>
              </div>
            )}
          </div>
          <PolicySelect
            label="Older opportunities"
            value={dateMode}
            onChange={(value) => onChange("dateMode", value)}
            options={[
              {
                value: "emphasize",
                label: "Keep older opportunities",
                description: "Give recent opportunities priority in your results.",
              },
              {
                value: "strict",
                label: "Exclude older opportunities",
                description:
                  "Mark opportunities beyond your selected age as excluded.",
              },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
