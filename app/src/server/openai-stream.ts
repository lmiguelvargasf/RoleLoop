import { z } from "zod";
import { chatgptError } from "./chatgpt.js";

type CompletedResponse = {
  status: "completed";
  output?: { content?: { type: string; text?: string }[] }[];
};

const CompletedMessage = z.object({
  id: z.string().min(1),
  type: z.literal("message"),
  status: z.literal("completed"),
  role: z.literal("assistant"),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("output_text"), text: z.string() }),
      z.object({ type: z.literal("refusal"), refusal: z.string() }),
    ]),
  ),
});

/** Only the successful terminal event is a result; socket EOF is not required. */
export async function completedResponse(response: Response) {
  if (!response.body)
    throw chatgptError("ChatGPT returned no response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const completedItems = new Map<number, z.infer<typeof CompletedMessage>>();
  let buffer = "",
    bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 4 * 1024 * 1024)
        throw chatgptError(
          "ChatGPT response was too large. Try a shorter document.",
        );
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block
          .split(/\r\n|\n|\r/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw chatgptError(
            "ChatGPT returned an unreadable response stream. Please retry.",
            "chatgpt_stream_invalid",
          );
        }
        if (event?.type === "response.incomplete")
          throw chatgptError(
            "ChatGPT did not finish the response. Try again with a shorter document.",
            "chatgpt_response_incomplete",
          );
        if (["error", "response.failed"].includes(event?.type)) {
          const error = event.response?.error || event.error || event;
          const code = error.code || "chatgpt_response_failed";
          throw chatgptError(
            code === "subscription_sharing_usage_limit_exceeded"
              ? "Your ChatGPT usage limit was reached. Open Manage usage to review your allowance."
              : code === "subscription_sharing_usage_unavailable"
                ? "ChatGPT usage is temporarily unavailable. Try again later."
                : "ChatGPT could not complete the request. Reconnect or try again later.",
            code,
            code === "subscription_sharing_usage_limit_exceeded" ? 429 : 502,
          );
        }
        if (
          event?.type === "response.output_item.done" &&
          event.item?.type === "message"
        ) {
          const parsed = CompletedMessage.safeParse(event.item);
          if (
            !Number.isSafeInteger(event.output_index) ||
            event.output_index < 0 ||
            !parsed.success
          )
            throw chatgptError(
              "ChatGPT returned an invalid completed message. Please retry.",
              "chatgpt_stream_invalid",
            );
          const previous = completedItems.get(event.output_index);
          if (
            (previous &&
              JSON.stringify(previous) !== JSON.stringify(parsed.data)) ||
            [...completedItems].some(
              ([index, item]) =>
                index !== event.output_index && item.id === parsed.data.id,
            )
          )
            throw chatgptError(
              "ChatGPT returned conflicting completed messages. Please retry.",
              "chatgpt_stream_invalid",
            );
          completedItems.set(event.output_index, parsed.data);
        }
        if (event?.type === "response.completed") {
          if (event.response?.status !== "completed")
            throw chatgptError(
              "ChatGPT returned an invalid completion. Please retry.",
              "chatgpt_stream_invalid",
            );
          // Some subscription streams omit output in the terminal envelope.
          // Item completion supplies content, but only response.completed permits use.
          if (
            event.response.output === undefined ||
            (Array.isArray(event.response.output) &&
              !event.response.output.length)
          )
            return {
              ...event.response,
              output: [...completedItems]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
            } as CompletedResponse;
          return event.response as CompletedResponse;
        }
      }
    }
    throw chatgptError(
      "ChatGPT response was interrupted before completion. Please retry.",
      "chatgpt_stream_interrupted",
    );
  } finally {
    // Do not wait for the remote connection to close after a terminal event.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
