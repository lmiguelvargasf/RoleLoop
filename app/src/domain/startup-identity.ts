import type { Opportunity } from "../shared/types.js";

// These domains identify a publisher or hosting platform, not the company
// behind an individual page. Tenant subdomains (for example a.github.io) are
// intentionally kept intact; never collapse a hostname to its parent domain.
const sharedHosts = new Set([
  "github.com",
  "gist.github.com",
  "github.io",
  "gitlab.com",
  "bitbucket.org",
  "ycombinator.com",
  "news.ycombinator.com",
  "seedcamp.com",
  "techstars.com",
  "producthunt.com",
  "medium.com",
  "substack.com",
  "wordpress.com",
  "blogspot.com",
  "notion.so",
  "notion.site",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "apps.apple.com",
  "play.google.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "itch.io",
  "huggingface.co",
]);

/** Conservative company identity, mirrored by startup_website_identity in SQL. */
export function startupWebsiteIdentity(url: string): string | null {
  const match = url
    .trim()
    .match(/^https?:\/\/([^/?#:]+)(?::(?:80|443))?(?:[/?#]|$)/i);
  if (!match) return null;
  const hostname = match[1]
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (
    hostname.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      hostname,
    ) ||
    /^[0-9.]+$/.test(hostname) ||
    sharedHosts.has(hostname)
  )
    return null;
  return hostname;
}

export function startupIdentity(
  op: Pick<Opportunity, "kind" | "companyUrl" | "url" | "isDemo">,
): string | null {
  return op.kind === "startup" && !op.isDemo
    ? startupWebsiteIdentity(op.companyUrl || op.url)
    : null;
}

type DiscoverySignal = {
  source: string;
  sourceKey: string;
  title: string;
  url: string;
  publishedAt: string | null;
};

function sourceSignal(op: Opportunity): DiscoverySignal | null {
  const hnId =
    op.source === "hackernews" ? op.sourceKey.match(/:(\d+)$/)?.[1] : undefined;
  const url = hnId ? `https://news.ycombinator.com/item?id=${hnId}` : op.url;
  try {
    if (!["https:", "http:"].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return {
    source: op.source,
    sourceKey: op.sourceKey,
    title: op.title,
    url,
    publishedAt: op.publishedAt,
  };
}

/** Keep source evidence separate from the prospect's stable primary identity. */
export function mergeDiscoverySignals(
  ...opportunities: Opportunity[]
): DiscoverySignal[] {
  const signals = new Map<string, DiscoverySignal>();
  for (const op of opportunities) {
    for (const signal of op.discoverySignals?.length
      ? op.discoverySignals
      : [sourceSignal(op)]) {
      if (!signal) continue;
      // A feed keyword must not turn the same announcement into several signals.
      const key = `${signal.source}:${signal.url || signal.sourceKey}`;
      const previous = signals.get(key);
      signals.set(key, {
        ...signal,
        publishedAt: signal.publishedAt ?? previous?.publishedAt ?? null,
      });
    }
  }
  return [...signals.values()].slice(-100);
}

const known = (value: string | undefined) =>
  Boolean(value && value.trim() && value.toLowerCase() !== "unknown");

/** Source refreshes add evidence without discarding research or user state. */
export function mergeStartupProspect(
  old: Opportunity,
  incoming: Opportunity,
  corrections: Partial<Opportunity>,
): Opportunity {
  // Website research is usually more detailed than a feed excerpt. Keep the
  // richer text and its truncation flag, unless a user correction takes priority.
  const description =
    incoming.description.length > old.description.length ? incoming : old;
  const hostname = startupIdentity(old);
  const company =
    hostname && old.company.toLowerCase().replace(/^www\./, "") === hostname
      ? incoming.company
      : old.company;
  const dates = [old.publishedAt, incoming.publishedAt].filter(
    (value): value is string => Boolean(value),
  );
  return {
    ...old,
    company,
    description: description.description,
    descriptionTruncated: description.descriptionTruncated,
    companyUrl: old.companyUrl || incoming.companyUrl,
    companyCountry: known(old.companyCountry)
      ? old.companyCountry
      : incoming.companyCountry,
    companyCountrySource: known(old.companyCountry)
      ? old.companyCountrySource
      : incoming.companyCountrySource,
    location: known(old.location) ? old.location : incoming.location,
    remoteScope:
      old.remoteScope !== "unknown" ? old.remoteScope : incoming.remoteScope,
    contactName: old.contactName || incoming.contactName,
    contactEmail: old.contactEmail || incoming.contactEmail,
    contactSource: old.contactEmail
      ? old.contactSource
      : incoming.contactSource,
    publishedAt: dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    signals: [...new Set([...old.signals, ...incoming.signals])].slice(-100),
    ...corrections,
    discoverySignals: mergeDiscoverySignals(old, incoming),
    id: old.id,
    companyId: old.companyId,
    source: old.source,
    sourceId: old.sourceId,
    sourceKey: old.sourceKey,
    firstSeenAt: old.firstSeenAt,
    stage: old.stage,
    assessment: old.assessment,
    application: old.application,
    outreach: old.outreach,
    notes: old.notes,
  };
}
