import { chatgptError } from "./chatgpt.js";

/** Read through the terminal event: early text is never treated as success. */
export async function completedResponse(response: Response) {
  if (!response.body)
    throw chatgptError("ChatGPT returned no response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  let completed:
    | {
        status?: string;
        output?: { content?: { type: string; text?: string }[] }[];
      }
    | undefined;
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
      buffer = buffer.replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (
          ["error", "response.failed", "response.incomplete"].includes(
            event.type,
          )
        ) {
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
        if (event.type === "response.completed") completed = event.response;
      }
    }
    if (!completed || completed.status !== "completed")
      throw chatgptError(
        "ChatGPT response was interrupted before completion. Please retry.",
      );
    return completed;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
