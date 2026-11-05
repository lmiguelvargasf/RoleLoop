import { useId, useState } from "react";

type SalaryPeriod = "annual" | "monthly";
type SalaryKey = "minimumSalary" | "targetSalary";
type Salaries = Record<SalaryKey, number>;

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
}: Salaries & { onChange: (key: SalaryKey, annual: number) => void }) {
  const id = useId();
  const [period, setPeriod] = useState<SalaryPeriod>("annual");
  const [amounts, setAmounts] = useState({
    minimumSalary: String(minimumSalary),
    targetSalary: String(targetSalary),
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
        amounts.targetSalary === "" ? "" : editableAmount(targetSalary, next),
    });
    setPeriod(next);
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
      {(["minimumSalary", "targetSalary"] as const).map((key) => {
        const label = key === "minimumSalary" ? "Minimum" : "Target";
        const annual = salaries[key];
        const equivalent = period === "annual" ? annual / 12 : annual;
        const valid = amounts[key] !== "" && Number(amounts[key]) >= 0;
        const fieldId = `${id}-${key}`;
        return (
          <div className="salary-field" key={key}>
            <label className="field" htmlFor={fieldId}>
              <span>
                {label} {period} salary
              </span>
              <span className="salary-input">
                <span aria-hidden="true">$</span>
                <input
                  id={fieldId}
                  type="number"
                  inputMode="decimal"
                  required
                  min="0"
                  step="0.01"
                  aria-label={`${label} ${period} salary (USD)`}
                  aria-describedby={`${fieldId}-equivalent`}
                  value={amounts[key]}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setAmounts((current) => ({ ...current, [key]: raw }));
                    if (raw !== "" && Number.isFinite(Number(raw))) {
                      const annual =
                        Number(raw) * (period === "monthly" ? 12 : 1);
                      onChange(
                        key,
                        Math.round((annual + Number.EPSILON) * 100) / 100,
                      );
                    }
                  }}
                />
                <span aria-hidden="true">/ {unit}</span>
              </span>
            </label>
            <div className="salary-equivalent" id={`${fieldId}-equivalent`}>
              <span>{otherPeriod} equivalent</span>
              <output htmlFor={fieldId} aria-live="off">
                {valid ? currency.format(equivalent) : "—"}
                <span> / {otherUnit}</span>
              </output>
            </div>
          </div>
        );
      })}
    </>
  );
}
