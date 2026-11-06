import { useId } from "react";
import type { Preferences } from "../shared/types";

type MatchKey = "minimumMatch" | "essentialMatch";

const fields = [
  {
    key: "minimumMatch",
    label: "Minimum overall match",
    hint: "Includes required and preferred qualifications.",
  },
  {
    key: "essentialMatch",
    label: "Minimum match for required qualifications",
    hint: "Focuses on the job’s must-have requirements only.",
  },
] as const;

export function MatchingPreferences({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: <K extends MatchKey>(key: K, value: Preferences[K]) => void;
}) {
  const id = useId();

  return (
    <section className="form-section">
      <div className="form-section-heading">
        <h2>Job matching</h2>
        <p>Set how closely a job should match your verified experience.</p>
        <p>Startup prospects are assessed separately.</p>
      </div>
      <div className="matching-settings">
        {fields.map(({ key, label, hint }) => (
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
                aria-label={`${label} (%)`}
                value={preferences[key]}
                aria-describedby={`${id}-${key}-hint ${id}-outcome`}
                onChange={(event) => onChange(key, +event.target.value)}
              />
              <span aria-hidden="true">%</span>
            </div>
            <p className="preference-hint" id={`${id}-${key}-hint`}>
              {hint}
            </p>
          </div>
        ))}
        <p className="matching-outcome" id={`${id}-outcome`}>
          Jobs below either minimum are marked <strong>Needs review</strong>.
        </p>
      </div>
    </section>
  );
}
