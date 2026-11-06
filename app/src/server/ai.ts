import { z } from "zod";
import {
  chatgptCredential,
  chatgptError,
  listChatGPTModels,
  openaiFailure,
  suspendChatGPT,
} from "./chatgpt.js";
import { completedResponse } from "./openai-stream.js";
import { settings } from "./config.js";

export type StructuredAIOptions = { timeoutMs?: number };
export class AIRequestTimeoutError extends Error {
  readonly code = "ai_timeout";
  readonly statusCode = 504;

  constructor() {
    super("The AI request timed out. Try again.");
    this.name = "AIRequestTimeoutError";
  }
}
export class AIResponseError extends Error {
  readonly statusCode = 502;

  constructor(readonly code: "ai_response_invalid" | "ai_response_empty") {
    super(
      code === "ai_response_empty"
        ? "The AI returned no usable result. Try again."
        : "The AI response was not in the expected format. Try again.",
    );
    this.name = "AIResponseError";
  }
}

const ResponseEnvelope = z.object({
  status: z.string().optional(),
  output: z
    .array(
      z.object({
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export async function structuredAI<T extends z.ZodType>(
  schema: T,
  name: string,
  instructions: string,
  input: unknown,
  userId?: string,
  options: StructuredAIOptions = {},
): Promise<z.infer<T>> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new RangeError("AI request timeout must be between 1 and 300000 ms.");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new AIRequestTimeoutError()),
    timeoutMs,
  );
  timeout.unref();
  let connection: Awaited<ReturnType<typeof chatgptCredential>> = null;
  try {
    connection = userId ? await chatgptCredential(userId) : null;
    controller.signal.throwIfAborted();
    if (connection && !connection.model) {
      await listChatGPTModels(userId!);
      controller.signal.throwIfAborted();
      connection = await chatgptCredential(userId!);
      controller.signal.throwIfAborted();
      if (!connection?.model)
        throw chatgptError("No models are available for this ChatGPT account.");
    }
    if (!connection && !settings.openaiKey)
      throw Object.assign(
        new Error(
          "Connect ChatGPT under Account & access, or configure an OpenAI API key to enable AI features.",
        ),
        { statusCode: 503 },
      );
    controller.signal.throwIfAborted();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection?.token || settings.openaiKey}`,
      },
      body: JSON.stringify({
        model: connection?.model || settings.openaiModel,
        ...(connection ? { stream: true, instructions } : {}),
        store: false,
        input: [
          ...(!connection ? [{ role: "system", content: instructions }] : []),
          { role: "user", content: JSON.stringify(input) },
        ],
        text: {
          format: {
            type: "json_schema",
            name,
            strict: true,
            schema: z.toJSONSchema(schema),
          },
        },
      }),
    });
    if (!response.ok) throw await openaiFailure(response);
    const raw = connection
      ? await completedResponse(response)
      : await response.json().catch((error: unknown) => {
          if (error instanceof SyntaxError)
            throw new AIResponseError("ai_response_invalid");
          throw error;
        });
    const envelope = ResponseEnvelope.safeParse(raw);
    if (!envelope.success) throw new AIResponseError("ai_response_invalid");
    const data = envelope.data;
    if (data.status !== "completed")
      throw new Error("OpenAI could not finish. Retry with a shorter résumé.");
    const text = data.output
      ?.flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text || "")
      .join("");
    if (!text?.trim()) throw new AIResponseError("ai_response_empty");
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      // Keep raw provider output and schema internals out of user-facing errors.
      throw new AIResponseError("ai_response_invalid");
    }
  } catch (error) {
    const failure = controller.signal.aborted
      ? controller.signal.reason
      : error;
    if (connection && userId)
      await suspendChatGPT(userId, connection.token, failure);
    throw failure;
  } finally {
    clearTimeout(timeout);
  }
}
