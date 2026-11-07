import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assessOpportunity } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import { startupWebsiteIdentity } from "../src/domain/startup-identity.js";
import type { Opportunity } from "../src/shared/types.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

const integration =
  process.env.ROLELOOP_INTEGRATION === "1" ? describe : describe.skip;

async function setup() {
  const { db, createWorkspaceStore } = await import("../src/server/store.js");
  const workspaceId = `startup-store-${randomUUID()}`;
  const inserted = await db
    .from("workspace")
    .insert({ id: workspaceId, payload: demoWorkspace() });
  if (inserted.error) throw inserted.error;
  const store = createWorkspaceStore({ workspaceId, client: db });
  const cleanup = async () => {
    for (const table of [
      "drafts",
      "runs",
      "events",
      "opportunities",
      "workspace_runtime",
    ]) {
      const result = await db
        .from(table)
        .delete()
        .eq("workspace_id", workspaceId);
      if (result.error) throw result.error;
    }
    const result = await db.from("workspace").delete().eq("id", workspaceId);
    if (result.error) throw result.error;
  };
  return { store, db, cleanup };
}

function prospect(patch: Partial<Opportunity> = {}): Opportunity {
  return {
    ...demoOpportunities().find((op) => op.kind === "startup")!,
    id: randomUUID(),
    isDemo: false,
    source: "hackernews",
    sourceId: "",
    sourceKey: "hackernews::12345",
    company: "example.test",
    companyUrl: "https://www.example.test/product?ref=hn",
    url: "https://example.test/product?ref=hn",
    publishedAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

integration("startup source merging", () => {
  it("atomically imports one company from concurrent sources and keeps workspace isolation", async () => {
    const a = await setup();
    const b = await setup();
    try {
      const hn = prospect();
      const seedcamp = prospect({
        source: "seedcamp",
        sourceKey: "seedcamp:example",
        company: "Example",
        companyUrl: "http://example.test/",
        url: "https://seedcamp.com/companies/example/",
        publishedAt: null,
      });
      const results = await Promise.all([
        a.store.importOpportunityWithStatus(hn),
        a.store.importOpportunityWithStatus(seedcamp),
      ]);
      expect(results.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ]);
      expect(results[0].opportunity.id).toBe(results[1].opportunity.id);
      const saved = await a.store.list("opportunities");
      expect(saved).toHaveLength(1);
      expect(
        saved[0].discoverySignals?.map((signal) => signal.source).sort(),
      ).toEqual(["hackernews", "seedcamp"]);
      expect(
        (await b.store.importOpportunityWithStatus(prospect())).created,
      ).toBe(true);
      expect(await b.store.list("opportunities")).toHaveLength(1);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("keeps researched fields, manual corrections, archives, application history and draft contents", async () => {
    const t = await setup();
    try {
      const original = (await t.store.importOpportunityWithStatus(prospect()))
        .opportunity;
      const saved: Opportunity = {
        ...original,
        stage: "archived",
        description:
          "Company website research with detailed product context. ".repeat(30),
        contactEmail: "founder@example.test",
        contactSource: "https://example.test/team",
        notes: "User's private notes",
        application: {
          status: "applied",
          appliedAt: "2026-11-02T00:00:00Z",
          notes: "History",
          nextAction: "Wait",
          followUpOn: null,
        },
      };
      await t.store.save("opportunities", saved);
      await t.store.setRuntime(`corrections:${saved.id}`, {
        company: "My corrected name",
      });
      const workspace = demoWorkspace();
      const draft = createDraft(
        saved,
        workspace.profile,
        workspace.preferences,
        assessOpportunity(saved, workspace.profile, workspace.preferences),
      );
      await t.store.save("drafts", draft);
      const result = await t.store.importOpportunityWithStatus(
        prospect({
          source: "seedcamp",
          sourceKey: "seedcamp:example",
          url: "https://seedcamp.com/companies/example/",
          description: "Brief directory description",
          contactEmail: "",
          contactSource: "",
        }),
      );
      expect(result.created).toBe(false);
      expect(result.opportunity).toMatchObject({
        id: saved.id,
        company: "My corrected name",
        stage: "archived",
        description: saved.description,
        contactEmail: saved.contactEmail,
        contactSource: saved.contactSource,
        notes: saved.notes,
        application: saved.application,
      });
      expect(result.opportunity.discoverySignals).toHaveLength(2);
      expect((await t.store.get("drafts", draft.id)).body).toBe(draft.body);
      expect((await t.store.get("drafts", draft.id)).opportunityId).toBe(
        saved.id,
      );
    } finally {
      await t.cleanup();
    }
  });

  it("merges both sources when concurrent updates read the same company snapshot", async () => {
    const t = await setup();
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await t.store.importOpportunity(prospect());
      const from = t.db.from.bind(t.db);
      let arrivals = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      spy = vi.spyOn(t.db, "from").mockImplementation((table: string) => {
        const builder = from(table);
        if (table === "workspace_runtime") {
          const select = builder.select.bind(builder);
          Object.assign(builder, {
            select: (...args: Parameters<typeof select>) => {
              const query = select(...args);
              const read = query.maybeSingle.bind(query);
              Object.assign(query, {
                maybeSingle: async () => {
                  const result = await read();
                  if (arrivals < 2) {
                    arrivals++;
                    if (arrivals === 2) release();
                    await barrier;
                  }
                  return result;
                },
              });
              return query;
            },
          });
        }
        return builder;
      });
      await Promise.all([
        t.store.importOpportunity(
          prospect({ sourceKey: "hackernews::67890", title: "Another launch" }),
        ),
        t.store.importOpportunity(
          prospect({
            source: "seedcamp",
            sourceKey: "seedcamp:example",
            url: "https://seedcamp.com/companies/example/",
          }),
        ),
      ]);
      spy.mockRestore();
      spy = undefined;
      const [saved] = await t.store.list("opportunities");
      expect(arrivals).toBe(2);
      expect(saved.discoverySignals).toHaveLength(3);
      expect(
        new Set(saved.discoverySignals?.map((signal) => signal.sourceKey)).size,
      ).toBe(3);
    } finally {
      spy?.mockRestore();
      await t.cleanup();
    }
  });

  it("enforces website identity at the database boundary without merging projects on shared hosts", async () => {
    const t = await setup();
    try {
      const first = await t.store.importOpportunity(prospect());
      await expect(
        t.store.save("opportunities", prospect({ sourceKey: "other:source" })),
      ).rejects.toThrow();
      expect((await t.store.list("opportunities")).map((op) => op.id)).toEqual([
        first.id,
      ]);
      for (const project of ["first", "second"]) {
        await t.store.importOpportunity(
          prospect({
            sourceKey: `hackernews:${project}`,
            companyUrl: `https://github.com/team/${project}`,
            url: `https://github.com/team/${project}`,
          }),
        );
      }
      expect(await t.store.list("opportunities")).toHaveLength(3);
      for (const url of [
        "https://www.Example.test/about",
        "http://example.test:80/",
        "https://example.test.:443/about",
        "https://github.com/a/b",
        "https://team.github.io/",
        "https://user@example.test/",
      ]) {
        const result = await t.db.rpc("startup_website_identity", {
          website: url,
        });
        if (result.error) throw result.error;
        expect(result.data).toBe(startupWebsiteIdentity(url));
      }
    } finally {
      await t.cleanup();
    }
  });

  it("preserves a concurrent user edit while still adding the newly discovered signal", async () => {
    const t = await setup();
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const original = await t.store.importOpportunity(prospect());
      const edited: Opportunity = {
        ...original,
        // Reusing the JSON timestamp exercises the precise SQL concurrency gate.
        description: "My corrected description.",
        contactEmail: "reviewed@example.test",
        contactSource: "https://example.test/contact",
        stage: "archived",
        notes: "Keep my decision",
      };
      const from = t.db.from.bind(t.db);
      let raced = false;
      spy = vi.spyOn(t.db, "from").mockImplementation((table: string) => {
        const builder = from(table);
        if (table === "workspace_runtime") {
          const select = builder.select.bind(builder);
          Object.assign(builder, {
            select: (...args: Parameters<typeof select>) => {
              const query = select(...args);
              const read = query.maybeSingle.bind(query);
              Object.assign(query, {
                maybeSingle: async () => {
                  const result = await read();
                  if (!raced) {
                    raced = true;
                    await t.store.save("opportunities", edited);
                  }
                  return result;
                },
              });
              return query;
            },
          });
        }
        return builder;
      });
      const result = await t.store.importOpportunity(
        prospect({
          source: "seedcamp",
          sourceKey: "seedcamp:example",
          url: "https://seedcamp.com/companies/example/",
          description:
            "This longer incoming description must not replace the user's concurrent correction. ".repeat(
              10,
            ),
        }),
      );
      expect(raced).toBe(true);
      expect(result).toMatchObject({
        description: edited.description,
        contactEmail: edited.contactEmail,
        stage: "archived",
        notes: edited.notes,
      });
      expect(result.discoverySignals).toHaveLength(2);
    } finally {
      spy?.mockRestore();
      await t.cleanup();
    }
  });

  it.each(["before read", "after read"])(
    "keeps a same-timestamp user edit %s when website research finishes",
    async (timing) => {
      const t = await setup();
      let spy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const original = await t.store.importOpportunity(prospect());
        const edited: Opportunity = {
          ...original,
          stage: "archived",
          notes: "User decision during research",
        };
        let raced = false;
        if (timing === "before read") {
          await t.store.save("opportunities", edited);
        } else {
          const from = t.db.from.bind(t.db);
          spy = vi.spyOn(t.db, "from").mockImplementation((table: string) => {
            const builder = from(table);
            if (table === "opportunities") {
              const update = builder.update.bind(builder);
              Object.assign(builder, {
                update: (...args: Parameters<typeof update>) => {
                  const query = update(...args);
                  const execute = query.maybeSingle.bind(query);
                  Object.assign(query, {
                    maybeSingle: async () => {
                      if (!raced) {
                        raced = true;
                        await t.store.save("opportunities", edited);
                      }
                      return execute();
                    },
                  });
                  return query;
                },
              });
            }
            return builder;
          });
        }
        const result = await t.store.saveDerivedOpportunity(original, {
          ...original,
          description: "New website research",
          updatedAt: new Date().toISOString(),
        });
        if (timing === "after read") expect(raced).toBe(true);
        expect(result).toMatchObject({
          stage: "archived",
          notes: edited.notes,
          updatedAt: original.updatedAt,
          description: original.description,
        });
        expect(await t.store.get("opportunities", original.id)).toEqual(result);
      } finally {
        spy?.mockRestore();
        await t.cleanup();
      }
    },
  );
});
