import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settings } from "../src/server/config.js";
import { structuredAI } from "../src/server/ai.js";
import { completedResponse } from "../src/server/openai-stream.js";
import { chatgptCredential, suspendChatGPT } from "../src/server/chatgpt.js";

vi.mock("../src/server/chatgpt.js", async (original) => ({
  ...(await original<typeof import("../src/server/chatgpt.js")>()),
  chatgptCredential: vi.fn(),
  suspendChatGPT: vi.fn(),
}));

const originalKey = settings.openaiKey;
const schema = z.object({ value: z.string() });
const terminal = (value = "ok") => ({
  type: "response.completed",
  response: {
    status: "completed",
    output: [
      { content: [{ type: "output_text", text: JSON.stringify({ value }) }] },
    ],
  },
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

beforeEach(() => {
  settings.openaiKey = "test-api-key";
  vi.mocked(chatgptCredential).mockReset().mockResolvedValue(null);
  vi.mocked(suspendChatGPT).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  settings.openaiKey = originalKey;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded AI requests", () => {
  it.each([90_000, 300_000])(
    "aborts at the chosen %i ms deadline without retry or billing fallback",
    async (timeoutMs) => {
      vi.useFakeTimers();
      vi.mocked(chatgptCredential).mockResolvedValue({
        token: "test-plan-token",
        model: "selected-model",
      });
      const fetcher = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(init.signal!.reason),
            );
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const request = structuredAI(
        schema,
        "test",
        "instructions",
        {},
        "test-user",
        timeoutMs === 90_000 ? {} : { timeoutMs },
      );
      const failed = expect(request).rejects.toMatchObject({
        code: "ai_timeout",
        statusCode: 504,
        message: "The AI request timed out. Try again.",
      });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1].signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer test-plan-token",
      });
      expect(suspendChatGPT).toHaveBeenCalledWith(
        "test-user",
        "test-plan-token",
        expect.objectContaining({ code: "ai_timeout" }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears the deadline immediately after a successful response", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(terminal().response)));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      structuredAI(schema, "test", "instructions", {}),
    ).resolves.toEqual({ value: "ok" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it("reports the typed deadline when an in-progress response body is aborted", async () => {
    vi.useFakeTimers();
    vi.mocked(chatgptCredential).mockResolvedValue({
      token: "test-plan-token",
      model: "selected-model",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    frame({
                      type: "response.output_text.delta",
                      delta: "partial",
                    }),
                  ),
                );
                init.signal!.addEventListener("abort", () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                );
              },
            }),
          ),
      ),
    );
    const request = structuredAI(
      schema,
      "test",
      "instructions",
      {},
      "test-user",
    );
    const failed = expect(request).rejects.toMatchObject({
      code: "ai_timeout",
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same deadline for credential preflight and inference", async () => {
    vi.useFakeTimers();
    vi.mocked(chatgptCredential).mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                token: "test-plan-token",
                model: "selected-model",
              }),
            80_000,
          ),
        ),
    );
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const request = structuredAI(
      schema,
      "test",
      "instructions",
      {},
      "test-user",
    );
    const failed = expect(request).rejects.toMatchObject({
      code: "ai_timeout",
    });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never sends late inference if credential preflight outlasts the deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(chatgptCredential).mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                token: "test-plan-token",
                model: "selected-model",
              }),
            100_000,
          ),
        ),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const request = structuredAI(
      schema,
      "test",
      "instructions",
      {},
      "test-user",
    );
    const failed = expect(request).rejects.toMatchObject({
      code: "ai_timeout",
    });
    await vi.advanceTimersByTimeAsync(100_000);
    await failed;
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves credential failures and clears their unused deadline", async () => {
    vi.useFakeTimers();
    const failure = Object.assign(new Error("Reconnect your account."), {
      code: "chatgpt_reconnect",
    });
    vi.mocked(chatgptCredential).mockRejectedValue(failure);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      structuredAI(schema, "test", "instructions", {}, "test-user"),
    ).rejects.toBe(failure);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 300_001, Infinity, NaN, 1.5])(
    "rejects an invalid timeout (%s) before sending a request",
    async (timeoutMs) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        structuredAI(schema, "test", "instructions", {}, undefined, {
          timeoutMs,
        }),
      ).rejects.toThrow(RangeError);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("Responses stream terminal handling", () => {
  const messageItem = (value = "ok", id = "message-test") => ({
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify({ value }) }],
  });
  const itemDone = (item = messageItem(), output_index = 0) => ({
    type: "response.output_item.done",
    output_index,
    item,
  });
  const emptyTerminal = {
    type: "response.completed",
    response: { status: "completed", output: [] },
  };

  it("reconstructs a completed subscription response whose terminal output is empty", async () => {
    vi.mocked(chatgptCredential).mockResolvedValue({
      token: "test-plan-token",
      model: "selected-model",
    });
    const item = messageItem();
    const text = [
      {
        type: "response.created",
        response: { status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: '{"value":',
      },
      {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        text: item.content[0].text,
      },
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        part: item.content[0],
      },
      itemDone(item),
      emptyTerminal,
    ]
      .map(frame)
      .join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text)));
    await expect(
      structuredAI(schema, "test", "instructions", {}, "test-user"),
    ).resolves.toEqual({ value: "ok" });
  });

  it("keeps full terminal output authoritative without duplicating completed items", async () => {
    const result = await completedResponse(
      new Response(
        [
          itemDone(messageItem("earlier")),
          itemDone(messageItem("earlier")),
          terminal("final"),
        ]
          .map(frame)
          .join(""),
      ),
    );
    expect(result.output).toEqual(terminal("final").response.output);
  });

  it("deduplicates item completion and restores output index order", async () => {
    const first = messageItem("first", "first-message");
    const second = messageItem("second", "second-message");
    const result = await completedResponse(
      new Response(
        [
          itemDone(second, 3),
          itemDone(first, 1),
          itemDone(second, 3),
          emptyTerminal,
        ]
          .map(frame)
          .join(""),
      ),
    );
    expect(result.output).toEqual([first, second]);
  });

  it("never treats item completion as terminal success", async () => {
    const prefix = frame(itemDone());
    await expect(completedResponse(new Response(prefix))).rejects.toMatchObject(
      { code: "chatgpt_stream_interrupted" },
    );
    await expect(
      completedResponse(
        new Response(
          prefix +
            frame({
              type: "response.failed",
              response: {
                error: { code: "subscription_sharing_usage_limit_exceeded" },
              },
            }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "subscription_sharing_usage_limit_exceeded",
      statusCode: 429,
    });
    await expect(
      completedResponse(
        new Response(
          prefix +
            frame({
              type: "response.incomplete",
              response: { status: "incomplete" },
            }),
        ),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_response_incomplete" });
    const textOnly = await completedResponse(
      new Response(
        [
          {
            type: "response.output_text.done",
            output_index: 0,
            content_index: 0,
            text: '{"value":"ok"}',
          },
          emptyTerminal,
        ]
          .map(frame)
          .join(""),
      ),
    );
    expect(textOnly.output).toEqual([]);
  });

  it("rejects incomplete, misindexed, or conflicting completed messages", async () => {
    for (const events of [
      [itemDone({ ...messageItem(), status: "in_progress" })],
      [itemDone({ ...messageItem(), role: "user" })],
      [itemDone(messageItem(), -1)],
      [itemDone(messageItem(), 0.5)],
      [itemDone(messageItem("one")), itemDone(messageItem("two"))],
      [itemDone(messageItem(), 0), itemDone(messageItem(), 1)],
    ]) {
      await expect(
        completedResponse(
          new Response([...events, emptyTerminal].map(frame).join("")),
        ),
      ).rejects.toMatchObject({ code: "chatgpt_stream_invalid" });
    }
  });

  it("returns at completion without waiting for socket EOF or cancellation acknowledgement", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(terminal())));
        // The server deliberately leaves its connection open.
      },
      cancel,
    });
    await expect(completedResponse(new Response(stream))).resolves.toEqual(
      terminal().response,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("reads CRLF frames, multiline data and Unicode split across network chunks", async () => {
    const event = terminal("Diseño — 日本語");
    const bytes = new TextEncoder().encode(
      `: keepalive\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":${JSON.stringify(event.response)}}\r\n\r\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index++)
          controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      },
    });
    await expect(completedResponse(new Response(stream))).resolves.toEqual(
      event.response,
    );
  });

  it("does not accept text deltas, DONE markers, or truncated completion frames as success", async () => {
    for (const text of [
      frame({ type: "response.output_text.delta", delta: '{"value":"ok"}' }),
      "data: [DONE]\n\n",
      frame(terminal()).trimEnd(),
    ]) {
      await expect(completedResponse(new Response(text))).rejects.toMatchObject(
        {
          code: "chatgpt_stream_interrupted",
        },
      );
    }
  });

  it("rejects malformed completion and incomplete terminal events", async () => {
    await expect(
      completedResponse(new Response("data: {bad json}\n\n")),
    ).rejects.toMatchObject({
      code: "chatgpt_stream_invalid",
    });
    await expect(
      completedResponse(
        new Response(
          frame({
            type: "response.completed",
            response: { status: "incomplete" },
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "chatgpt_stream_invalid",
    });
    await expect(
      completedResponse(
        new Response(
          frame({
            type: "response.incomplete",
            response: { status: "incomplete" },
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "chatgpt_response_incomplete",
    });
  });

  it("preserves a usage-limit failure arriving after partial output", async () => {
    const text =
      frame({ type: "response.output_text.delta", delta: "partial" }) +
      frame({
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      });
    await expect(completedResponse(new Response(text))).rejects.toMatchObject({
      code: "subscription_sharing_usage_limit_exceeded",
      statusCode: 429,
    });
  });
});

describe("unusable structured responses", () => {
  it.each(["api", "chatgpt"])(
    "reports invalid JSON and schema output safely for %s",
    async (mode) => {
      if (mode === "chatgpt")
        vi.mocked(chatgptCredential).mockResolvedValue({
          token: "test-plan-token",
          model: "selected-model",
        });
      for (const text of ["private malformed output", '{"value":123}']) {
        const event = terminal();
        event.response.output[0].content[0].text = text;
        const fetcher = vi
          .fn()
          .mockResolvedValue(
            new Response(
              mode === "chatgpt"
                ? frame(event)
                : JSON.stringify(event.response),
            ),
          );
        vi.stubGlobal("fetch", fetcher);
        await expect(
          structuredAI(
            schema,
            "test",
            "instructions",
            {},
            mode === "chatgpt" ? "test-user" : undefined,
          ),
        ).rejects.toMatchObject({
          code: "ai_response_invalid",
          statusCode: 502,
          message: "The AI response was not in the expected format. Try again.",
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("distinguishes an empty completed response from malformed structured output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                content: [
                  { type: "refusal", refusal: "private provider text" },
                ],
              },
            ],
          }),
        ),
      ),
    );
    await expect(
      structuredAI(schema, "test", "instructions", {}),
    ).rejects.toMatchObject({
      code: "ai_response_empty",
      statusCode: 502,
      message: "The AI returned no usable result. Try again.",
    });
  });

  it.each([
    "invalid API JSON",
    JSON.stringify({ status: "completed", output: "invalid output" }),
  ])(
    "rejects malformed API envelopes without exposing their contents",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      await expect(
        structuredAI(schema, "test", "instructions", {}),
      ).rejects.toMatchObject({
        code: "ai_response_invalid",
        message: "The AI response was not in the expected format. Try again.",
      });
    },
  );
});
