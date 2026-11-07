import {
  draftContentHash,
  opportunityFingerprint,
  preferencesFingerprint,
  profileFingerprint,
} from "../domain/rules.js";
import type { Draft, Opportunity, Workspace } from "../shared/types.js";
import { assessGeography } from "../domain/geography.js";

export function assertCanPrepare(opportunity: Opportunity) {
  if (opportunity.stage === "archived")
    throw Object.assign(
      new Error(
        "Restore this opportunity before preparing an application or outreach draft.",
      ),
      { statusCode: 409 },
    );
}

export function assertFresh(
  draft: Draft,
  opportunity: Opportunity,
  workspace: Workspace,
) {
  if (
    draft.profileFingerprint !== profileFingerprint(workspace.profile) ||
    draft.opportunityFingerprint !== opportunityFingerprint(opportunity) ||
    draft.preferencesFingerprint !==
      preferencesFingerprint(workspace.preferences)
  )
    throw Object.assign(
      new Error(
        "The profile, preferences, or opportunity changed. Generate a fresh draft before approving or testing it.",
      ),
      { statusCode: 409 },
    );
  if (draft.contentHash !== draftContentHash(draft))
    throw Object.assign(
      new Error("Draft integrity check failed. Save the draft again."),
      { statusCode: 409 },
    );
  const geography = assessGeography(opportunity, workspace.preferences.country);
  if (geography.blockers.length)
    throw Object.assign(
      new Error(
        `Resolve the location restriction before approving or testing: ${geography.blockers.join(" ")}`,
      ),
      { statusCode: 409 },
    );
}
export function assertApproved(
  draft: Draft,
  opportunity: Opportunity,
  workspace: Workspace,
) {
  assertFresh(draft, opportunity, workspace);
  if (draft.status !== "approved" && draft.status !== "tested")
    throw Object.assign(
      new Error("Review and approve this draft before testing."),
      { statusCode: 409 },
    );
}
export function allowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  appUrl: string,
  apiPort: number,
): boolean {
  const allowed = new Set([
    new URL(appUrl).host,
    `127.0.0.1:${apiPort}`,
    `localhost:${apiPort}`,
    `localhost:${new URL(appUrl).port}`,
  ]);
  if (!host || !allowed.has(host)) return false;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && allowed.has(parsed.host);
  } catch {
    return false;
  }
}
