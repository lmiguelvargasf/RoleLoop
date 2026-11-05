import { describe, expect, it } from "vitest";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";
import { assessOpportunity, draftContentHash } from "../src/domain/rules.js";
import { createDraft } from "../src/domain/templates.js";
import {
  allowedOrigin,
  assertApproved,
  assertFresh,
} from "../src/server/guards.js";

function fixture() {
  const now = new Date("2026-11-05T17:00:00Z");
  const workspace = demoWorkspace();
  const opportunity = demoOpportunities(now)[0];
  const assessment = assessOpportunity(
    opportunity,
    workspace.profile,
    workspace.preferences,
    now,
  );
  const draft = createDraft(
    opportunity,
    workspace.profile,
    workspace.preferences,
    assessment,
  );
  return { workspace, opportunity, draft };
}

function expectConflict(action: () => unknown, message: RegExp) {
  expect(action).toThrow(message);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 409 });
  }
}

describe("draft approval API guards", () => {
  it("allows a fresh draft to be reviewed but requires explicit approval before testing", () => {
    const { draft, opportunity, workspace } = fixture();
    expect(() => assertFresh(draft, opportunity, workspace)).not.toThrow();
    expectConflict(
      () => assertApproved(draft, opportunity, workspace),
      /approve/,
    );
    draft.status = "approved";
    expect(() => assertApproved(draft, opportunity, workspace)).not.toThrow();
  });

  it("allows an unchanged tested draft to reach the idempotent receipt check", () => {
    const { draft, opportunity, workspace } = fixture();
    draft.status = "tested";
    draft.testReceipt = "Mock application accepted locally";
    expect(() => assertApproved(draft, opportunity, workspace)).not.toThrow();
  });

  it("rejects approval after the candidate revokes an evidence verification", () => {
    const { draft, opportunity, workspace } = fixture();
    draft.status = "approved";
    workspace.profile.evidence[0].verified = false;
    expectConflict(() => assertFresh(draft, opportunity, workspace), /changed/);
    expectConflict(
      () => assertApproved(draft, opportunity, workspace),
      /changed/,
    );
  });

  it("rejects approval after hiring geography or recipient facts change", () => {
    for (const patch of [
      { remoteScope: "us" as const },
      { contactEmail: "new-person@example.com" },
    ]) {
      const { draft, opportunity, workspace } = fixture();
      draft.status = "approved";
      Object.assign(opportunity, patch);
      expectConflict(
        () => assertApproved(draft, opportunity, workspace),
        /changed/,
      );
    }
  });

  it("rejects approval when pay, essential coverage, or date selection changes", () => {
    for (const patch of [
      { minimumSalary: 130000 },
      { essentialMatch: 100 },
      { lookback: 0 },
    ]) {
      const { draft, opportunity, workspace } = fixture();
      draft.status = "approved";
      Object.assign(workspace.preferences, patch);
      expectConflict(
        () => assertApproved(draft, opportunity, workspace),
        /changed/,
      );
    }
  });

  it("requires legacy drafts without a preferences fingerprint to be regenerated", () => {
    const { draft, opportunity, workspace } = fixture();
    draft.preferencesFingerprint = "";
    expectConflict(() => assertFresh(draft, opportunity, workspace), /changed/);
  });

  it("detects altered body, résumé, answers, and evidence references", () => {
    for (const edit of [
      (draft: ReturnType<typeof fixture>["draft"]) => {
        draft.body += " Altered claim.";
      },
      (draft: ReturnType<typeof fixture>["draft"]) => {
        draft.resume += " Altered experience.";
      },
      (draft: ReturnType<typeof fixture>["draft"]) => {
        draft.answers[0].answer = "Altered answer";
      },
      (draft: ReturnType<typeof fixture>["draft"]) => {
        draft.evidenceIds = ["unknown-evidence"];
      },
    ]) {
      const { draft, opportunity, workspace } = fixture();
      draft.status = "approved";
      edit(draft);
      expectConflict(
        () => assertApproved(draft, opportunity, workspace),
        /integrity/,
      );
    }
  });

  it("accepts saved edited content for review while still requiring a new approval", () => {
    const { draft, opportunity, workspace } = fixture();
    draft.body += "\nI would welcome a conversation.";
    draft.contentHash = draftContentHash(draft);
    draft.status = "draft";
    expect(() => assertFresh(draft, opportunity, workspace)).not.toThrow();
    expectConflict(
      () => assertApproved(draft, opportunity, workspace),
      /approve/,
    );
  });

  it("does not invalidate content because lifecycle timestamps change", () => {
    const { draft, opportunity, workspace } = fixture();
    draft.status = "approved";
    draft.updatedAt = "2026-11-06T12:00:00Z";
    opportunity.stage = "approved";
    opportunity.updatedAt = "2026-11-06T12:00:00Z";
    expect(() => assertApproved(draft, opportunity, workspace)).not.toThrow();
  });
});

describe("local API origin and host protection", () => {
  const appUrl = "http://127.0.0.1:5173";
  const check = (origin: string | undefined, host: string | undefined) =>
    allowedOrigin(origin, host, appUrl, 4310);

  it("accepts the configured app, localhost alias, and API same-origin requests", () => {
    expect(check("http://127.0.0.1:5173", "127.0.0.1:4310")).toBe(true);
    expect(check("http://localhost:5173", "localhost:4310")).toBe(true);
    expect(check("http://127.0.0.1:4310", "127.0.0.1:4310")).toBe(true);
  });

  it("allows local command-line requests without an Origin while still checking Host", () => {
    expect(check(undefined, "127.0.0.1:4310")).toBe(true);
    expect(check(undefined, "attacker.example:4310")).toBe(false);
    expect(check(undefined, undefined)).toBe(false);
  });

  it.each([
    "https://attacker.example",
    "http://127.0.0.1.attacker.example:5173",
    "http://attacker.example:5173",
    "http://127.0.0.1:9999",
    "https://127.0.0.1:5173",
    "null",
    "not an origin",
  ])("rejects untrusted or malformed Origin %s", (origin) => {
    expect(check(origin, "127.0.0.1:4310")).toBe(false);
  });

  it("rejects a hostile Host even when Origin claims to be the local app", () => {
    expect(check("http://127.0.0.1:5173", "attacker.example:4310")).toBe(false);
    expect(
      check("http://127.0.0.1:5173", "127.0.0.1.attacker.example:4310"),
    ).toBe(false);
  });
});
