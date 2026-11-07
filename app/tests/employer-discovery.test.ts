import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverEmployerBoards,
  employerBoardFromUrl,
} from "../src/domain/employer-discovery.js";
import { safeFetchText } from "../src/domain/connectors.js";
import { demoWorkspace } from "./fixtures.js";

vi.mock("../src/domain/connectors.js", async (original) => ({
  ...(await original<typeof import("../src/domain/connectors.js")>()),
  safeFetchText: vi.fn(),
}));

function memoryCache() {
  const values = new Map<string, unknown>();
  return {
    values,
    async get<T>(key: string): Promise<T | null> {
      return (structuredClone(values.get(key)) ?? null) as T | null;
    },
    async set(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
  };
}
const workspace = () => {
  const state = demoWorkspace();
  state.preferences.roles = ["Software Engineer"];
  return state;
};
const directoryJob = (slug = "acme") => ({
  companyName: slug === "acme" ? "Acme" : slug,
  companySlug: slug,
  title: "Software Engineer",
  expiryDate: Math.floor(Date.now() / 1000) + 86400,
  description: "Directory description must never become a saved job.",
  applicationLink: `https://himalayas.app/companies/${slug}/jobs/engineer?utm_source=api`,
});
const posting = (patch: Record<string, unknown> = {}) => ({
  id: "role-1",
  title: "Software Engineer",
  location: "Remote worldwide",
  workplaceType: "Remote",
  descriptionPlain: "Direct employer description. Work remotely worldwide.",
  jobUrl: "https://jobs.ashbyhq.com/acme/role-1",
  publishedAt: new Date().toISOString(),
  compensation: {
    summaryComponents: [
      {
        compensationType: "Salary",
        interval: "1 YEAR",
        currencyCode: "USD",
        minValue: 100000,
        maxValue: 140000,
      },
    ],
  },
  ...patch,
});
const companyResponse = (
  website = "https://acme.example/?utm_source=himalayas.app",
) =>
  new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: `# Acme\n\n## Links\n🌐 **Website:** ${website}\n`,
          },
        ],
      },
    })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );

function setup(
  options: {
    jobs?: () => Record<string, unknown>[];
    company?: () => Response;
    listings?: () => Record<string, unknown>[];
    html?: string;
  } = {},
) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "himalayas.app")
      return new Response(
        JSON.stringify({ jobs: options.jobs?.() ?? [directoryJob()] }),
      );
    if (url.hostname === "mcp.himalayas.app") {
      const body = JSON.parse(String(init?.body));
      expect(body.params.name).toBe("get_company_details");
      return options.company?.() ?? companyResponse();
    }
    if (url.hostname === "api.ashbyhq.com")
      return new Response(
        JSON.stringify({ jobs: options.listings?.() ?? [posting()] }),
      );
    throw new Error(`Unexpected network call: ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(safeFetchText).mockImplementation(async (url) => ({
    url,
    text:
      options.html ??
      (new URL(url).pathname === "/"
        ? '<a href="/careers">Careers</a>'
        : '<a href="https://jobs.ashbyhq.com/acme">Open roles</a>'),
  }));
  return fetchMock;
}

beforeEach(() => {
  vi.mocked(safeFetchText).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("employer discovery", () => {
  it("sends the optional key only to the Himalayas REST API", async () => {
    const fetchMock = setup();
    const cache = memoryCache();
    const apiKey = "test_himalayas_secret";
    const onProgress = vi.fn(async () => {});
    const result = await discoverEmployerBoards(workspace(), {
      cache,
      himalayasApiKey: apiKey,
      onProgress,
    });
    expect(result.errors).toEqual([]);
    expect(result.boards).toHaveLength(1);
    expect(fetchMock.mock.calls).toHaveLength(3);
    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.origin === "https://himalayas.app") {
        expect(url.pathname).toBe("/jobs/api/search");
        expect(authorization).toBe(`Bearer ${apiKey}`);
        expect(init?.redirect).toBe("error");
      } else {
        expect(authorization).toBeNull();
      }
      expect(url.href).not.toContain(apiKey);
    }
    expect(safeFetchText).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(safeFetchText).mock.calls)).not.toContain(
      apiKey,
    );
    expect(JSON.stringify([...cache.values])).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(apiKey);
  });

  it.each([undefined, ""])(
    "keeps public discovery working without a key (%s)",
    async (apiKey) => {
      const fetchMock = setup();
      const result = await discoverEmployerBoards(workspace(), {
        cache: memoryCache(),
        himalayasApiKey: apiKey,
      });
      expect(result.errors).toEqual([]);
      expect(result.boards).toHaveLength(1);
      for (const [, init] of fetchMock.mock.calls)
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    },
  );

  it.each([
    { apiKey: undefined, status: 429 },
    { apiKey: "revoked_test_key", status: 401 },
  ])(
    "retries a cached HTTP $status after adding or replacing the key",
    async ({ apiKey, status }) => {
      const fetchMock = setup();
      const cache = memoryCache();
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      const first = await discoverEmployerBoards(workspace(), {
        cache,
        himalayasApiKey: apiKey,
      });
      expect(first.errors).toEqual([
        `Employer directory returned HTTP ${status}.`,
      ]);
      expect(
        (
          await discoverEmployerBoards(workspace(), {
            cache,
            himalayasApiKey: apiKey,
          })
        ).errors,
      ).toEqual(first.errors);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const retried = await discoverEmployerBoards(workspace(), {
        cache,
        himalayasApiKey: "new_test_key",
      });
      expect(retried.errors).toEqual([]);
      expect(retried.boards).toHaveLength(1);
      expect(
        new Headers(fetchMock.mock.calls[1][1]?.headers).get("Authorization"),
      ).toBe("Bearer new_test_key");
    },
  );

  it("reuses successful public directory data after configuring a key", async () => {
    const fetchMock = setup();
    const cache = memoryCache();
    await discoverEmployerBoards(workspace(), { cache });
    fetchMock.mockClear();
    const result = await discoverEmployerBoards(workspace(), {
      cache,
      himalayasApiKey: "new_test_key",
    });
    expect(result.boards).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
      "api.ashbyhq.com",
    ]);
  });

  it("reports malformed keys without exposing their value", async () => {
    const fetchMock = setup();
    const cache = memoryCache();
    const apiKey = "private\nmalformed_key";
    const result = await discoverEmployerBoards(workspace(), {
      cache,
      himalayasApiKey: apiKey,
    });
    expect(result.errors).toEqual([
      "Himalayas API key has an invalid format. Update the server configuration.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify([...cache.values])).not.toContain("malformed_key");
  });

  it("finds employers broadly but imports only independently fetched company jobs", async () => {
    const fetchMock = setup();
    const cache = memoryCache();
    const state = workspace();
    state.profile = { email: "private@example.com", source: null, cache: null };
    const result = await discoverEmployerBoards(state, { cache });
    expect(
      new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("sort"),
    ).toBe("salaryDesc");
    expect(result.errors).toEqual([]);
    expect(result.companiesFound).toBe(1);
    expect(result.boardsChecked).toBe(1);
    expect(result.boards).toHaveLength(1);
    expect(result.boards[0].source).toMatchObject({
      label: "Acme",
      provider: "ashby",
      board: "acme",
      companyCountry: "Unknown",
      discoveredFrom: "https://himalayas.app/companies/acme",
    });
    expect(result.boards[0].opportunities[0]).toMatchObject({
      source: "ashby",
      url: "https://jobs.ashbyhq.com/acme/role-1",
      companyCountry: "Unknown",
      companyUrl: "https://acme.example/",
      description: "Direct employer description. Work remotely worldwide.",
    });
    const calls = JSON.stringify(fetchMock.mock.calls);
    expect(calls).not.toContain("private@example.com");
    expect(calls).not.toContain("sample.pdf");
    expect(calls).not.toContain("minimumSalary");
    expect(
      new URL(fetchMock.mock.calls[0][0]).searchParams.get("country"),
    ).toBe("Ecuador");
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.redirect === "error"),
    ).toBe(true);
    const retained = JSON.stringify([...cache.values]);
    expect(retained).not.toContain("Directory description");
    expect(retained).not.toContain("applicationLink");
    expect(retained).not.toContain("role-1");
    expect(retained).not.toContain("auto-");
  });

  it.each([
    {
      name: "US-only role",
      patch: {
        location: "Remote United States only",
        descriptionPlain: "US-only remote role.",
      },
    },
    { name: "onsite role", patch: { workplaceType: "OnSite" } },
    {
      name: "below salary floor",
      patch: {
        compensation: {
          summaryComponents: [
            {
              compensationType: "Salary",
              interval: "1 YEAR",
              currencyCode: "USD",
              minValue: 20000,
              maxValue: 30000,
            },
          ],
        },
      },
    },
    { name: "unrelated title", patch: { title: "Accountant" } },
  ])("does not follow a company with only a $name", async ({ patch }) => {
    setup({ listings: () => [posting(patch)] });
    const result = await discoverEmployerBoards(workspace(), {
      cache: memoryCache(),
    });
    expect(result.boardsChecked).toBe(1);
    expect(result.boards).toEqual([]);
  });

  it("applies current strict date and missing-pay preferences before following", async () => {
    setup({
      listings: () => [
        posting({ publishedAt: "2020-01-01T00:00:00Z", compensation: {} }),
      ],
    });
    const state = workspace();
    state.preferences.dateMode = "strict";
    state.preferences.missingSalary = "exclude";
    expect(
      (await discoverEmployerBoards(state, { cache: memoryCache() })).boards,
    ).toEqual([]);
  });

  it("reuses metadata but checks live openings and changed preferences on every run", async () => {
    const fetchMock = setup();
    const cache = memoryCache();
    const state = workspace();
    const first = await discoverEmployerBoards(state, { cache });
    const second = await discoverEmployerBoards(state, { cache });
    expect(first.boards[0].source.id).toBe(second.boards[0].source.id);
    expect(first.boards[0].opportunities[0].id).not.toBe(
      second.boards[0].opportunities[0].id,
    );
    state.preferences.minimumSalary = 160000;
    expect((await discoverEmployerBoards(state, { cache })).boards).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://himalayas.app/"),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://mcp.himalayas.app/"),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://api.ashbyhq.com/"),
      ),
    ).toHaveLength(3);
    expect(safeFetchText).toHaveBeenCalledTimes(2);
  });

  it("clears board failures with a non-null expired runtime payload", async () => {
    setup();
    const memory = memoryCache();
    const cache = {
      get: memory.get,
      async set(key: string, value: unknown) {
        if (value === null)
          throw new Error("runtime.payload violates not-null constraint");
        await memory.set(key, value);
      },
    };
    const first = await discoverEmployerBoards(workspace(), { cache });
    expect(first.errors).toEqual([]);
    expect(first.boards).toHaveLength(1);
    const failureEntry = [...memory.values].find(([key]) =>
      key.startsWith("employers:board-error:"),
    );
    expect(failureEntry?.[1]).toEqual({ at: 0, error: "" });
    const repeated = await discoverEmployerBoards(workspace(), { cache });
    expect(repeated.errors).toEqual([]);
    expect(repeated.boards).toHaveLength(1);
    expect(repeated.boardsChecked).toBe(1);
  });

  it("keeps paused boards and explicitly excluded identities excluded", async () => {
    const fetchMock = setup();
    const state = workspace();
    state.sources.push({
      id: "paused",
      label: "Custom board label",
      provider: "ashby",
      board: "ACME",
      enabled: false,
    });
    expect(
      (await discoverEmployerBoards(state, { cache: memoryCache() })).boards,
    ).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.startsWith("https://api.ashbyhq.com/"),
      ),
    ).toBe(false);
    expect(
      (
        await discoverEmployerBoards(workspace(), {
          cache: memoryCache(),
          excludeIdentities: ["ASHBY:ACME"],
        })
      ).boards,
    ).toEqual([]);
  });

  it("backs off failed directory requests for an hour, then allows retry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let fail = true;
    const fetchMock = setup({
      company: () => (fail ? new Response("invalid SSE") : companyResponse()),
    });
    const cache = memoryCache();
    const first = await discoverEmployerBoards(workspace(), { cache });
    expect(first.errors.join(" ")).toContain(
      "Company details could not be read",
    );
    fail = false;
    expect(
      (await discoverEmployerBoards(workspace(), { cache })).boards,
    ).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://mcp.himalayas.app/"),
      ),
    ).toHaveLength(1);
    now += 3600001;
    expect(
      (await discoverEmployerBoards(workspace(), { cache })).boards,
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://mcp.himalayas.app/"),
      ),
    ).toHaveLength(2);
  });

  it("backs off invalid board responses without caching workspace job IDs", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = setup();
    const original = fetchMock.getMockImplementation()!;
    let fail = true;
    fetchMock.mockImplementation(async (input, init) =>
      fail && input.startsWith("https://api.ashbyhq.com/")
        ? new Response("unavailable", { status: 503 })
        : original(input, init),
    );
    const cache = memoryCache();
    expect(
      (await discoverEmployerBoards(workspace(), { cache })).errors.join(" "),
    ).toContain("503");
    fail = false;
    expect(
      (await discoverEmployerBoards(workspace(), { cache })).boardsChecked,
    ).toBe(0);
    now += 3600001;
    expect(
      (await discoverEmployerBoards(workspace(), { cache })).boards,
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://api.ashbyhq.com/"),
      ),
    ).toHaveLength(2);
  });

  it.each([
    "http://acme.example/",
    "https://127.0.0.1/careers",
    "https://[::1]/careers",
    "https://acme.local/careers",
    "https://user:password@acme.example/",
    "https://acme.example:8443/",
  ])(
    "rejects unsafe directory website %s before fetching it",
    async (website) => {
      setup({ company: () => companyResponse(website) });
      const result = await discoverEmployerBoards(workspace(), {
        cache: memoryCache(),
      });
      expect(result.boards).toEqual([]);
      expect(safeFetchText).not.toHaveBeenCalled();
      expect(result.errors.join(" ")).toContain("public HTTPS");
    },
  );

  it("does not guess a board from a platform marketing link or off-site careers page", async () => {
    const fetchMock = setup({
      html: '<a href="https://www.ashbyhq.com">Powered by Ashby</a><a href="https://jobs.lever.co/">Jobs</a><a href="https://unrelated.example/careers">Careers</a><a href="https://127.0.0.1/jobs">Jobs</a>',
    });
    const result = await discoverEmployerBoards(workspace(), {
      cache: memoryCache(),
    });
    expect(result.boards).toEqual([]);
    expect(result.boardsChecked).toBe(0);
    expect(safeFetchText).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.startsWith("https://api.ashbyhq.com/"),
      ),
    ).toBe(false);
  });

  it("does not mistake a homepage customer link for the employer’s own board", async () => {
    setup({
      html: '<a href="https://jobs.ashbyhq.com/customer">Read our customer story</a>',
    });
    const result = await discoverEmployerBoards(workspace(), {
      cache: memoryCache(),
    });
    expect(result.boardsChecked).toBe(0);
    expect(result.boards).toEqual([]);
  });

  it("follows an observed careers subdomain and reads role links on that careers page", async () => {
    setup();
    vi.mocked(safeFetchText).mockImplementation(async (url) => ({
      url,
      text:
        new URL(url).hostname === "acme.example"
          ? '<a href="https://careers.acme.example">Careers</a>'
          : '<a href="https://jobs.ashbyhq.com/acme/role-1">Software Engineer</a>',
    }));
    const result = await discoverEmployerBoards(workspace(), {
      cache: memoryCache(),
    });
    expect(result.boards).toHaveLength(1);
    expect(safeFetchText).toHaveBeenCalledWith("https://careers.acme.example/");
  });

  it("reaches later employers after the first research budget found unsupported boards", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "himalayas.app")
        return new Response(
          JSON.stringify({
            jobs: Array.from({ length: 20 }, (_, i) =>
              directoryJob(`employer-${i}`),
            ),
          }),
        );
      if (url.hostname === "mcp.himalayas.app") {
        const slug = JSON.parse(String(init?.body)).params.arguments
          .company_slug;
        return companyResponse(`https://${slug}.example/`);
      }
      return new Response(JSON.stringify({ jobs: [posting()] }));
    });
    vi.mocked(safeFetchText).mockImplementation(async (url) => {
      const slug = new URL(url).hostname.split(".")[0];
      return {
        url,
        text:
          Number(slug.split("-")[1]) < 12
            ? "No supported careers connection"
            : `<a href="https://jobs.ashbyhq.com/${slug}">Jobs</a>`,
      };
    });
    const cache = memoryCache();
    const first = await discoverEmployerBoards(workspace(), { cache });
    expect(first.companiesFound).toBe(20);
    expect(first.boards).toEqual([]);
    expect(safeFetchText).toHaveBeenCalledTimes(12);
    const second = await discoverEmployerBoards(workspace(), { cache });
    expect(second.boards).toHaveLength(5);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://himalayas.app/"),
      ),
    ).toHaveLength(2);
    expect(
      second.boards.every(
        ({ source }) => Number(source.board.split("-")[1]) >= 12,
      ),
    ).toBe(true);
  });

  it("reaches later employers when cached boards have no suitable roles", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "himalayas.app")
        return new Response(
          JSON.stringify({
            jobs: Array.from({ length: 20 }, (_, i) =>
              directoryJob(`employer-${i}`),
            ),
          }),
        );
      if (url.hostname === "mcp.himalayas.app") {
        const slug = JSON.parse(String(init?.body)).params.arguments
          .company_slug;
        return companyResponse(`https://${slug}.example/`);
      }
      const index = Number(url.pathname.split("/").at(-1)!.split("-")[1]);
      return new Response(
        JSON.stringify({
          jobs: [posting(index < 12 ? { workplaceType: "OnSite" } : {})],
        }),
      );
    });
    vi.mocked(safeFetchText).mockImplementation(async (url) => ({
      url,
      text: `<a href="https://jobs.ashbyhq.com/${new URL(url).hostname.split(".")[0]}">Jobs</a>`,
    }));
    const cache = memoryCache();
    const first = await discoverEmployerBoards(workspace(), { cache });
    expect(first.boardsChecked).toBe(12);
    expect(first.boards).toEqual([]);
    const second = await discoverEmployerBoards(workspace(), { cache });
    expect(second.boards).toHaveLength(5);
    expect(second.boardsChecked).toBeLessThanOrEqual(7);
    expect(
      second.boards.every(
        ({ source }) => Number(source.board.split("-")[1]) >= 12,
      ),
    ).toBe(true);
  });

  it("fails closed when company links identify multiple different boards", async () => {
    setup({
      html: '<a href="https://jobs.ashbyhq.com/acme">Jobs</a><a href="https://jobs.lever.co/another-company">Jobs</a>',
    });
    const result = await discoverEmployerBoards(workspace(), {
      cache: memoryCache(),
    });
    expect(result.boards).toEqual([]);
    expect(result.boardsChecked).toBe(0);
    expect(result.errors.join(" ")).toContain("Multiple job boards");
  });

  it("does not infer a website from malformed or ambiguous company tool output", async () => {
    setup({
      company: () =>
        new Response(
          JSON.stringify({
            id: 1,
            result: {
              content: [
                {
                  type: "text",
                  text: "🌐 **Website:** https://acme.example/\n🌐 **Website:** https://other.example/",
                },
              ],
            },
          }),
        ),
    });
    const result = await discoverEmployerBoards(workspace(), {
      cache: memoryCache(),
    });
    expect(result.boards).toEqual([]);
    expect(result.errors.join(" ")).toContain("ambiguous");
    expect(safeFetchText).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized directory responses with bounded errors", async () => {
    const fetchMock = setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ vacancies: [] })),
    );
    expect(
      (await discoverEmployerBoards(workspace(), { cache: memoryCache() }))
        .errors,
    ).toEqual(["Employer directory returned an invalid jobs list."]);
    fetchMock.mockResolvedValue(
      new Response("{}", { headers: { "Content-Length": "4194305" } }),
    );
    expect(
      (await discoverEmployerBoards(workspace(), { cache: memoryCache() }))
        .errors,
    ).toEqual(["Employer directory response was too large."]);
    expect(safeFetchText).not.toHaveBeenCalled();
  });

  it("bounds directory pagination, employer research, and added companies", async () => {
    const state = workspace();
    state.preferences.roles = [
      "Software Engineer",
      "Backend Engineer",
      "Frontend Engineer",
      "Mobile Engineer",
    ];
    const fetchMock = setup();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "himalayas.app")
        return new Response(
          JSON.stringify({
            jobs: Array.from({ length: 20 }, (_, i) => ({
              ...directoryJob(`employer-${url.searchParams.get("page")}-${i}`),
              title: url.searchParams.get("q"),
            })),
          }),
        );
      if (url.hostname === "mcp.himalayas.app") {
        const slug = JSON.parse(String(init?.body)).params.arguments
          .company_slug;
        return companyResponse(`https://${slug}.example/`);
      }
      return new Response(JSON.stringify({ jobs: [posting()] }));
    });
    vi.mocked(safeFetchText).mockImplementation(async (url) => ({
      url,
      text: `<a href="https://jobs.ashbyhq.com/${new URL(url).hostname.split(".")[0]}">Jobs</a>`,
    }));
    const result = await discoverEmployerBoards(state, {
      cache: memoryCache(),
    });
    expect(result.companiesFound).toBe(40);
    expect(result.boards).toHaveLength(5);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://himalayas.app/"),
      ),
    ).toHaveLength(6);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://mcp.himalayas.app/"),
      ).length,
    ).toBeLessThanOrEqual(12);
    expect(new Set(result.boards.map(({ source }) => source.id)).size).toBe(5);
  });

  it("requires search preferences and respects the source capacity without network calls", async () => {
    const fetchMock = setup();
    const state = workspace();
    state.preferences.country = "";
    expect(
      (await discoverEmployerBoards(state, { cache: memoryCache() })).errors[0],
    ).toContain("working country");
    state.preferences.country = "Ecuador";
    state.sources = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      provider: "ashby",
      label: String(i),
      board: `company-${i}`,
      enabled: false,
    }));
    expect(
      (await discoverEmployerBoards(state, { cache: memoryCache() })).errors[0],
    ).toContain("50 sources");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("observed employer board links", () => {
  it.each([
    [
      "https://jobs.ashbyhq.com/kraken.com/job-id",
      { provider: "ashby", board: "kraken.com" },
    ],
    [
      "https://jobs.lever.co/superside",
      { provider: "lever", board: "superside" },
    ],
    [
      "https://job-boards.greenhouse.io/mozilla/jobs/123",
      { provider: "greenhouse", board: "mozilla" },
    ],
    [
      "https://boards.greenhouse.io/embed/job_board/js?for=canonical",
      { provider: "greenhouse", board: "canonical" },
    ],
    [
      "https://boards.greenhouse.io/embed/job_app?for=acme&token=123",
      { provider: "greenhouse", board: "acme" },
    ],
  ])("recognizes %s", (url, expected) => {
    expect(employerBoardFromUrl(url as string)).toEqual(expected);
  });
  it.each([
    "https://www.ashbyhq.com/careers",
    "https://jobs.ashbyhq.com/",
    "https://jobs.ashbyhq.com.evil.example/acme",
    "https://jobs.ashbyhq.com/acme%2Fother",
    "https://jobs.ashbyhq.com:8443/acme",
    "http://jobs.lever.co/acme",
    "https://user:password@jobs.lever.co/acme",
    "https://boards.greenhouse.io/embed/job_board",
    "https://boards.greenhouse.io/embed/tracking?for=acme",
  ])("rejects unrelated or unsafe link %s", (url) => {
    expect(employerBoardFromUrl(url)).toBeNull();
  });
});
