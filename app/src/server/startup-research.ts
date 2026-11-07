import { research } from "../domain/connectors.js";
import { isDeepStrictEqual } from "node:util";
import { OpportunitySchema, type Opportunity } from "../shared/types.js";
import type { WorkspaceStore } from "./store.js";

export const STARTUP_RESEARCH_LIMIT = 10;
const DAY = 24 * 60 * 60 * 1000;
export type ResearchCache = { at: number; url: string; error?: string };
type ResearchStore = Pick<
  WorkspaceStore,
  "runtime" | "setRuntime" | "saveDerivedOpportunity"
>;

/** Save public research against the exact record read before the request. */
export async function researchAndSaveOpportunity(
  store: ResearchStore,
  opportunity: Opportunity,
  options: { force?: boolean; read?: typeof research; now?: number } = {},
): Promise<{ opportunity: Opportunity; researched: boolean }> {
  const url =
    opportunity.kind === "job"
      ? opportunity.url
      : opportunity.companyUrl || opportunity.url;
  const key = `company-research:${opportunity.id}`;
  const now = options.now ?? Date.now();
  const cached = await store.runtime<ResearchCache>(key);
  if (!options.force && cached?.url === url && now >= cached.at) {
    if (cached.error && now - cached.at < DAY / 24)
      throw new Error(cached.error);
    if (!cached.error && now - cached.at < 7 * DAY)
      return { opportunity, researched: false };
  }
  let facts: Partial<Opportunity>;
  try {
    facts = await (options.read ?? research)(opportunity);
    if (!facts.description?.trim())
      throw new Error(
        "The company website did not provide readable research. The saved description was kept.",
      );
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "Website research failed."
    ).slice(0, 300);
    await store.setRuntime(key, { at: now, url, error: message });
    throw new Error(message);
  }
  const corrections = await store.runtime<Partial<Opportunity>>(
    `corrections:${opportunity.id}`,
  );
  const next = OpportunitySchema.parse({
    ...opportunity,
    ...facts,
    ...corrections,
    id: opportunity.id,
    kind: opportunity.kind,
    sourceKey: opportunity.sourceKey,
    stage: opportunity.stage,
    application: opportunity.application,
    outreach: opportunity.outreach,
    assessment: null,
    updatedAt: new Date(
      Math.max(now, Date.parse(opportunity.updatedAt) + 1),
    ).toISOString(),
  });
  const saved = await store.saveDerivedOpportunity(opportunity, next);
  if (!saved) throw new Error("This opportunity was removed during research.");
  const researched = isDeepStrictEqual(
    JSON.parse(JSON.stringify(saved)),
    JSON.parse(JSON.stringify(next)),
  );
  // A user edit during the request wins and does not mark a skipped write fresh.
  if (researched) await store.setRuntime(key, { at: now, url });
  return { opportunity: saved, researched };
}
