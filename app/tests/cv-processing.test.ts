import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCV, retryCV } from "../src/server/cv.js";
import { extractFacts, readResume } from "../src/server/resume-import.js";
import type { WorkspaceStore } from "../src/server/store.js";
import {
  ProfileSchema,
  type Profile,
  type Workspace,
} from "../src/shared/types.js";
import {
  CV_EXTRACTION_TIMEOUT_MS,
  CV_PROCESSING_GRACE_MS,
  resumeProcessingActive,
} from "../src/shared/resume-processing.js";
import { demoWorkspace } from "./fixtures.js";

vi.mock("../src/server/resume-import.js", () => ({
  extractFacts: vi.fn(),
  readResume: vi.fn(),
}));

const now = Date.parse("2026-11-06T16:00:00Z");
const extracted = () => ({
  facts: demoWorkspace().profile.cache!.facts!,
  warnings: [],
});
function storeFor(profile = demoWorkspace().profile) {
  let current = { ...demoWorkspace(), profile: structuredClone(profile) };
  const download = vi.fn(async () => ({
    data: new Blob(["Stored original"]),
    error: null,
  }));
  const updateWorkspace = vi.fn(
    async (patch: Partial<Workspace>, expected?: Profile) => {
      if (
        expected &&
        JSON.stringify(expected) !== JSON.stringify(current.profile)
      )
        throw Object.assign(
          new Error("The master CV changed during processing."),
          { statusCode: 409 },
        );
      current = structuredClone({ ...current, ...patch });
      return structuredClone(current);
    },
  );
  const store = {
    workspaceId: "test-workspace",
    getWorkspace: vi.fn(async () => structuredClone(current)),
    updateWorkspace,
    event: vi.fn(async () => {}),
    db: { storage: { from: () => ({ download }) } },
  } as unknown as WorkspaceStore;
  return { store, download, updateWorkspace };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.mocked(extractFacts).mockResolvedValue(extracted());
  vi.mocked(readResume).mockResolvedValue({
    text: "Stored source text",
    kind: "pdf",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("bounded resume processing", () => {
  it("retains parser limitations with AI extraction notes", async () => {
    const profile = demoWorkspace().profile;
    const { store } = storeFor(profile);
    const note = "Some embedded links could not be read.";
    vi.mocked(extractFacts).mockResolvedValueOnce({
      ...extracted(),
      warnings: [note, "Dates need review."],
    });
    const result = await processCV(store, profile, "Source text", "test-user", [
      note,
    ]);
    expect(result.cache?.warnings).toEqual([note, "Dates need review."]);
  });

  it("does not default new metadata into legacy caches or extend their lifetime", () => {
    const profile = demoWorkspace().profile;
    expect(ProfileSchema.parse(profile)).toEqual(profile);
    profile.cache!.status = "processing";
    expect(resumeProcessingActive(profile.cache, now)).toBe(false);
    for (const expiresAt of [
      "invalid",
      new Date(now).toISOString(),
      new Date(now - 1).toISOString(),
    ]) {
      expect(
        resumeProcessingActive({ ...profile.cache!, expiresAt }, now),
      ).toBe(false);
    }
    const live = {
      ...profile.cache!,
      expiresAt: new Date(now + 1).toISOString(),
    };
    expect(resumeProcessingActive(live, now)).toBe(true);
    expect(resumeProcessingActive({ ...live, status: "ready" }, now)).toBe(
      false,
    );
    expect(resumeProcessingActive(null, now)).toBe(false);
  });

  it("shares an active attempt across retries without another document read or AI request", async () => {
    const profile = demoWorkspace().profile;
    const { store, download } = storeFor(profile);
    let finish!: (value: ReturnType<typeof extracted>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(extractFacts).mockImplementationOnce(async () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = processCV(store, profile, "Source text", "test-user");
    await started;
    try {
      const duplicate = await retryCV(store, "test-user");
      expect(duplicate.cache).toMatchObject({
        status: "processing",
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(
          now + CV_EXTRACTION_TIMEOUT_MS + CV_PROCESSING_GRACE_MS,
        ).toISOString(),
      });
      expect(extractFacts).toHaveBeenCalledTimes(1);
      expect(download).not.toHaveBeenCalled();
      expect(readResume).not.toHaveBeenCalled();
    } finally {
      finish(extracted());
    }
    const ready = await pending;
    expect(ready.cache?.status).toBe("ready");
    expect(await retryCV(store, "test-user")).toEqual(ready);
    expect(extractFacts).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "legacy"])(
    "retries %s processing from the saved original",
    async (kind) => {
      const profile = demoWorkspace().profile;
      profile.cache!.status = "processing";
      profile.cache!.facts = null;
      if (kind === "expired")
        profile.cache!.expiresAt = new Date(now - 1).toISOString();
      const { store, download, updateWorkspace } = storeFor(profile);
      const ready = await retryCV(store, "test-user");
      expect(download).toHaveBeenCalledWith(
        `test-workspace/resumes/${profile.source!.id}/original.${profile.source!.kind}`,
      );
      expect(extractFacts).toHaveBeenCalledExactlyOnceWith(
        "Stored source text",
        "test-user",
      );
      expect(ready.source).toEqual(profile.source);
      expect(ready.cache?.id).not.toBe(profile.cache!.id);
      expect(ready.cache?.status).toBe("ready");
      expect(updateWorkspace.mock.calls[0][1]).toEqual(profile);
    },
  );

  it("lets only one concurrent retry claim an expired attempt before requesting AI", async () => {
    const profile = demoWorkspace().profile;
    profile.cache!.status = "processing";
    profile.cache!.facts = null;
    profile.cache!.expiresAt = new Date(now - 1).toISOString();
    const { store } = storeFor(profile);
    const results = await Promise.allSettled([
      retryCV(store, "test-user"),
      retryCV(store, "test-user"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(extractFacts).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error("Request aborted"), { code: "ai_timeout" }),
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
    new Error("The operation was aborted due to timeout"),
  ])(
    "stores actionable timeout metadata and keeps the original",
    async (failure) => {
      const profile = demoWorkspace().profile;
      const { store } = storeFor(profile);
      vi.mocked(extractFacts).mockRejectedValueOnce(failure);
      const result = await processCV(
        store,
        profile,
        "Source text",
        "test-user",
      );
      expect(result.source).toEqual(profile.source);
      expect(result.cache).toMatchObject({
        status: "failed",
        facts: null,
        errorCode: "ai_timeout",
        error: expect.stringMatching(
          /AI took too long.*original is saved.*Retry extraction.*do not need to upload/,
        ),
      });
      expect(result.cache!.processedAt).not.toBeNull();
      const retried = await retryCV(store, "test-user");
      expect(retried.cache?.status).toBe("ready");
      expect(retried.cache).not.toHaveProperty("errorCode");
      expect(retried.source).toEqual(profile.source);
    },
  );

  it("preserves useful non-timeout error messages without misclassifying them", async () => {
    const profile = demoWorkspace().profile;
    const { store } = storeFor(profile);
    vi.mocked(extractFacts).mockRejectedValueOnce(
      Object.assign(new Error("Reconnect your ChatGPT account."), {
        code: "chatgpt_unavailable",
      }),
    );
    const result = await processCV(store, profile, "Source text", "test-user");
    expect(result.cache).toMatchObject({
      status: "failed",
      error: "Reconnect your ChatGPT account.",
      errorCode: "chatgpt_unavailable",
    });
  });
});
