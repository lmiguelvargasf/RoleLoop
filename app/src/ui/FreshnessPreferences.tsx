import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Preferences } from "../shared/types";
import { PolicySelect } from "./PolicySelect";

type FreshnessKey =
  | "lookback"
  | "lookbackUnit"
  | "dateMode"
  | "minimumMatch"
  | "essentialMatch";

const ages = [0, 7, 14, 30, 90];
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
  const { lookback, lookbackUnit, dateMode, minimumMatch, essentialMatch } =
    preferences;
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
        <h2>Freshness & fit</h2>
        <p>Prioritize recent opportunities that fit your experience.</p>
      </div>
      <div className="freshness-preferences">
        <div className="freshness-controls">
          <div className="freshness-age">
            <PolicySelect
              label="Opportunity age"
              value={selectedAge}
              onChange={changeAge}
              hint="Uses the original posting or signal date."
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
                <label htmlFor={`${id}-days`}>Maximum age</label>
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
                label: "Keep, but prioritize recent",
                description: "Older opportunities can still qualify as a match.",
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
        <details className="matching-details">
          <summary>
            <span className="matching-details-label">
              <ChevronDown size={15} aria-hidden="true" />
              Fine-tune matching
            </span>
            <span className="matching-details-values">
              {minimumMatch}% overall <span aria-hidden="true">·</span>{" "}
              {essentialMatch}% must-have
            </span>
          </summary>
          <div className="matching-settings">
            {([
              ["minimumMatch", "Overall match", minimumMatch],
              ["essentialMatch", "Must-have requirements", essentialMatch],
            ] as const).map(([key, label, value]) => (
              <div className="matching-field" key={key}>
                <label htmlFor={`${id}-${key}`}>{label}</label>
                <div className="preference-number-input">
                  <input
                    id={`${id}-${key}`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="100"
                    step="any"
                    value={value}
                    aria-describedby={`${id}-matching-hint`}
                    onChange={(event) => onChange(key, +event.target.value)}
                    onInvalid={(event) => {
                      event.currentTarget.closest("details")!.open = true;
                    }}
                  />
                  <span aria-hidden="true">%</span>
                </div>
              </div>
            ))}
            <p className="preference-hint matching-hint" id={`${id}-matching-hint`}>
              Minimum coverage from your verified experience. Jobs below either
              minimum need review. Startups are assessed separately.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
