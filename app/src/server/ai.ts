import { z } from "zod";
import { settings } from "./config.js";
import type { Preferences } from "../shared/types.js";

export async function aiModel(prefs: Preferences) {
  if (settings.openaiKey)
    return { provider: "openai", model: settings.openaiModel };
  if (prefs.ollamaModel.trim())
    return { provider: "ollama", model: prefs.ollamaModel };
  try {
    const response = await fetch(`${settings.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    const data = (await response.json()) as { models?: { name: string }[] };
    if (data.models?.[0]?.name)
      return { provider: "ollama", model: data.models[0].name };
  } catch {
    /* Report an actionable setup error below. */
  }
  throw Object.assign(
    new Error(
      "Résumé AI is unavailable. Configure OPENAI_API_KEY on the server, or install an Ollama model and try again.",
    ),
    { statusCode: 503 },
  );
}

export async function structuredAI<T extends z.ZodType>(
  schema: T,
  name: string,
  instructions: string,
  input: unknown,
  prefs: Preferences,
): Promise<z.infer<T>> {
  const { provider, model } = await aiModel(prefs);
  const jsonSchema = z.toJSONSchema(schema);
  const response = await fetch(
    provider === "openai"
      ? "https://api.openai.com/v1/responses"
      : `${settings.ollamaUrl}/api/chat`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        ...(provider === "openai"
          ? { Authorization: `Bearer ${settings.openaiKey}` }
          : {}),
      },
      body: JSON.stringify(
        provider === "openai"
          ? {
              model,
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
                  schema: jsonSchema,
                },
              },
            }
          : {
              model,
              stream: false,
              format: jsonSchema,
              options: { temperature: 0 },
              messages: [
                { role: "system", content: instructions },
                { role: "user", content: JSON.stringify(input) },
              ],
            },
      ),
    },
  );
  if (!response.ok)
    throw Object.assign(
      new Error(
        `Résumé AI returned ${response.status}. Check the server's AI configuration and retry.`,
      ),
      { statusCode: 502 },
    );
  const data = (await response.json()) as {
    status?: string;
    message?: { content?: string };
    output?: { content?: { type: string; text?: string }[] }[];
  };
  if (provider === "openai" && data.status !== "completed")
    throw new Error("AI could not finish. Retry with a shorter résumé.");
  const text =
    provider === "openai"
      ? data.output
          ?.flatMap((o) => o.content || [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text || "")
          .join("")
      : data.message?.content;
  if (!text) throw new Error("AI returned no usable result. Try again.");
  return schema.parse(JSON.parse(text));
}
