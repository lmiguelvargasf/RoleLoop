import { useId, useState } from "react";
import type { Preferences } from "../shared/types";

export function MatchingPreferences({
  preferences,
  onChange,
  disabled,
}: {
  preferences: Preferences;
  onChange: (key: "essentialMatch", value: number) => void;
  disabled: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(String(preferences.essentialMatch));

  return (
    <section className="form-section">
      <div className="form-section-heading">
        <h2>Job matching</h2>
        <p>Compare required qualifications with your verified experience.</p>
      </div>
      <div className="matching-preferences">
        <label htmlFor={`${id}-minimum`}>Minimum match</label>
        <div className="preference-number-input">
          <input
            id={`${id}-minimum`}
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="any"
            required
            aria-label="Minimum match (%)"
            aria-describedby={`${id}-hint`}
            disabled={disabled}
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              setValue(next);
              if (next !== "" && Number.isFinite(Number(next)))
                onChange("essentialMatch", Number(next));
            }}
          />
          <span aria-hidden="true">%</span>
        </div>
        <p className="preference-hint" id={`${id}-hint`}>
          Recommended prioritizes jobs meeting this minimum. Other jobs stay in
          All saved for review.
        </p>
      </div>
    </section>
  );
}
