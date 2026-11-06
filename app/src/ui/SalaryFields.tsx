import { useId, useRef, useState } from "react";
import type { Preferences } from "../shared/types";

type SalaryPeriod = "annual" | "monthly";
type SalaryKey = "minimumSalary" | "targetSalary";
type Salaries = Pick<Preferences, SalaryKey>;

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function editableAmount(annual: number, period: SalaryPeriod) {
  return String(Number((period === "annual" ? annual : annual / 12).toFixed(2)));
}

export function SalaryFields({
  minimumSalary,
  targetSalary,
  onChange,
}: Salaries & {
  onChange: <K extends SalaryKey>(key: K, annual: Preferences[K]) => void;
}) {
  const id = useId();
  const [period, setPeriod] = useState<SalaryPeriod>("annual");
  const [showTarget, setShowTarget] = useState(targetSalary !== null);
  const addTargetButton = useRef<HTMLButtonElement>(null);
  const [amounts, setAmounts] = useState({
    minimumSalary: String(minimumSalary),
    targetSalary: targetSalary === null ? "" : String(targetSalary),
  });
  const salaries = { minimumSalary, targetSalary };
  const otherPeriod = period === "annual" ? "Monthly" : "Annual";
  const unit = period === "annual" ? "year" : "month";
  const otherUnit = period === "annual" ? "month" : "year";

  function changePeriod(next: SalaryPeriod) {
    if (next === period) return;
    // Switching is display-only: never write a rounded monthly equivalent back.
    setAmounts({
      minimumSalary:
        amounts.minimumSalary === "" ? "" : editableAmount(minimumSalary, next),
      targetSalary:
        amounts.targetSalary === "" || targetSalary === null
          ? ""
          : editableAmount(targetSalary, next),
    });
    setPeriod(next);
  }

  function removeTarget() {
    onChange("targetSalary", null);
    setAmounts((current) => ({ ...current, targetSalary: "" }));
    setShowTarget(false);
    requestAnimationFrame(() => addTargetButton.current?.focus());
  }

  function salaryField(key: SalaryKey) {
    const isMinimum = key === "minimumSalary";
    const label = isMinimum
      ? `Minimum acceptable ${period} salary`
      : `Target ${period} salary (optional)`;
    const annual = salaries[key];
    const equivalent =
      annual === null ? null : period === "annual" ? annual / 12 : annual;
    const valid =
      amounts[key] !== "" &&
      Number.isFinite(Number(amounts[key])) &&
      Number(amounts[key]) >= 0;
    const fieldId = `${id}-${key}`;
    return (
      <div className="salary-field" id={`${fieldId}-field`}>
        <div className="salary-field-heading">
          <label htmlFor={fieldId}>{label}</label>
          {!isMinimum && (
            <button
              type="button"
              className="text-button"
              onClick={removeTarget}
              aria-label="Remove target salary"
            >
              Remove
            </button>
          )}
        </div>
        <div className="salary-input">
          <span aria-hidden="true">$</span>
          <input
            id={fieldId}
            type="number"
            inputMode="decimal"
            required={isMinimum}
            min={isMinimum ? 0 : editableAmount(minimumSalary, period)}
            step="0.01"
            aria-label={`${label} (USD)`}
            aria-describedby={`${fieldId}-hint ${fieldId}-equivalent`}
            autoFocus={!isMinimum && targetSalary === null}
            value={amounts[key]}
            onChange={(event) => {
              const raw = event.target.value;
              setAmounts((current) => ({ ...current, [key]: raw }));
              if (raw === "" && !isMinimum) {
                onChange("targetSalary", null);
              } else if (raw !== "" && Number.isFinite(Number(raw))) {
                const annual = Number(raw) * (period === "monthly" ? 12 : 1);
                onChange(
                  key,
                  Math.round((annual + Number.EPSILON) * 100) / 100,
                );
              }
            }}
          />
          <span aria-hidden="true">/ {unit}</span>
        </div>
        <div className="salary-equivalent" id={`${fieldId}-equivalent`}>
          <span>{otherPeriod} equivalent</span>
          <output htmlFor={fieldId} aria-live="off">
            {valid && equivalent !== null ? currency.format(equivalent) : "—"}
            <span> / {otherUnit}</span>
          </output>
        </div>
        <p className="salary-hint" id={`${fieldId}-hint`}>
          {isMinimum
            ? "No upper limit. Higher-paying roles are always welcome."
            : "Guides salary-expectation answers. It never limits your matches."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="salary-toolbar">
        <fieldset className="salary-period">
          <legend>Edit amounts</legend>
          <div className="salary-period-options">
            {(["annual", "monthly"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${id}-salary-period`}
                  value={value}
                  checked={period === value}
                  onChange={() => changePeriod(value)}
                />
                <span>{value === "annual" ? "Annually" : "Monthly"}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <span className="salary-conversion-note">12 months per year · USD</span>
      </div>
      <div className="salary-fields">
        {salaryField("minimumSalary")}
        {showTarget ? (
          salaryField("targetSalary")
        ) : (
          <div className="salary-target-option">
            <button
              ref={addTargetButton}
              type="button"
              className="text-button"
              onClick={() => setShowTarget(true)}
            >
              Add a target salary
            </button>
            <p className="salary-hint">
              Optional. Use it to guide salary-expectation answers.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
