import type { Source } from "./types.js";

// Company location is sourced independently of each vacancy's hiring countries.
export const recommendedSources: Source[] = [
  {
    id: "recommended-gitlab",
    provider: "greenhouse",
    label: "GitLab",
    board: "gitlab",
    enabled: true,
    companyCountry: "United States",
    countrySource: "https://about.gitlab.com/privacy/",
  },
  {
    id: "recommended-mozilla",
    provider: "greenhouse",
    label: "Mozilla",
    board: "mozilla",
    enabled: true,
    companyCountry: "United States",
    countrySource:
      "https://www.mozilla.org/en-US/about/policy/transparency/guidelines/",
  },
  {
    id: "recommended-jobicy",
    provider: "jobicy",
    label: "Jobicy · recent remote jobs",
    board: "",
    enabled: true,
  },
];

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
    !/^[a-zA-Z0-9_-]{1,100}$/.test(board)
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
