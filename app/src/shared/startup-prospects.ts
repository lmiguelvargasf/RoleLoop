import { isTrackedOutreach } from "./outreach-board.js";
import type { Opportunity } from "./types.js";

export type StartupView = "explore" | "all" | "archived";
export type StartupSourceFilter = string;

export function startupMatchesView(
  opportunity: Opportunity,
  view: StartupView,
): boolean {
  if (opportunity.kind !== "startup") return false;
  if (view === "archived") return opportunity.stage === "archived";
  if (opportunity.stage === "archived") return false;
  if (view === "explore") return !isTrackedOutreach(opportunity);
  return view === "all";
}

function sourceKey(source: string): string {
  const normalized = source.trim().toLowerCase().replace(/\s+/g, " ");
  if (["hackernews", "hacker news", "show hn"].includes(normalized))
    return "hackernews";
  if (["manual", "manual entry"].includes(normalized)) return "manual";
  return normalized;
}

function sources(opportunity: Opportunity): string[] {
  return [
    ...new Set(
      [
        ...(opportunity.discoverySignals ?? []).map((signal) => signal.source),
        opportunity.source,
      ]
        .map(sourceKey)
        .filter(Boolean),
    ),
  ];
}

function sourceLabel(source: string): string {
  if (source === "hackernews") return "Show HN";
  if (source === "seedcamp") return "Seedcamp";
  if (source === "manual") return "Added previously";
  return source
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function startupSourceOptions(
  opportunities: readonly Opportunity[],
): { value: StartupSourceFilter; label: string }[] {
  const represented = new Set(
    opportunities
      .filter((opportunity) => opportunity.kind === "startup")
      .flatMap(sources),
  );
  return [
    { value: "all", label: "All sources" },
    ...[...represented]
      .filter((source) => source !== "all")
      .map((value) => ({ value, label: sourceLabel(value) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

export function startupMatchesSource(
  opportunity: Opportunity,
  selected: StartupSourceFilter,
): boolean {
  return (
    selected === "all" || sources(opportunity).includes(sourceKey(selected))
  );
}

export function startupSourceLabels(opportunity: Opportunity): string[] {
  return sources(opportunity).map(sourceLabel);
}

export function startupMatchesQuery(
  opportunity: Opportunity,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searchable = [
    opportunity.company,
    opportunity.title,
    opportunity.description,
    opportunity.location,
    opportunity.companyCountry,
    opportunity.assessment?.fitSummary ?? "",
    ...opportunity.signals,
    ...opportunity.requirements.flatMap((requirement) => [
      requirement.text,
      ...requirement.skills,
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => searchable.includes(term));
}
