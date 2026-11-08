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
  {
    source: {
      id: "recommended-weworkremotely",
      provider: "weworkremotely",
      label: "We Work Remotely",
      board: "",
      enabled: true,
    },
    description:
      "Remote roles across programming, design, product, support and business. Employer country needs checking.",
    coverage: "Public RSS feed · hourly refresh · explicit expiry dates",
    careersUrl: "https://weworkremotely.com/remote-job-rss-feed",
    checkedAt: "2026-11-07",
  },
  {
    source: { id: "recommended-himalayas", provider: "himalayas", label: "Himalayas", board: "", enabled: true },
    description: "Country-aware remote job search across employers, including careers sites outside supported ATS platforms. Employer headquarters needs checking.",
    coverage: "Three rotating role queries · two pages each · daily shared cache",
    careersUrl: "https://himalayas.app/api",
    checkedAt: "2026-11-07",
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
    next.push(normalizeSource({ ...source, id }));
    ids.add(id);
    identities.add(identity);
  }
  return next;
}

export function sourceKind(
  source: Pick<Source, "provider">,
): "company_board" | "job_feed" | "startup_feed" {
  return ["hackernews", "seedcamp"].includes(source.provider)
    ? "startup_feed"
    : ["jobicy", "weworkremotely", "himalayas"].includes(source.provider)
      ? "job_feed"
      : "company_board";
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
    !["hackernews", "seedcamp", "jobicy", "weworkremotely", "himalayas"].includes(
      provider,
    ) &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(board)
  )
    throw new Error(
      "Enter a company board identifier or supported careers URL.",
    );
  const kind = sourceKind({ provider });
  return {
    ...source,
    provider,
    board,
    kind,
    ...(kind !== "company_board"
      ? {
          companyId: undefined,
          companyName: undefined,
          companyCountry: undefined,
          countrySource: undefined,
        }
      : {}),
  };
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

export function matchesTargetRole(
  title: string,
  roles: string[],
  company?: string,
): boolean {
  if (!roles.length) return true;
  // Employer names appended to a title are not role evidence (e.g. CXT Software).
  if (company?.trim()) {
    const escaped = company.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(
      new RegExp(`\\s*(?:[,|–—]| - )\\s*@?\\s*${escaped}\\s*$`, "iu"),
      "",
    );
  }
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .replace(/\b(front|back)[ -]end\b/g, "$1end")
      .replace(/\bfull[ -]stack\b/g, "fullstack")
      .replace(/\b(developer|programmer|engineering)\b/g, "engineer")
      .match(/[\p{L}\p{N}+#]+/gu)
      ?.filter(
        (word) =>
          ![
            "senior",
            "sr",
            "junior",
            "jr",
            "lead",
            "staff",
            "principal",
            "remote",
            "and",
            "or",
            "of",
            "the",
            "ii",
            "iii",
            "iv",
          ].includes(word),
      ) ?? [];
  const titleWords = new Set(tokens(title));
  return roles.some((role) => {
    const words = tokens(role).filter(
      (word) => word.length > 1 || word === "r" || word === "c",
    );
    if (!words.length) return false;
    const leadership = [
      "manager",
      "director",
      "head",
      "chief",
      "vp",
      "president",
      "cto",
      "ceo",
      "coo",
      "cfo",
    ];
    if (
      leadership.some((word) => titleWords.has(word)) &&
      !words.some((word) => leadership.includes(word) || word === "assistant")
    )
      return false;
    return words.every(
      (word) =>
        titleWords.has(word) ||
        (word === "software" &&
          words.includes("engineer") &&
          [
            "backend",
            "frontend",
            "fullstack",
            "web",
            "mobile",
            "ios",
            "android",
          ].some((family) => titleWords.has(family))),
    );
  });
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

export const startupLibrary: SourceResearch[] = [
  {
    source: {
      id: "hn-startups",
      provider: "hackernews",
      label: "Show HN",
      board: "",
      enabled: true,
    },
    description:
      "Product launches and new tools shared by their creators. Research potential contacts and company needs.",
    coverage: "Research leads · no advertised vacancy implied",
    careersUrl: "https://news.ycombinator.com/show",
    checkedAt: "2026-11-06",
  },
  {
    source: {
      id: "seedcamp-startups",
      provider: "seedcamp",
      label: "Seedcamp portfolio",
      board: "",
      enabled: true,
    },
    description:
      "Companies in Seedcamp’s public portfolio, prioritized by your industry interests. Confirm current company needs before outreach.",
    coverage: "Company directory · no advertised vacancy implied",
    careersUrl: "https://seedcamp.com/our-companies/",
    checkedAt: "2026-11-07",
  },
];

export function sourcesForDiscovery(
  sources: Source[],
  scope?: "jobs" | "startups",
  sourceId?: string,
): Source[] {
  const selected = sources.filter(
    (source) =>
      source.enabled &&
      (!sourceId || source.id === sourceId) &&
      (!scope ||
        (scope === "startups"
          ? sourceKind(source) === "startup_feed"
          : sourceKind(source) !== "startup_feed")),
  );
  if (scope !== "startups" || sourceId) return selected;
  const configured = sources.filter(
    (source) => sourceKind(source) === "startup_feed",
  );
  if (configured.length && !configured.some((source) => source.enabled))
    return selected;

  // Startup research is ready without source setup. Do not overwrite configured
  // feeds or consume company capacity; paused feeds remain an explicit opt-out.
  const ids = new Set(sources.map((source) => source.id));
  const defaults = startupLibrary.filter(
    ({ source }) =>
      !configured.some((saved) => saved.provider === source.provider),
  );
  return [
    ...selected,
    ...defaults.map(({ source }) => {
      let id = `managed:${source.id}`;
      while (ids.has(id)) id += "-feed";
      ids.add(id);
      return { ...source, id };
    }),
  ];
}
