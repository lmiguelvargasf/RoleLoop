import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  extractRequirements,
  remoteScope,
} from "../src/domain/connectors.js";
import {
  normalizeSource,
  recommendedSources,
  applicationCounts,
} from "../src/shared/discovery.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { demoWorkspace, demoOpportunities } from "./fixtures.js";
afterEach(() => vi.unstubAllGlobals());

describe("practical discovery", () => {
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
        .recommendation,
    ).toBe("ready");
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
      vi
        .fn()
        .mockResolvedValue(
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
