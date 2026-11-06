import { useId } from "react";
import { PolicySelect } from "./PolicySelect";
import { salaryReviewMinimum } from "../shared/salary";
import type { Preferences } from "../shared/types";

type PolicyKey = "salaryPolicy" | "missingSalary" | "salaryFlexibility";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function SalaryPolicies({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: <K extends PolicyKey>(key: K, value: Preferences[K]) => void;
}) {
  const id = useId();
  const { minimumSalary, salaryPolicy, salaryFlexibility, missingSalary } =
    preferences;
  const reviewMinimum = salaryReviewMinimum(minimumSalary);
  const minimum = salaryFlexibility ? reviewMinimum : minimumSalary;
  const threshold = currency.format(minimum);
  const allowance = salaryFlexibility ? " with your 10% allowance" : "";

  return (
    <div className="salary-policies">
      <PolicySelect
        label="Salary range policy"
        value={salaryPolicy}
        onChange={(value) => onChange("salaryPolicy", value)}
        options={[
          {
            value: "overlap",
            label: "Allow a lower starting salary",
            description:
              `Keep jobs whose range reaches ${threshold}/year${allowance}. If the range also includes less than your minimum, mark the job Needs review so you can confirm the pay.`,
          },
          {
            value: "strict",
            label: "Require my minimum as starting pay",
            description:
              `The range must start at ${threshold}/year or higher${allowance}. Otherwise, exclude the job.`,
          },
        ]}
      />
      <PolicySelect
        label="When salary is missing"
        value={missingSalary}
        onChange={(value) => onChange("missingSalary", value)}
        options={[
          {
            value: "review",
            label: "Keep for review",
            description:
              "Mark the job as Needs review so you can check the pay before proceeding.",
          },
          {
            value: "exclude",
            label: "Exclude jobs with no salary",
            description:
              "Mark jobs with no listed salary as excluded from your matches.",
          },
        ]}
      />
      <div className="salary-flexibility">
        <label className="salary-flexibility-control">
          <span>
            <strong>Allow 10% below my minimum</strong>
            <span id={`${id}-flexibility-description`}>
              Keep slightly lower-paying jobs for review so you can compare
              benefits.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={salaryFlexibility}
            onChange={(event) =>
              onChange("salaryFlexibility", event.target.checked)
            }
            aria-label="Allow 10% below my minimum"
            aria-describedby={`${id}-flexibility-description`}
          />
        </label>
        {salaryFlexibility && (
          <p className="salary-flexibility-summary" role="status">
            Review pay down to{" "}
            <strong>{currency.format(reviewMinimum)}/year</strong>
            <span> · {currency.format(reviewMinimum / 12)}/month</span>
          </p>
        )}
      </div>
    </div>
  );
}
