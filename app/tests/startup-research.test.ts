import { describe, expect, it, vi } from "vitest";
import { OpportunitySchema, type Opportunity } from "../src/shared/types.js";
import { researchAndSaveOpportunity } from "../src/server/startup-research.js";

const now = Date.parse("2026-11-07T18:00:00.000Z");
const hour = 60 * 60 * 1000;
const week = 7 * 24 * hour;

function setup() {
  const op = OpportunitySchema.parse({
    id: "startup",
    kind: "startup",
    company: "Acme",
    title: "Tools for teams",
    description: "Original useful product description.",
    url: "https://source.example/launch",
    companyUrl: "https://acme.example/",
    source: "hackernews",
    sourceId: "show-hn",
    sourceKey: "hackernews::123",
    firstSeenAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-07T17:00:00.000Z",
    notes: "Keep my research notes.",
    application: {
      status: "saved",
      notes: "Discuss project scope",
      nextAction: "Review company",
    },
  });
  const records = new Map([[op.id, op]]);
  const runtime = new Map<string, unknown>();
  const store = {
    runtime: async <T>(key: string): Promise<T | null> =>
      (runtime.get(key) as T | undefined) ?? null,
    setRuntime: vi.fn(async (key: string, value: unknown) => {
      runtime.set(key, value);
    }),
    saveDerivedOpportunity: vi.fn(
      async (original: Opportunity, next: Opportunity) => {
        const current = records.get(original.id);
        if (!current) return null;
        if (current.updatedAt !== original.updatedAt) return current;
        records.set(original.id, next);
        return next;
      },
    ),
  };
  const read = vi.fn(
    async (): Promise<Partial<Opportunity>> => ({
      description:
        "Company website describes collaboration tools and current product needs.",
      notes: `${op.notes}\nWebsite inspected.`,
      contactEmail: "hello@acme.example",
      contactSource: "https://acme.example/",
    }),
  );
  return {
    op,
    records,
    runtime,
    store,
    read,
    key: `company-research:${op.id}`,
  };
}

describe("startup website research lifecycle", () => {
  it("saves research once and reuses a successful result for seven days", async () => {
    const t = setup();
    const result = await researchAndSaveOpportunity(t.store, t.op, {
      read: t.read,
      now,
    });
    expect(result.researched).toBe(true);
    expect(result.opportunity.description).toContain("current product needs");
    expect(result.opportunity.application).toEqual(t.op.application);
    expect(result.opportunity.sourceKey).toBe(t.op.sourceKey);
    expect(t.runtime.get(t.key)).toEqual({ at: now, url: t.op.companyUrl });

    const cached = await researchAndSaveOpportunity(
      t.store,
      result.opportunity,
      { read: t.read, now: now + week - 1 },
    );
    expect(cached).toEqual({
      opportunity: result.opportunity,
      researched: false,
    });
    expect(t.read).toHaveBeenCalledTimes(1);
    expect(t.store.saveDerivedOpportunity).toHaveBeenCalledTimes(1);
    await researchAndSaveOpportunity(t.store, result.opportunity, {
      read: t.read,
      now: now + week,
    });
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cache for a changed company website or a future timestamp", async () => {
    const t = setup();
    t.runtime.set(t.key, { at: now - hour, url: "https://old.example/" });
    await researchAndSaveOpportunity(t.store, t.op, { read: t.read, now });
    expect(t.read).toHaveBeenCalledTimes(1);
    t.runtime.set(t.key, { at: now + hour, url: t.op.companyUrl });
    await researchAndSaveOpportunity(t.store, t.records.get(t.op.id)!, {
      read: t.read,
      now: now + 1,
    });
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it("backs off failed websites for one hour without changing the saved prospect", async () => {
    const t = setup();
    const read = vi
      .fn()
      .mockRejectedValue(new Error("Website returned HTTP 503."));
    await expect(
      researchAndSaveOpportunity(t.store, t.op, { read, now }),
    ).rejects.toThrow("503");
    await expect(
      researchAndSaveOpportunity(t.store, t.op, { read, now: now + hour - 1 }),
    ).rejects.toThrow("503");
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.store.saveDerivedOpportunity).not.toHaveBeenCalled();
    expect(t.records.get(t.op.id)).toEqual(t.op);
    await researchAndSaveOpportunity(t.store, t.op, {
      read: t.read,
      now: now + hour,
    });
    expect(t.read).toHaveBeenCalledTimes(1);
    expect(t.runtime.get(t.key)).toEqual({
      at: now + hour,
      url: t.op.companyUrl,
    });
  });

  it("bounds cached failure diagnostics", async () => {
    const t = setup();
    await expect(
      researchAndSaveOpportunity(t.store, t.op, {
        read: vi.fn().mockRejectedValue(new Error("x".repeat(1000))),
        now,
      }),
    ).rejects.toThrow("x".repeat(300));
    expect((t.runtime.get(t.key) as { error: string }).error).toHaveLength(300);
  });

  it.each([undefined, "Website failed earlier"])(
    "explicit research bypasses a fresh cache (previous error: %s)",
    async (error) => {
      const t = setup();
      t.runtime.set(t.key, {
        at: now - 1,
        url: t.op.companyUrl,
        ...(error ? { error } : {}),
      });
      const result = await researchAndSaveOpportunity(t.store, t.op, {
        force: true,
        read: t.read,
        now,
      });
      expect(t.read).toHaveBeenCalledTimes(1);
      expect(result.researched).toBe(true);
      expect(t.runtime.get(t.key)).toEqual({ at: now, url: t.op.companyUrl });
    },
  );

  it("applies saved corrections after website facts and preserves workflow history", async () => {
    const t = setup();
    t.runtime.set(`corrections:${t.op.id}`, {
      description: "My corrected company description.",
      contactEmail: "verified@acme.example",
      contactSource: "https://acme.example/contact",
      notes: "My corrected notes.",
    });
    const result = await researchAndSaveOpportunity(t.store, t.op, {
      read: t.read,
      now,
    });
    expect(result.opportunity).toMatchObject({
      description: "My corrected company description.",
      contactEmail: "verified@acme.example",
      contactSource: "https://acme.example/contact",
      notes: "My corrected notes.",
      stage: t.op.stage,
      application: t.op.application,
      id: t.op.id,
      sourceKey: t.op.sourceKey,
    });
  });

  it("keeps concurrent user edits and does not cache a rejected research write", async () => {
    const t = setup();
    const edited = {
      ...t.op,
      description: "User edited this while research ran.",
      updatedAt: new Date(now + 1).toISOString(),
    };
    const read = vi.fn(async () => {
      t.records.set(t.op.id, edited);
      return { description: "Website description" };
    });
    const result = await researchAndSaveOpportunity(t.store, t.op, {
      read,
      now,
    });
    expect(result).toEqual({ opportunity: edited, researched: false });
    expect(t.runtime.has(t.key)).toBe(false);
  });

  it("does not call a rejected notes-only research write successful after concurrent archival", async () => {
    const t = setup();
    const archived: Opportunity = {
      ...t.op,
      stage: "archived",
      notes: "Archived by user",
      updatedAt: new Date(now + 1).toISOString(),
    };
    const read = vi.fn(async () => {
      t.records.set(t.op.id, archived);
      return {
        description: t.op.description,
        notes: "New website research notes",
      };
    });
    const result = await researchAndSaveOpportunity(t.store, t.op, {
      read,
      now,
    });
    expect(result).toEqual({ opportunity: archived, researched: false });
    expect(t.runtime.has(t.key)).toBe(false);
  });

  it("does not recreate a prospect deleted during research", async () => {
    const t = setup();
    const read = vi.fn(async () => {
      t.records.delete(t.op.id);
      return { description: "Website description" };
    });
    await expect(
      researchAndSaveOpportunity(t.store, t.op, { read, now }),
    ).rejects.toThrow("removed");
    expect(t.records.has(t.op.id)).toBe(false);
    expect(t.runtime.has(t.key)).toBe(false);
  });

  it("preserves the discovery description when the website has no readable product information", async () => {
    const t = setup();
    const read = vi
      .fn()
      .mockResolvedValue({
        description: "  \n",
        descriptionTruncated: false,
        notes: "Website inspected",
      });
    await expect(
      researchAndSaveOpportunity(t.store, t.op, { read, now }),
    ).rejects.toThrow();
    expect(t.records.get(t.op.id)?.description).toBe(t.op.description);
    expect(t.store.saveDerivedOpportunity).not.toHaveBeenCalled();
    expect(t.runtime.get(t.key)).toMatchObject({
      at: now,
      url: t.op.companyUrl,
      error: expect.any(String),
    });
  });
});
