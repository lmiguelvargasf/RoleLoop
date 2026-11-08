import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  extractRequirements,
  isPublicAddress,
  plainText,
  remoteScope,
  validatePublicUrl,
} from "../src/domain/connectors.js";
import { demoWorkspace } from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());
const prefs = demoWorkspace().preferences;
describe("source normalization", () => {
  it("does not trust the Ashby isRemote flag for hybrid jobs", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              jobs: [
                {
                  id: "a",
                  title: "Engineer",
                  isRemote: true,
                  workplaceType: "Hybrid",
                  location: "New York",
                  jobUrl: "https://jobs.ashbyhq.com/acme/a",
                  descriptionPlain: "Requirements\nTypeScript experience",
                  publishedAt: "2026-11-01T12:00:00Z",
                },
              ],
            }),
          ),
        ),
    );
    const [op] = await discover(
      {
        id: "a",
        provider: "ashby",
        label: "Acme",
        board: "acme",
        enabled: true,
      },
      prefs,
    );
    expect(op.remoteScope).toBe("onsite");
    expect(op.companyCountry).toBe("Unknown");
    expect(op.requirements[0].skills).toContain("TypeScript");
  });
  it("does not use a Greenhouse update timestamp as the publication date", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              jobs: [
                {
                  id: 1,
                  title: "Engineer",
                  content: "<h2>Requirements</h2><p>React experience</p>",
                  updated_at: "2026-11-05T12:00:00Z",
                  absolute_url: "https://boards.greenhouse.io/acme/1",
                  location: { name: "Remote" },
                },
              ],
            }),
          ),
        ),
    );
    const [op] = await discover(
      {
        id: "g",
        provider: "greenhouse",
        label: "Acme",
        board: "acme",
        enabled: true,
      },
      prefs,
    );
    expect(op.publishedAt).toBeNull();
    expect(op.remoteScope).toBe("unknown");
  });
  it("keeps Show HN projects as unverified startup leads", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              hits: [
                {
                  objectID: "123",
                  title: "Show HN: Tool for engineering teams",
                  url: "https://sample-product.com",
                  created_at: "2026-11-01T12:00:00Z",
                },
              ],
            }),
          ),
        ),
    );
    const [op] = await discover(
      {
        id: "h",
        provider: "hackernews",
        label: "Show HN",
        board: "",
        enabled: true,
      },
      prefs,
    );
    expect(op.kind).toBe("startup");
    expect(op.companyCountry).toBe("Unknown");
    expect(op.contactEmail).toBe("");
    expect(op.notes).toContain("does not establish");
  });
  it("rejects board identifiers containing URLs", async () => {
    await expect(
      discover(
        {
          id: "a",
          provider: "ashby",
          label: "Acme",
          board: "https://localhost",
          enabled: true,
        },
        prefs,
      ),
    ).rejects.toThrow("identifier");
  });
  it("passes Show HN search keywords as one encoded query parameter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ hits: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await discover(
      {
        id: "h",
        provider: "hackernews",
        label: "Show HN",
        board: "  developer tools & AI  ",
        enabled: true,
      },
      prefs,
    );
    const requested = new URL(fetchMock.mock.calls[0][0]);
    expect(requested.searchParams.get("query")).toBe("developer tools & AI");
    expect(requested.searchParams.get("tags")).toBe("show_hn");
    expect(requested.searchParams.has("AI")).toBe(false);
  });
  it("omits the Show HN query when no keyword is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ hits: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await discover(
      {
        id: "h",
        provider: "hackernews",
        label: "Show HN",
        board: "   ",
        enabled: true,
      },
      prefs,
    );
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has("query")).toBe(
      false,
    );
  });
  it("extracts requirements from required sections, not from incidental marketing text", () => {
    expect(extractRequirements("We sell TypeScript tools.")).toEqual([]);
    const req = extractRequirements(
      "Requirements\nExperience with React and TypeScript\nNice to have\nAWS experience",
    );
    expect(req[0].essential).toBe(true);
    expect(req[1].essential).toBe(false);
    expect(plainText("<script>bad()</script><p>Hello</p>")).toBe("Hello");
    expect(remoteScope("Remote worldwide")).toBe("worldwide");
    expect(remoteScope("Remote, US only")).toBe("us");
  });

  it.each([
    "Must have production Python experience.",
    "Must-have Python skills and production experience.",
  ])("preserves unheaded mandatory qualifications: %s", (description) => {
    expect(extractRequirements(description)).toMatchObject([
      { text: description, essential: true, hard: true, skills: ["Python"] },
    ]);
  });

  it("does not score corporate essential tools or must-buy marketing as qualifications", () => {
    const req = extractRequirements([
      "## Who we are",
      "Designed to look striking, Typeform drives 500 million responses every year—and integrates with essential tools like Slack, Zapier, and Hubspot.",
      "Moving forward, we will be doubling down on Video Ads, with the goal of becoming an industry leader and a ‘must buy’ for advertisers.",
      "## Requirements",
      "Strong Python and software engineering skills.",
      "At least four years building and deploying AI systems in production.",
    ].join("\n"));
    expect(req.map((r) => r.text)).toEqual([
      "Strong Python and software engineering skills.",
      "At least four years building and deploying AI systems in production.",
    ]);
    expect(extractRequirements("Minimum 3 years of Python experience. Strong communication skills are required.")).toHaveLength(2);
    expect(extractRequirements("Production Python experience is essential.")).toHaveLength(1);
  });
});
describe("research network boundaries", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])("rejects reserved address %s", (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it("accepts ordinary public addresses", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it.each([
    "http://127.0.0.1",
    "http://[::1]",
    "http://localhost",
    "https://internal.local",
    "ftp://example.com",
    "https://user:secret@example.com",
    "http://example.com:3000",
  ])("rejects unsafe URL %s before a request", async (url) => {
    await expect(validatePublicUrl(url)).rejects.toThrow();
  });
});
