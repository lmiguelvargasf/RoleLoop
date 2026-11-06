import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, clearApiContext, downloadFile, setApiContext } from "./api";

const dispatch = vi.fn();
const useAlice = () =>
  setApiContext({
    token: "alice-access-token",
    userId: "alice",
    workspaceId: "alice-workspace",
  });
const useBob = () =>
  setApiContext({
    token: "bob-access-token",
    userId: "bob",
    workspaceId: "bob-workspace",
  });
beforeEach(() => {
  clearApiContext();
  dispatch.mockClear();
  vi.stubGlobal("window", { dispatchEvent: dispatch });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearApiContext();
});

describe("authenticated UI request boundaries", () => {
  it("sends the current account token and selected workspace on API calls", async () => {
    useAlice();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetcher);
    expect(await api("/bootstrap")).toEqual({ ok: true });
    const [path, options] = fetcher.mock.calls[0];
    expect(path).toBe("/api/bootstrap");
    const headers = new Headers(options.headers);
    expect(headers.get("Authorization")).toBe("Bearer alice-access-token");
    expect(headers.get("X-Workspace-Id")).toBe("alice-workspace");
  });
  it("drops a response if the account changed while the request was pending", async () => {
    useAlice();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const request = api("/bootstrap");
    useBob();
    resolve(new Response(JSON.stringify({ privateAliceData: true })));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("also rejects an old JSON body that finishes after a workspace switch", async () => {
    useAlice();
    let finishBody!: (value: unknown) => void;
    let reading!: () => void;
    const readingBody = new Promise<void>((done) => {
      reading = done;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => {
          reading();
          return new Promise((done) => {
            finishBody = done;
          });
        },
      }),
    );
    const request = api("/bootstrap");
    await readingBody;
    setApiContext({
      token: "alice-access-token",
      userId: "alice",
      workspaceId: "managed-workspace",
    });
    finishBody({ privateAliceData: true });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not download an old workspace file after account switching", async () => {
    useAlice();
    let finishBlob!: (value: Blob) => void;
    let reading!: () => void;
    const readingBody = new Promise<void>((done) => {
      reading = done;
    });
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => {
          reading();
          return new Promise((done) => {
            finishBlob = done;
          });
        },
        headers: new Headers(),
      }),
    );
    const request = downloadFile(
      "/drafts/alice/download?format=pdf",
      "alice.pdf",
    );
    await readingBody;
    useBob();
    finishBlob(new Blob(["private résumé"]));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(createElement).not.toHaveBeenCalled();
  });
  it("notifies the current view when its session is rejected", async () => {
    useAlice();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401,
        }),
      ),
    );
    await expect(api("/bootstrap")).rejects.toMatchObject({ status: 401 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].detail).toEqual({
      status: 401,
      workspaceId: "alice-workspace",
    });
  });
  it("does not sign out the new account when an old request is rejected", async () => {
    useAlice();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const request = api("/bootstrap");
    useBob();
    resolve(
      new Response(JSON.stringify({ error: "Old session expired" }), {
        status: 401,
      }),
    );
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps the current view when an invalid setup key returns a normal 403", async () => {
    useAlice();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: "The setup key is invalid or expired." }),
            { status: 403 },
          ),
        ),
    );
    await expect(
      api("/account/claim-owner", {
        method: "POST",
        body: JSON.stringify({ token: "invalid" }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("refreshes workspace access only for a membership-denial response", async () => {
    useAlice();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: "Workspace access denied",
              code: "WORKSPACE_ACCESS_DENIED",
            }),
            { status: 403 },
          ),
        ),
    );
    await expect(api("/bootstrap")).rejects.toMatchObject({ status: 403 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].detail).toEqual({
      status: 403,
      workspaceId: "alice-workspace",
    });
  });
  it("removes authentication and workspace headers on sign-out", async () => {
    useAlice();
    clearApiContext();
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await api("/auth/config");
    const headers = new Headers(fetcher.mock.calls[0][1].headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-Workspace-Id")).toBe(false);
  });
});
