import { useId, useState } from "react";
import {
  Bot,
  BriefcaseBusiness,
  Building2,
  Car,
  ChevronDown,
  Clapperboard,
  Cloud,
  Code2,
  Database,
  Dna,
  Factory,
  Globe2,
  GraduationCap,
  HeartPulse,
  Leaf,
  Plane,
  Rocket,
  Scale,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Tag,
  Truck,
  WalletCards,
  Wheat,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Preferences } from "../shared/types";
import { industryCatalog, industryKey } from "../shared/industries";

const icons: Record<(typeof industryCatalog)[number], LucideIcon> = {
  AI: Sparkles,
  "Developer tools": Code2,
  "B2B software": BriefcaseBusiness,
  SaaS: Cloud,
  Legaltech: Scale,
  Fintech: WalletCards,
  Climate: Leaf,
  Healthcare: HeartPulse,
  Ecommerce: ShoppingBag,
  Education: GraduationCap,
  Cybersecurity: ShieldCheck,
  "Consumer apps": Smartphone,
  "Data infrastructure": Database,
  Robotics: Bot,
  "Space technology": Rocket,
  Energy: Zap,
  Biotech: Dna,
  Logistics: Truck,
  Manufacturing: Factory,
  Mobility: Car,
  "Real estate": Building2,
  "Media & entertainment": Clapperboard,
  "Travel & hospitality": Plane,
  "Food & agriculture": Wheat,
};
const catalog = industryCatalog.map((title) => ({ title, icon: icons[title] }));
const catalogKeys = new Set(industryCatalog.map(industryKey));
type IndustryPreferences = Pick<
  Preferences,
  "industries" | "industryPreference" | "topIndustries"
>;
type Priority = "open" | "interested" | "top";

export function IndustryInterests({
  industries,
  industryPreference = "prefer",
  topIndustries = [],
  onChange,
  disabled,
}: IndustryPreferences & {
  onChange: (preferences: IndustryPreferences) => void;
  disabled: boolean;
}) {
  const id = useId();
  const selected = new Set(industries.map(industryKey));
  const top = new Set(topIndustries.map(industryKey));
  const topCount = [...selected].filter((key) => top.has(key)).length;
  const [savedLegacy] = useState(() =>
    industries.filter((title) => !catalogKeys.has(industryKey(title))),
  );
  const [moreOpen, setMoreOpen] = useState(() =>
    catalog.slice(12).some(({ title }) => selected.has(industryKey(title))),
  );
  const legacy = [
    ...new Map(
      [...savedLegacy, ...industries]
        .filter((title) => !catalogKeys.has(industryKey(title)))
        .map((title) => [industryKey(title), title]),
    ).values(),
  ];

  function setPriority(title: string, priority: Priority) {
    const key = industryKey(title);
    const remaining = industries.filter((value) => industryKey(value) !== key);
    const remainingTop = topIndustries.filter(
      (value) => industryKey(value) !== key,
    );
    onChange({
      industries:
        priority === "open"
          ? remaining
          : selected.has(key)
            ? industries
            : [...industries, title],
      topIndustries:
        priority === "top" ? [...remainingTop, title] : remainingTop,
      industryPreference,
    });
  }

  function rows(options: { title: string; icon: LucideIcon }[]) {
    return (
      <div className="industry-directory">
        {options.map(({ title, icon: Icon }) => {
          const key = industryKey(title);
          const priority = selected.has(key)
            ? top.has(key)
              ? "top"
              : "interested"
            : "open";
          return (
            <div className={`industry-row is-${priority}`} key={key}>
              <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
              <span className="industry-name">{title}</span>
              <span className="industry-level">
                <select
                  aria-label={`${title} priority`}
                  aria-describedby={`${id}-levels`}
                  value={priority}
                  disabled={disabled}
                  onChange={(event) =>
                    setPriority(title, event.target.value as Priority)
                  }
                >
                  <option value="open">No boost</option>
                  <option value="interested">Interested</option>
                  <option value="top">Top priority</option>
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="industry-preferences">
      <fieldset className="industry-ranking" aria-describedby={`${id}-scope`}>
        <legend>How should industries affect your results?</legend>
        <div className="industry-ranking-options">
          {[
            {
              value: "any",
              title: "No industry preference",
              description: "Industries don’t affect the order of results.",
            },
            {
              value: "prefer",
              title: "Prioritize selected industries",
              description:
                "Give your preferred industries a modest ranking boost.",
            },
          ].map(({ value, title, description }) => (
            <label className="industry-ranking-option" key={value}>
              <input
                type="radio"
                name={`${id}-ranking`}
                value={value}
                checked={industryPreference === value}
                disabled={disabled}
                onChange={() =>
                  onChange({
                    industries,
                    topIndustries,
                    industryPreference:
                      value as IndustryPreferences["industryPreference"],
                  })
                }
              />
              <span className="industry-ranking-content">
                <strong>{title}</strong>
                <span>{description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="industry-scope-note" id={`${id}-scope`}>
        <Globe2 size={16} strokeWidth={1.5} aria-hidden="true" />
        <span>
          Both options include every industry, including emerging sectors.
          Priorities only affect ranking.
        </span>
      </p>

      {industryPreference === "prefer" && (
        <>
          <div className="industry-selection-heading">
            <span>Set your priorities</span>
            <span aria-live="polite">
              {topCount} top priority · {selected.size - topCount} interested
            </span>
          </div>
          <p className="industry-level-guide" id={`${id}-levels`}>
            Top priority gets the most emphasis, then Interested. No boost keeps
            the usual fit ranking.
          </p>
          {rows(catalog.slice(0, 12))}
          <details
            className="industry-more"
            open={moreOpen}
            onToggle={(event) => setMoreOpen(event.currentTarget.open)}
          >
            <summary>
              Explore more industries <span>12 more</span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            {rows(catalog.slice(12))}
          </details>
          {legacy.length > 0 && (
            <div className="industry-legacy">
              <h4>Previously saved interests</h4>
              {rows(legacy.map((title) => ({ title, icon: Tag })))}
            </div>
          )}
          <p className="industry-priority-note">
            Priorities give a modest boost in both job and startup lists. A
            stronger fit in any other industry can still rank higher.
          </p>
        </>
      )}
    </div>
  );
}
