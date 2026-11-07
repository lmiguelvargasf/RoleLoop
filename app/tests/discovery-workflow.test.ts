import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  extractRequirements,
  remoteScope,
} from "../src/domain/connectors.js";
import {
  normalizeSource,
  addRecommendedSources,
  sourceLibrary,
  recommendedSources,
  applicationCounts,
  matchesTargetRole,
  sourcesForDiscovery,
} from "../src/shared/discovery.js";
import {
  assessOpportunity,
  preferencesFingerprint,
} from "../src/domain/rules.js";
import { demoWorkspace, demoOpportunities } from "./fixtures.js";
afterEach(() => vi.unstubAllGlobals());

describe("practical discovery", () => {
  it("provides startup research without source setup or consuming company capacity", () => {
    const sources = Array.from({ length: 50 }, (_, index) => ({
      ...recommendedSources[0],
      id: index === 0 ? "managed:hn-startups" : `company-${index}`,
      board: `company-${index}`,
      enabled: false,
    }));
    const before = structuredClone(sources);
    const [feed] = sourcesForDiscovery(sources, "startups");
    expect(feed).toMatchObject({
      provider: "hackernews",
      enabled: true,
      board: "",
    });
    expect(sources.some((source) => source.id === feed.id)).toBe(false);
    expect(sourcesForDiscovery(sources, "startups")[0].id).toBe(feed.id);
    expect(sources).toEqual(before);
    expect(sourcesForDiscovery(sources, "jobs")).toEqual([]);
  });

  it("preserves configured startup keywords and does not replace paused feeds", () => {
    const feed = { ...demoWorkspace().sources[0], board: "design tools" };
    expect(
      sourcesForDiscovery([...recommendedSources, feed], "startups"),
    ).toEqual([feed]);
    expect(
      sourcesForDiscovery([{ ...feed, enabled: false }], "startups"),
    ).toEqual([]);
    expect(sourcesForDiscovery([], "startups", "missing-feed")).toEqual([]);
  });

  it("excludes explicitly incompatible hiring regions while retaining multi-region LATAM roles", () => {
    const workspace = demoWorkspace();
    const job = {
      ...demoOpportunities()[0],
      location: "EMEA Remote",
      remoteScope: "unknown" as const,
    };
    const excluded = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    expect(excluded.recommendation).toBe("excluded");
    expect(excluded.blockers.join(" ")).toContain(
      "listed hiring region (EMEA)",
    );
    expect(
      assessOpportunity(
        { ...job, location: "EMEA or LATAM" },
        workspace.profile,
        workspace.preferences,
      ).blockers.join(" "),
    ).not.toContain("listed hiring region");
    expect(
      assessOpportunity(
        { ...job, location: "Remote, United States", remoteScope: "latam" },
        workspace.profile,
        workspace.preferences,
      ).blockers.join(" "),
    ).not.toContain("listed hiring region");
  });
  it("matches role meaning without confusing shared generic title words", () => {
    expect(matchesTargetRole("Civil Engineer", ["Software Engineer"])).toBe(
      false,
    );
    expect(matchesTargetRole("Product Manager", ["Product Designer"])).toBe(
      false,
    );
    expect(matchesTargetRole("Accountant", ["Account Executive"])).toBe(false);
    expect(
      matchesTargetRole("Senior Backend Developer", ["Software Engineer"]),
    ).toBe(true);
    expect(
      matchesTargetRole("Staff Full-Stack Engineer", ["Full Stack Developer"]),
    ).toBe(true);
    expect(
      matchesTargetRole("Customer Support Specialist", ["Customer Support"]),
    ).toBe(true);
    expect(
      matchesTargetRole("Product Designer", [
        "Software Engineer",
        "Product Designer",
      ]),
    ).toBe(true);
    expect(matchesTargetRole("Senior Accountant", ["Senior"])).toBe(false);
    expect(matchesTargetRole("C++ Engineer", ["C++ Developer"])).toBe(true);
    expect(matchesTargetRole("C# Engineer", ["C++ Developer"])).toBe(false);
    expect(
      matchesTargetRole(
        "SaaSOps Engineer ($80,000/year USD), @CXT Software",
        ["Software Engineer"],
        "CXT Software",
      ),
    ).toBe(false);
    expect(
      matchesTargetRole(
        "SaaSOps Engineer ($80,000/year USD), CXT Software",
        ["Software Engineer"],
        "CXT Software",
      ),
    ).toBe(false);
    expect(
      matchesTargetRole(
        "Software Engineer, Acme",
        ["Software Engineer"],
        "Acme",
      ),
    ).toBe(true);
    expect(
      matchesTargetRole("AI-Native VP of Software Engineering, Canada-based", [
        "Software Engineer",
      ]),
    ).toBe(false);
    expect(
      matchesTargetRole("Software Engineering Manager", ["Software Engineer"]),
    ).toBe(false);
    expect(
      matchesTargetRole("Software Engineering Manager", [
        "Engineering Manager",
      ]),
    ).toBe(true);
  });
  it("keeps prepared applications valid when employer discovery is toggled", () => {
    const prefs = demoWorkspace().preferences;
    expect(preferencesFingerprint({ ...prefs, discoverEmployers: true })).toBe(
      preferencesFingerprint({ ...prefs, discoverEmployers: false }),
    );
    expect(
      preferencesFingerprint({
        ...prefs,
        minimumSalary: prefs.minimumSalary + 1,
      }),
    ).not.toBe(preferencesFingerprint(prefs));
  });
  it("adds researched employers without replacing custom or paused sources", () => {
    const paused = {
      ...recommendedSources[0],
      id: "my-gitlab",
      label: "My saved board",
      enabled: false,
      board: "https://job-boards.greenhouse.io/gitlab",
    };
    const existing = [
      paused,
      {
        id: "custom",
        label: "Custom",
        provider: "lever" as const,
        board: "my-company",
        enabled: true,
      },
    ];
    const merged = addRecommendedSources(existing);
    expect(merged.find((s) => s.id === paused.id)).toMatchObject({
      label: "My saved board",
      enabled: false,
      board: "gitlab",
    });
    expect(merged).toHaveLength(recommendedSources.length + 1);
    expect(addRecommendedSources(merged)).toEqual(merged);
    expect(new Set(merged.map((s) => s.id)).size).toBe(merged.length);
  });
  it("keeps valid dotted Ashby boards while rejecting path traversal", async () => {
    const source = recommendedSources.find((s) => s.board === "kraken.com")!;
    expect(
      normalizeSource({
        ...source,
        board: "https://jobs.ashbyhq.com/kraken.com",
      }).board,
    ).toBe("kraken.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [] }))),
    );
    await expect(
      discover(source, demoWorkspace().preferences),
    ).resolves.toEqual([]);
    expect(() => normalizeSource({ ...source, board: "../private" })).toThrow();
  });
  it("imports oversized descriptions with explicit uncertainty rather than failing a whole board", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: "long",
                title: "Engineer",
                descriptionPlain:
                  "Requirements\nReact experience\n" + "a".repeat(60000),
                jobUrl: "https://jobs.ashbyhq.com/ashby/long",
              },
            ],
          }),
        ),
      ),
    );
    const workspace = demoWorkspace();
    const [op] = await discover(
      recommendedSources.find((s) => s.board === "ashby")!,
      workspace.preferences,
    );
    expect(op.description).toHaveLength(50000);
    expect(op.descriptionTruncated).toBe(true);
    const assessment = assessOpportunity(
      op,
      workspace.profile,
      workspace.preferences,
    );
    expect(assessment.recommendation).toBe("review");
    expect(assessment.unknowns.join(" ")).toContain("shortened");
  });
  it("records source provenance across providers without claiming a feed employer is US-based", () => {
    expect(new Set(sourceLibrary.map((r) => r.source.provider))).toEqual(
      new Set(["greenhouse", "ashby", "lever", "jobicy", "weworkremotely"]),
    );
    for (const entry of sourceLibrary.filter(
      (r) => !["jobicy", "weworkremotely"].includes(r.source.provider),
    )) {
      expect(entry.source.countrySource).toMatch(/^https:\/\//);
      expect(entry.source.companyCountry).toBe("United States");
      expect(entry.checkedAt).toBeTruthy();
      expect(entry.observedListings).toBeGreaterThan(0);
    }
    expect(
      sourceLibrary.find((r) => r.source.provider === "jobicy")!.source
        .companyCountry,
    ).toBeUndefined();
  });
  it("avoids ID collisions and refuses additions beyond workspace limits", () => {
    const collision = {
      ...recommendedSources[0],
      board: "another",
      id: recommendedSources[1].id,
    };
    const merged = addRecommendedSources([collision]);
    expect(new Set(merged.map((s) => s.id)).size).toBe(merged.length);
    expect(() =>
      addRecommendedSources(
        Array.from({ length: 50 }, (_, i) => ({
          ...collision,
          id: `id-${i}`,
          board: `company-${i}`,
        })),
      ),
    ).toThrow(/50/);
  });

  it("keeps nontechnical requirements and ignores section headings", () => {
    const requirements = extractRequirements(
      "Requirements\nMust manage enterprise sales accounts\nExcellent communication skills\nNice to have\nSalesforce experience\nBenefits\nFree lunches",
    );
    expect(requirements.map((r) => r.text)).toEqual([
      "Must manage enterprise sales accounts",
      "Excellent communication skills",
      "Salesforce experience",
    ]);
    expect(requirements[2].essential).toBe(false);
  });
  it("does not exclude remote architecture roles mentioning hybrid cloud", () => {
    expect(
      remoteScope("Remote worldwide. Build hybrid cloud infrastructure."),
    ).toBe("worldwide");
    expect(remoteScope("This is a hybrid role with office attendance")).toBe(
      "onsite",
    );
    expect(remoteScope("Work on-site in New York")).toBe("onsite");
  });
  it("normalizes supported board URLs without accepting arbitrary hosts", () => {
    const source = recommendedSources[0];
    expect(
      normalizeSource({ ...source, board: "https://jobs.lever.co/acme/123" }),
    ).toMatchObject({ provider: "lever", board: "acme" });
    expect(() =>
      normalizeSource({ ...source, board: "https://private.example/acme" }),
    ).toThrow();
  });
  it("keeps US employer targeting without treating an unknown employer as a mismatch", () => {
    const workspace = demoWorkspace();
    const op = { ...demoOpportunities()[0], companyCountry: "Unknown" };
    const assessment = assessOpportunity(
      op,
      workspace.profile,
      workspace.preferences,
    );
    expect(assessment.recommendation).toBe("review");
    expect(assessment.blockers).toEqual([]);
    workspace.preferences.companyCountry = "";
    expect(
      assessOpportunity(op, workspace.profile, workspace.preferences)
        .policyUnknowns,
    ).toEqual([]);
  });
  it("inherits employer evidence independently of hiring location", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                title: "Sales",
                content: "<h2>Requirements</h2><p>Customer communication</p>",
                location: { name: "Remote, United States" },
              },
            ],
          }),
        ),
      ),
    );
    const [op] = await discover(
      recommendedSources[0],
      demoWorkspace().preferences,
    );
    expect(op.companyCountry).toBe("United States");
    expect(op.companyCountrySource).toBe(recommendedSources[0].countrySource);
    expect(op.remoteScope).toBe("us");
  });
  it("accepts large trusted boards beyond the previous 2 MB cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ jobs: [] }), {
          headers: { "content-length": "3000000" },
        }),
      ),
    );
    expect(
      await discover(recommendedSources[0], demoWorkspace().preferences),
    ).toEqual([]);
  });
  it("paginates Jobicy with stable identity, attribution and conservative geography", async () => {
    const job = {
      id: 7,
      url: "https://jobicy.com/jobs/7-sales",
      jobTitle: "Sales",
      companyName: "Company",
      jobGeo: "Canada",
      jobDescription: "<h2>Requirements</h2><p>Account management</p>",
    };
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jobs: [job], nextCursor: "next & page" }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [{ ...job, id: 8, jobGeo: "Anywhere" }],
            nextCursor: null,
          }),
        ),
      );
    vi.stubGlobal("fetch", mock);
    const jobs = await discover(
      recommendedSources[2],
      demoWorkspace().preferences,
    );
    expect(jobs.map((op) => op.sourceKey)).toEqual(["jobicy:7", "jobicy:8"]);
    expect(jobs[0].companyCountry).toBe("Unknown");
    expect(jobs[0].remoteScope).toBe("unknown");
    expect(jobs[1].remoteScope).toBe("worldwide");
    expect(jobs[0].notes).toContain("Jobicy");
    expect(new URL(mock.mock.calls[1][0]).searchParams.get("cursor")).toBe(
      "next & page",
    );
  });
  it("counts hiring outcomes even after a rejection, without counting a saved lead as applied", () => {
    expect(
      applicationCounts([
        {
          application: {
            status: "rejected",
            appliedAt: "2026-11-01",
            interviewAt: "2026-11-02",
          },
        },
        { application: { status: "saved" } },
      ]),
    ).toEqual({ applied: 1, interview: 1, offer: 0 });
  });
});
