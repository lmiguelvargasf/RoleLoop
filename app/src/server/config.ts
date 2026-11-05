import { config as dotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv({ path: resolve(appDir, ".env.local"), quiet: true });
function localUrl(value: string, name: string) {
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error(`${name} must use a local HTTP address in testing mode.`);
  return url.origin;
}
export const settings = {
  supabaseUrl: localUrl(
    process.env.SUPABASE_URL || "http://127.0.0.1:54331",
    "Supabase",
  ),
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  apiPort: Number(process.env.API_PORT || 4310),
  appUrl: localUrl(process.env.APP_URL || "http://127.0.0.1:5173", "App"),
  ollamaUrl: localUrl(
    process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    "Ollama",
  ),
  smtpPort: Number(process.env.MAILPIT_PORT || 54335),
  studioUrl: "http://127.0.0.1:54333",
  mailpitUrl: "http://127.0.0.1:54334",
};
