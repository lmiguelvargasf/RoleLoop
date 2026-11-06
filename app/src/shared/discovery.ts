import type { Source } from "./types.js";

export type SourceResearch = {
  source: Source;
  description: string;
  coverage: string;
  careersUrl: string;
  checkedAt: string;
  observedListings?: number;
};

// Research snapshots describe the board, never a guarantee of eligibility or an offer.
export const sourceLibrary: SourceResearch[] = [
  {
    source: {
      id: "recommended-gitlab",
      provider: "greenhouse",
      label: "GitLab",
      board: "gitlab",
      enabled: true,
      companyCountry: "United States",
      countrySource: "https://about.gitlab.com/privacy/",
    },
    description:
      "Engineering, sales, customer success, marketing and operations.",
    coverage: "Country-specific remote roles",
    careersUrl: "https://about.gitlab.com/jobs/",
    checkedAt: "2026-11-06",
    observedListings: 245,
  },
  {
    source: {
      id: "recommended-mozilla",
      provider: "greenhouse",
      label: "Mozilla",
      board: "mozilla",
      enabled: true,
      companyCountry: "United States",
      countrySource:
        "https://www.mozilla.org/en-US/about/policy/transparency/guidelines/",
    },
    description: "Engineering, product, design, marketing and business roles.",
    coverage: "Country-specific remote roles",
    careersUrl: "https://www.mozilla.org/en-US/careers/",
    checkedAt: "2026-11-06",
    observedListings: 113,
  },
  {
    source: {
      id: "recommended-jobicy",
      provider: "jobicy",
      label: "Jobicy",
      board: "",
      enabled: true,
    },
    description:
      "Broader discovery across employers and professions. Employer country needs checking.",
    coverage: "Seven-day remote feed · hourly refresh",
    careersUrl: "https://jobicy.com/jobs-rss-feed",
    checkedAt: "2026-11-06",
  },
  {
    source: {
      id: "recommended-automattic",
      provider: "greenhouse",
      label: "Automattic",
      board: "automatticcareers",
      enabled: true,
      companyCountry: "United States",
      countrySource: "https://automattic.com/privacy/",
    },
    description: "Engineering, support, enterprise sales, product and legal.",
    coverage: "Distributed team · check each role",
    careersUrl: "https://automattic.com/work-with-us/jobs/",
    checkedAt: "2026-11-06",
    observedListings: 11,
  },
  {
    source: {
      id: "recommended-buffer",
      provider: "ashby",
      label: "Buffer",
      board: "buffer",
      enabled: true,
      companyCountry: "United States",
      countrySource: "https://buffer.com/legal",
    },
    description: "Small distributed team with public salary transparency.",
    coverage: "Global team · few openings",
    careersUrl: "https://buffer.com/journey",
    checkedAt: "2026-11-06",
    observedListings: 2,
  },
  {
    source: {
      id: "recommended-zapier",
      provider: "ashby",
      label: "Zapier",
      board: "zapier",
      enabled: true,
      companyCountry: "United States",
      countrySource:
        "https://help.zapier.com/hc/en-us/articles/8496229312013-Zapier-s-vendor-information",
    },
    description:
      "Engineering, customer operations, sales, marketing and finance.",
    coverage: "Regional remote roles",
    careersUrl: "https://zapier.com/jobs",
    checkedAt: "2026-11-06",
    observedListings: 10,
  },
  {
    source: {
      id: "recommended-ashby",
      provider: "ashby",
      label: "Ashby",
      board: "ashby",
      enabled: true,
      companyCountry: "United States",
      countrySource: "https://www.ashbyhq.com/resources/privacy",
    },
    description:
      "Engineering, recruiting technology, sales and customer success.",
    coverage: "US, Canada, Europe and other markets",
    careersUrl: "https://www.ashbyhq.com/careers",
    checkedAt: "2026-11-06",
    observedListings: 74,
  },
  {
    source: {
      id: "recommended-linear",
      provider: "ashby",
      label: "Linear",
      board: "linear",
      enabled: true,
      companyCountry: "United States",
      countrySource: "https://linear.app/dpa",
    },
    description: "Product, engineering, design, support and commercial roles.",
    coverage: "North America, Europe and selected markets",
    careersUrl: "https://linear.app/careers",
    checkedAt: "2026-11-06",
    observedListings: 32,
  },
  {
    source: {
      id: "recommended-kraken",
      provider: "ashby",
      label: "Kraken",
      board: "kraken.com",
      enabled: true,
      companyCountry: "United States",
      countrySource:
        "https://blog.kraken.com/news/kraken-relocates-headquarters-to-wyoming",
    },
    description:
      "Engineering, finance, compliance, operations and client support.",
    coverage: "Includes Latin American locations",
    careersUrl: "https://www.kraken.com/careers",
    checkedAt: "2026-11-06",
    observedListings: 89,
  },
  {
    source: {
      id: "recommended-superside",
      provider: "lever",
      label: "Superside",
      board: "superside",
      enabled: true,
      companyCountry: "United States",
      countrySource: "https://www.superside.com/llm-info",
    },
    description: "Creative, design, account management and AI services.",
    coverage: "Global and regional roles",
    careersUrl: "https://careers.superside.com/",
    checkedAt: "2026-11-06",
    observedListings: 14,
  },
];
export const recommendedSources: Source[] = sourceLibrary.map(({ source }) => ({
  ...source,
}));

export function sourceIdentity(
  source: Pick<Source, "provider" | "board">,
): string {
  const normalized = normalizeSource({
    ...source,
    id: "identity",
    label: "",
    enabled: true,
  });
  return `${normalized.provider}:${normalized.board.toLowerCase()}`;
}

export function addRecommendedSources(
  existing: Source[],
  additions = recommendedSources,
): Source[] {
  const next = existing.map((s) => normalizeSource(s));
  const identities = new Set(next.map(sourceIdentity));
  const ids = new Set(next.map((s) => s.id));
  for (const source of additions) {
    const identity = sourceIdentity(source);
    if (identities.has(identity)) continue;
    if (next.length >= 50)
      throw new Error(
        "A workspace can have up to 50 sources. Remove an unused source first.",
      );
    let id = source.id;
    while (ids.has(id)) id += "-added";
    next.push({ ...source, id });
    ids.add(id);
    identities.add(identity);
  }
  return next;
}

export function normalizeSource(source: Source): Source {
  let board = source.board.trim();
  let provider = source.provider;
  if (/^https:\/\//i.test(board)) {
    const url = new URL(board);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "jobs.ashbyhq.com") provider = "ashby";
    else if (
      ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(
        url.hostname,
      )
    )
      provider = "greenhouse";
    else if (url.hostname === "jobs.lever.co") provider = "lever";
    else
      throw new Error("Use an Ashby, Greenhouse or Lever company board URL.");
    board = parts[0] ?? "";
  }
  if (
    !["hackernews", "jobicy"].includes(provider) &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(board)
  )
    throw new Error(
      "Enter a company board identifier or supported careers URL.",
    );
  return { ...source, provider, board };
}

export function applicationCounts(
  opportunities: {
    application?: {
      status: string;
      appliedAt?: string | null;
      interviewAt?: string | null;
      offerAt?: string | null;
    };
  }[],
) {
  const counts = { applied: 0, interview: 0, offer: 0 };
  for (const op of opportunities) {
    const status = op.application?.status;
    if (op.application?.appliedAt) counts.applied++;
    if (op.application?.interviewAt || status === "interview")
      counts.interview++;
    if (op.application?.offerAt || status === "offer") counts.offer++;
  }
  return counts;
}

export function matchesTargetRole(title: string, roles: string[]): boolean {
  if (!roles.length) return true;
  return roles.some((role) =>
    role
      .toLowerCase()
      .split(/\W+/)
      .filter(
        (word) =>
          word.length > 2 &&
          !["senior", "junior", "lead", "staff", "principal"].includes(word),
      )
      .some((word) => title.toLowerCase().includes(word)),
  );
}

export function followUpDue(
  op: { application?: { followUpOn?: string | null; status: string } },
  today: string,
): boolean {
  return (
    !!op.application?.followUpOn &&
    op.application.followUpOn <= today &&
    !["rejected", "withdrawn", "offer"].includes(op.application.status)
  );
}

// These are manual research destinations; they are not automated connectors.
export const additionalJobBoards = [
  {
    name: "We Work Remotely",
    url: "https://weworkremotely.com/",
    description:
      "Remote roles across engineering, design, support, sales and operations.",
  },
  {
    name: "Wellfound",
    url: "https://wellfound.com/jobs",
    description:
      "Startup openings with role, location and compensation details.",
  },
  {
    name: "YC Work at a Startup",
    url: "https://www.ycombinator.com/jobs",
    description:
      "Open positions at YC companies, plus a candidate profile for founder discovery.",
  },
  {
    name: "LinkedIn Jobs",
    url: "https://www.linkedin.com/jobs/",
    description:
      "Broad employer coverage, saved searches and professional connections.",
  },
];
