import type { Opportunity, Source } from "./types.js";

export const jobSourceLabels = {
  ashby: "Ashby",
  greenhouse: "Greenhouse",
  lever: "Lever",
  jobicy: "Jobicy",
  weworkremotely: "We Work Remotely",
  hackernews: "Hacker News",
  manual: "Manual entry",
  other: "Other sources",
} as const;

export type JobSourceProvider = keyof typeof jobSourceLabels;
export type JobSourceFilter = "all" | JobSourceProvider;

function provider(value: string): JobSourceProvider | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "manualentry") return "manual";
  return Object.hasOwn(jobSourceLabels, normalized)
    ? normalized as JobSourceProvider
    : undefined;
}

/** Saved provenance survives renamed or disconnected company sources. */
export function jobSourceProvider(
  opportunity: Opportunity,
  sources: readonly Source[],
): JobSourceProvider {
  return (
    provider(opportunity.sourceKey.split(":")[0]) ??
    provider(opportunity.source) ??
    sources.find((source) => source.id === opportunity.sourceId)?.provider ??
    "other"
  );
}

export function jobSourceOptions(
  opportunities: readonly Opportunity[],
  sources: readonly Source[],
): { value: JobSourceFilter; label: string }[] {
  const represented = new Set(
    opportunities
      .filter((opportunity) => opportunity.kind === "job")
      .map((opportunity) => jobSourceProvider(opportunity, sources)),
  );
  return [
    { value: "all", label: "All sources" },
    ...[...represented]
      .sort((a, b) => jobSourceLabels[a].localeCompare(jobSourceLabels[b]))
      .map((value) => ({ value, label: jobSourceLabels[value] })),
  ];
}

export function jobMatchesSource(
  opportunity: Opportunity,
  sources: readonly Source[],
  selected: JobSourceFilter,
): boolean {
  return selected === "all" || jobSourceProvider(opportunity, sources) === selected;
}
