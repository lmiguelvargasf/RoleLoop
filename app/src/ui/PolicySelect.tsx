import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

type PolicyOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export function PolicySelect<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: PolicyOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.find((option) => option.value === value)!;
  const description = hint ?? selected.description;

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
      className="policy-select"
      ref={root}
      onKeyDown={handleKey}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="policy-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="policy-anchor">
        <button
          type="button"
          className="policy-trigger"
          ref={trigger}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          aria-labelledby={`${id}-label ${id}-value`}
          aria-describedby={description ? `${id}-hint` : undefined}
          onClick={() => (open ? setOpen(false) : showMenu())}
        >
          <span id={`${id}-value`}>{selected.label}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {open && (
          <div
            className={`policy-menu${above ? " above" : ""}`}
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
                aria-describedby={
                  option.description ? `${id}-${option.value}-hint` : undefined
                }
                tabIndex={index === activeIndex ? 0 : -1}
                ref={(element) => {
                  items.current[index] = element;
                }}
                key={option.value}
                onClick={() => select(option.value)}
              >
                <span className="policy-check" aria-hidden="true">
                  {option.value === value && <Check size={15} />}
                </span>
                <span>
                  <strong id={`${id}-${option.value}-label`}>
                    {option.label}
                  </strong>
                  {option.description && (
                    <span id={`${id}-${option.value}-hint`}>
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {description && (
        <p className="policy-hint" id={`${id}-hint`}>
          {description}
        </p>
      )}
    </div>
  );
}

