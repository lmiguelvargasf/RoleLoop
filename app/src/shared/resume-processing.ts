import type { Profile } from "./types.js";

export const CV_EXTRACTION_TIMEOUT_MS = 300_000;
export const CV_PROCESSING_GRACE_MS = 30_000;

// Missing/invalid deadlines come from interrupted legacy attempts and can retry.
export function resumeProcessingActive(
  cache: Profile["cache"],
  now = Date.now(),
) {
  if (cache?.status !== "processing" || !cache.expiresAt) return false;
  const expiresAt = Date.parse(cache.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
