import { describe, expect, it } from "vitest";
import {
  mergeDiscoverySignals,
  mergeStartupProspect,
  startupIdentity,
  startupWebsiteIdentity,
} from "../src/domain/startup-identity.js";
import { demoOpportunities } from "./fixtures.js";
import type { Opportunity } from "../src/shared/types.js";

function prospect(patch: Partial<Opportunity> = {}): Opportunity {
  return {
    ...demoOpportunities().find((op) => op.kind === "startup")!,
    isDemo: false,
    company: "example.test",
    companyUrl: "https://www.example.test/product?ref=hn",
    url: "https://example.test/product?ref=hn",
    source: "hackernews",
    sourceKey: "hackernews::12345",
    publishedAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

describe("startup company identity", () => {
  it.each([
    ["https://www.Example.test/product?ref=hn", "example.test"],
    ["http://example.test:80/", "example.test"],
    ["https://example.test.:443/about", "example.test"],
    ["https://team.github.io/project", "team.github.io"],
    ["https://a.substack.com/p/hello", "a.substack.com"],
    ["https://other.example.test/", "other.example.test"],
    ["https://github.com/team/project", null],
    ["https://www.producthunt.com/posts/project", null],
    ["https://seedcamp.com/companies/example/", null],
    ["https://news.ycombinator.com/item?id=1", null],
    ["https://medium.com/@author/story", null],
    ["https://localhost/", null],
    ["https://127.0.0.1/", null],
    ["https://example.test:4310/", null],
    ["https://user@example.test/", null],
    ["javascript:alert(1)", null],
    ["not a website", null],
  ])(
    "normalizes %s without merging unrelated hosted projects",
    (url, expected) => {
      expect(startupWebsiteIdentity(url)).toBe(expected);
    },
  );

  it("never assigns startup identity to jobs or samples", () => {
    expect(startupIdentity(prospect({ kind: "job" }))).toBeNull();
    expect(startupIdentity(prospect({ isDemo: true }))).toBeNull();
  });

  it("preserves dated signals from each source without repeating keyword matches", () => {
    const original = prospect();
    const signals = mergeDiscoverySignals(
      original,
      prospect({ sourceKey: "hackernews:tools:12345" }),
      prospect({
        source: "seedcamp",
        sourceKey: "seedcamp:example",
        url: "https://seedcamp.com/companies/example/",
        publishedAt: null,
      }),
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      url: "https://news.ycombinator.com/item?id=12345",
      publishedAt: original.publishedAt,
    });
    expect(signals[1]).toMatchObject({
      source: "seedcamp",
      url: "https://seedcamp.com/companies/example/",
      publishedAt: null,
    });
    expect(
      mergeDiscoverySignals(
        prospect({ source: "manual", sourceKey: "manual:1", url: "" }),
      ),
    ).toEqual([]);
  });

  it("retains researched text, sourced contact, manual corrections and workflow across thin feed refreshes", () => {
    const old = prospect({
      company: "Reviewed company name",
      description:
        "Detailed company website research with product needs and existing customer workflow information.",
      contactName: "Reviewed founder",
      contactEmail: "founder@example.test",
      contactSource: "https://example.test/about",
      companyCountry: "United States",
      companyCountrySource: "https://example.test/legal",
      remoteScope: "worldwide",
      stage: "archived",
      notes: "Do not lose this note",
      application: {
        status: "applied",
        appliedAt: "2026-11-01T00:00:00Z",
        notes: "Conversation already started",
        nextAction: "Wait",
        followUpOn: null,
      },
    });
    const incoming = prospect({
      id: "new-id",
      source: "seedcamp",
      sourceKey: "seedcamp:example",
      url: "https://seedcamp.com/companies/example/",
      description: "Short directory summary.",
      companyCountry: "Unknown",
      companyCountrySource: undefined,
      remoteScope: "unknown",
      contactName: "",
      contactEmail: "",
      contactSource: "",
      publishedAt: null,
      signals: ["Listed in the Seedcamp portfolio"],
    });
    const merged = mergeStartupProspect(old, incoming, {
      title: "My reviewed prospect",
    });
    expect(merged).toMatchObject({
      id: old.id,
      company: old.company,
      source: old.source,
      sourceKey: old.sourceKey,
      description: old.description,
      contactEmail: old.contactEmail,
      contactSource: old.contactSource,
      companyCountry: old.companyCountry,
      companyCountrySource: old.companyCountrySource,
      remoteScope: old.remoteScope,
      notes: old.notes,
      stage: old.stage,
      application: old.application,
      publishedAt: old.publishedAt,
      title: "My reviewed prospect",
    });
    expect(merged.discoverySignals).toHaveLength(2);
    expect(merged.signals).toContain("Listed in the Seedcamp portfolio");
  });
});
