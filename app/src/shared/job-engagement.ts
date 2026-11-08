/** Explicit engagement facts from the posting, without assuming employment,
 * guaranteed hours, project availability, or an annualized contract income. */
export type JobEngagement = {
  kind: "full_time" | "part_time" | "contract" | "unknown";
  label: string;
  hoursPerWeek: { min: number; max: number } | null;
  hoursLabel: string | null;
  contract: boolean;
};

export function jobEngagement(job: {
  title: string;
  description: string;
}): JobEngagement {
  const lines = `${job.title}\n${job.description}`
    .replace(/[’‘]/g, "'")
    .split(/[\n|]|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^(?:#+\s*|[-*•]\s+)/, "").trim())
    .filter(Boolean);
  const explicitType = (type: string) => {
    const pattern = new RegExp(
      `^(?:(?:employment|engagement|job|position|work) (?:type|arrangement)\\s*:?\\s*|type\\s*:\\s*)?${type}(?:\\s*[-–—,.(:]|$)|\\b${type}\\s+(?:role|position|employment|engagement|job|contract)\\b|\\b(?:this (?:is|will be)|(?:the|this) (?:role|position|job) is)\\s+(?:an?\\s+)?${type}\\b`,
      "gi",
    );
    const stated = lines.some((line) =>
      [...line.matchAll(pattern)].some(
        (match) =>
          !/\b(?:not|isn't|aren't|never)\s+(?:an?\s+)?$/i.test(
            line.slice(0, match.index),
          ),
      ),
    );
    const titleType = type.startsWith("contract")
      ? /(?:[-–—|,(]\s*contract(?:or)?\s*[),]?\s*$)|^contract\s+(?:software|senior|staff|backend|frontend|full[- ]?stack|engineer|developer|designer)\b/i.test(
          job.title,
        )
      : new RegExp(`\\b${type}\\b`, "i").test(job.title);
    return stated || titleType;
  };
  const contract =
    explicitType("contract(?:or)?") ||
    lines.some(
      (line) =>
        /\b(?:contractor|contract) basis\b/i.test(line) &&
        /\b(?:role|position|join|work|engage|hire)\b/i.test(line),
    );
  const fullTime = explicitType("full[- ]time");
  const partTime = explicitType("part[- ]time");
  const ranges = new Map<string, { min: number; max: number }>();
  for (const line of lines) {
    if (
      /\b(?:customers?|clients?|support coverage|service availability|office opening)\b/i.test(
        line,
      )
    )
      continue;
    for (const match of line.matchAll(
      /(?<![\d.])(?<min>\d{1,3}(?:\.\d+)?)\s*(?:(?:[-–—]|to)\s*(?<max>\d{1,3}(?:\.\d+)?)\s*)?(?:hrs?|hours?)\s*(?:\/\s*|per\s+|a\s+)(?:week|wk)\b/gi,
    )) {
      const min = Number(match.groups!.min);
      const max = Number(match.groups!.max ?? min);
      if (min <= 0 || max < min || max > 168) continue;
      // "Up to 20" does not establish a lower bound or guaranteed work.
      if (
        /\b(?:up to|under|less than|at least|minimum(?: of)?|more than)\s*$/i.test(
          line.slice(0, match.index),
        )
      )
        continue;
      ranges.set(`${min}:${max}`, { min, max });
    }
  }
  const hoursPerWeek = ranges.size === 1 ? [...ranges.values()][0] : null;
  const hoursLabel = hoursPerWeek
    ? `${hoursPerWeek.min === hoursPerWeek.max ? hoursPerWeek.min : `${hoursPerWeek.min}–${hoursPerWeek.max}`} h/week`
    : null;
  const commitment =
    fullTime === partTime ? null : fullTime ? "Full-time" : "Part-time";
  const kind = contract
    ? "contract"
    : commitment === "Full-time"
      ? "full_time"
      : commitment === "Part-time"
        ? "part_time"
        : "unknown";
  return {
    kind,
    label: contract
      ? commitment
        ? `${commitment} contract`
        : "Contract"
      : (commitment ?? "Employment type not stated"),
    hoursPerWeek,
    hoursLabel,
    contract,
  };
}
