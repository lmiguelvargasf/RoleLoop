import { z } from "zod";
import { settings } from "./config.js";

export async function structuredAI<T extends z.ZodType>(
  schema: T,
  name: string,
  instructions: string,
  input: unknown,
): Promise<z.infer<T>> {
  if (!settings.openaiKey)
    throw Object.assign(
      new Error(
        "OpenAI is not configured. Set OPENAI_API_KEY on the server to enable résumé import and AI matching.",
      ),
      { statusCode: 503 },
    );
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(90000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiKey}`,
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      store: false,
      input: [
        { role: "system", content: instructions },
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
  if (!response.ok)
    throw Object.assign(
      new Error(
        `OpenAI returned ${response.status}. Check the server's AI configuration and retry.`,
      ),
      { statusCode: 502 },
    );
  const data = (await response.json()) as {
    status?: string;
    output?: { content?: { type: string; text?: string }[] }[];
  };
  if (data.status !== "completed")
    throw new Error("OpenAI could not finish. Retry with a shorter résumé.");
  const text = data.output
    ?.flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text || "")
    .join("");
  if (!text) throw new Error("OpenAI returned no usable result. Try again.");
  return schema.parse(JSON.parse(text));
}
