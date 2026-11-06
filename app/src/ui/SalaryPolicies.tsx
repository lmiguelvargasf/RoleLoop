import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { salaryReviewMinimum } from "../shared/salary";
import type { Preferences } from "../shared/types";

type PolicyKey = "salaryPolicy" | "missingSalary" | "salaryFlexibility";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

type PolicyOption<T extends string> = {
  value: T;
  label: string;
  description: string;
};

function PolicySelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: PolicyOption<T>[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.find((option) => option.value === value)!;

  useEffect(() => {
    if (!open) return;
    items.current[activeIndex]?.focus({ preventScroll: true });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function showMenu() {
    const bounds = trigger.current!.getBoundingClientRect();
    setAbove(innerHeight - bounds.bottom < 260 && bounds.top > 260);
    setActiveIndex(options.findIndex((option) => option.value === value));
    setOpen(true);
  }

  function select(next: T) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) showMenu();
      else
        setActiveIndex(
          (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length,
        );
    } else if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
    }
  }

  return (
    <div
      className="salary-policy-select"
      ref={root}
      onKeyDown={handleKey}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="salary-policy-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="salary-policy-anchor">
        <button
          type="button"
          className="salary-policy-trigger"
          ref={trigger}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          aria-labelledby={`${id}-label ${id}-value`}
          aria-describedby={`${id}-hint`}
          onClick={() => (open ? setOpen(false) : showMenu())}
        >
          <span id={`${id}-value`}>{selected.label}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {open && (
          <div
            className={`salary-policy-menu${above ? " above" : ""}`}
            role="listbox"
            id={`${id}-options`}
            aria-labelledby={`${id}-label`}
          >
            {options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                aria-labelledby={`${id}-${option.value}-label`}
                aria-describedby={`${id}-${option.value}-hint`}
                tabIndex={index === activeIndex ? 0 : -1}
                ref={(element) => {
                  items.current[index] = element;
                }}
                key={option.value}
                onClick={() => select(option.value)}
              >
                <span className="salary-policy-check" aria-hidden="true">
                  {option.value === value && <Check size={15} />}
                </span>
                <span>
                  <strong id={`${id}-${option.value}-label`}>
                    {option.label}
                  </strong>
                  <span id={`${id}-${option.value}-hint`}>
                    {option.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="salary-policy-hint" id={`${id}-hint`}>
        {selected.description}
      </p>
    </div>
  );
}

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
              `The range must still reach ${threshold}/year${allowance}. Starting below your minimum means review.`,
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
            label: "Keep and flag for review",
            description:
              "Mark the job as Needs review so you can check the pay before proceeding.",
          },
          {
            value: "include",
            label: "Keep without a salary check",
            description:
              "The job can be Ready to draft even if pay is unknown, as long as other checks pass.",
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
