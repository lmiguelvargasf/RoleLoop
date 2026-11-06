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

export async function structuredAI<T extends z.ZodType>(
  schema: T,
  name: string,
  instructions: string,
  input: unknown,
  userId?: string,
): Promise<z.infer<T>> {
  let connection = userId ? await chatgptCredential(userId) : null;
  if (connection && !connection.model) {
    await listChatGPTModels(userId!);
    connection = await chatgptCredential(userId!);
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
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(90000),
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
    const data = connection
      ? await completedResponse(response)
      : ((await response.json()) as {
          status?: string;
          output?: { content?: { type: string; text?: string }[] }[];
        });
    if (data.status !== "completed")
      throw new Error("OpenAI could not finish. Retry with a shorter résumé.");
    const text = data.output
      ?.flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text || "")
      .join("");
    if (!text) throw new Error("OpenAI returned no usable result. Try again.");
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (connection && userId)
      await suspendChatGPT(userId, connection.token, error);
    throw error;
  }
}
