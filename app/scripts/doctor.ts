import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function main() {
  const expectedNode = (await readFile(resolve(appDir, "..", ".nvmrc"), "utf8"))
    .trim()
    .replace(/^v/, "");
  console.log(
    `${process.versions.node === expectedNode ? "OK" : "FAIL"} Node.js ${process.versions.node} (project requires ${expectedNode})`,
  );
  if (process.versions.node !== expectedNode) process.exitCode = 1;
  const env: Record<string, string> = {};
  try {
    for (const line of (
      await readFile(resolve(appDir, ".env.local"), "utf8")
    ).split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
      if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    console.error("Local configuration is missing. Run npm run setup first.");
    process.exitCode = 1;
    return;
  }
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_STUDIO_URL",
    "MAILPIT_URL",
    "OLLAMA_URL",
  ]) {
    if (
      env[key] &&
      !["127.0.0.1", "localhost", "[::1]"].includes(new URL(env[key]).hostname)
    ) {
      console.error(
        `FAIL ${key} must point to this computer. Diagnostics will not connect to a cloud service.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const probes: [string, string, Record<string, string>?][] = [
    [
      "Database API",
      `${env.SUPABASE_URL}/rest/v1/workspace?select=id&limit=1`,
      {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    ],
    ["Supabase Studio", env.SUPABASE_STUDIO_URL || "http://127.0.0.1:54333"],
    ["Test email inbox", env.MAILPIT_URL || "http://127.0.0.1:54334"],
  ];
  if (env.SUPABASE_ANON_KEY) {
    probes.push([
      "Supabase Auth",
      `${env.SUPABASE_URL}/auth/v1/settings`,
      { apikey: env.SUPABASE_ANON_KEY },
    ]);
  } else {
    console.log("FAIL Authentication key is missing. Run npm run setup.");
    process.exitCode = 1;
  }
  for (const [name, url, headers] of probes) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      console.log(
        `${response.ok ? "OK" : "FAIL"} ${name}${response.ok ? "" : ` (HTTP ${response.status})`}`,
      );
      if (!response.ok) process.exitCode = 1;
    } catch {
      console.log(`FAIL ${name} is unavailable`);
      process.exitCode = 1;
    }
  }
  await new Promise<void>((resolveProbe) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(env.MAILPIT_PORT || 54335),
      timeout: 3000,
    });
    let complete = false;
    function finish(ok: boolean) {
      if (complete) return;
      complete = true;
      console.log(`${ok ? "OK" : "FAIL"} Local SMTP capture`);
      if (!ok) process.exitCode = 1;
      socket.destroy();
      resolveProbe();
    }
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
  try {
    const response = await fetch(
      `${env.OLLAMA_URL || "http://127.0.0.1:11434"}/api/tags`,
      { signal: AbortSignal.timeout(1500) },
    );
    console.log(
      response.ok
        ? "OK Optional Ollama service"
        : "OPTIONAL Ollama unavailable; evidence templates remain usable",
    );
  } catch {
    console.log(
      "OPTIONAL Ollama unavailable; evidence templates remain usable",
    );
  }
  try {
    const { stdout } = await promisify(execFile)(
      "docker",
      [
        "inspect",
        "supabase_kong_roleloop-ts",
        "--format",
        "{{json .NetworkSettings.Ports}}",
      ],
      { timeout: 5000 },
    );
    const ports = JSON.parse(stdout) as Record<
      string,
      { HostIp: string }[] | null
    >;
    console.log(
      Object.values(ports)
        .flatMap((value) => value || [])
        .some((value) => !["127.0.0.1", "::1"].includes(value.HostIp))
        ? "NOTICE Supabase ports are published beyond localhost by Docker Desktop; use a trusted network"
        : "OK Supabase ports bind to loopback",
    );
  } catch {
    console.log("NOTICE Unable to inspect Docker port bindings");
  }
  console.log(
    `Node.js ${process.version} · app processes run directly on the host`,
  );
}
main().catch(() => {
  console.error("Diagnostics failed. Run npm run setup and retry.");
  process.exitCode = 1;
});
