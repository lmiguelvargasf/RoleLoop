import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const network = "roleloop-local";
const pinnedCli = "2.117.0";
const excluded = "realtime,imgproxy,edge-runtime,logflare,vector,supavisor";

function run(
  command: string,
  args: string[],
  timeout = 600_000,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out. Retry npm run setup.`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output);
      else {
        const detail = (error || output)
          .replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]")
          .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted]")
          .replace(
            /(SERVICE_ROLE_KEY|SECRET_KEY|JWT_SECRET|ANON_KEY)\s*[:=]\s*[^\s]+/gi,
            "$1=[redacted]",
          )
          .slice(-1800);
        reject(new Error(`${command} exited with ${code}. ${detail}`));
      }
    });
  });
}
function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}
async function main() {
  const expectedNode = (await readFile(resolve(appDir, "..", ".nvmrc"), "utf8"))
    .trim()
    .replace(/^v/, "");
  if (process.versions.node !== expectedNode)
    throw new Error(
      `Use Node.js ${expectedNode}: run nvm install && nvm use from the repository root, then retry npm run setup.`,
    );
  console.log("Checking local Docker engine…");
  await run("docker", ["info", "--format", "{{.ServerVersion}}"], 15_000);
  let cli = "supabase";
  let prefix: string[] = [];
  try {
    if ((await run(cli, ["--version"], 15_000)).trim() !== pinnedCli) {
      cli = "npx";
      prefix = ["--yes", `supabase@${pinnedCli}`];
    }
  } catch {
    cli = "npx";
    prefix = ["--yes", `supabase@${pinnedCli}`];
  }
  try {
    const binding = (
      await run(
        "docker",
        [
          "network",
          "inspect",
          network,
          "--format",
          '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}',
        ],
        15_000,
      )
    ).trim();
    if (binding !== "127.0.0.1")
      throw new Error(
        `Network ${network} exists without loopback-only binding.`,
      );
  } catch (error) {
    if (error instanceof Error && error.message.includes("exists without"))
      throw error;
    await run(
      "docker",
      [
        "network",
        "create",
        "-o",
        "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
        network,
      ],
      15_000,
    );
  }
  console.log(
    "Starting local Supabase. The first run downloads container images.",
  );
  const progress = setInterval(
    () => console.log("Supabase is preparing its local services…"),
    30_000,
  );
  try {
    await run(cli, [
      ...prefix,
      "start",
      "--network-id",
      network,
      "--exclude",
      excluded,
    ]);
    console.log("Applying pending migrations without resetting existing data…");
    await run(cli, [...prefix, "db", "push", "--local", "--yes"], 120_000);
  } finally {
    clearInterval(progress);
  }
  // Docker Desktop can ignore the network's default binding. Report the actual
  // published address rather than assuming that a localhost URL isolates it.
  const ports = JSON.parse(
    await run(
      "docker",
      [
        "inspect",
        "supabase_kong_roleloop-ts",
        "--format",
        "{{json .NetworkSettings.Ports}}",
      ],
      15_000,
    ),
  ) as Record<string, { HostIp: string }[] | null>;
  if (
    Object.values(ports)
      .flatMap((value) => value || [])
      .some((value) => !["127.0.0.1", "::1"].includes(value.HostIp))
  ) {
    console.warn(
      "NOTICE: Docker Desktop publishes Supabase beyond localhost on this machine despite the loopback network setting. Use a trusted network for testing.",
    );
  }
  const status = parseEnv(
    await run(cli, [...prefix, "status", "-o", "env"], 20_000),
  );
  const serviceKey = status.SERVICE_ROLE_KEY;
  const anonKey = status.ANON_KEY;
  const apiUrl = status.API_URL;
  if (!serviceKey || !anonKey || apiUrl !== "http://127.0.0.1:54331")
    throw new Error(
      "Supabase did not return the expected local URL and credentials. No cloud database is configured by this script.",
    );
  const envPath = resolve(appDir, ".env.local");
  let existing: Record<string, string> = {};
  try {
    existing = parseEnv(await readFile(envPath, "utf8"));
  } catch {
    /* First run. */
  }
  const values: Record<string, string> = {
    ...existing,
    SUPABASE_URL: apiUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    SUPABASE_ANON_KEY: anonKey,
    API_PORT: "4310",
    APP_URL: "http://127.0.0.1:5173",
    SUPABASE_STUDIO_URL: "http://127.0.0.1:54333",
    MAILPIT_URL: "http://127.0.0.1:54334",
    MAILPIT_HOST: "127.0.0.1",
    MAILPIT_PORT: "54335",
    OLLAMA_URL: existing.OLLAMA_URL || "http://127.0.0.1:11434",
  };
  await mkdir(resolve(appDir, ".local"), { recursive: true });
  await writeFile(
    envPath,
    "# Backend-only local credentials. Do not expose to the browser.\n" +
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") +
      "\n",
    { mode: 0o600 },
  );
  await chmod(envPath, 0o600);
  console.log("Local database and private document storage are ready.");
  console.log("Studio: http://127.0.0.1:54333");
  console.log("Test email inbox: http://127.0.0.1:54334");
  console.log(
    "Credentials saved privately in app/.env.local. Start the app with npm run dev.",
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local setup failed.");
  process.exitCode = 1;
});
