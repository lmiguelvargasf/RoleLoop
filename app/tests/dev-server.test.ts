import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import { expect, it } from "vitest";
import config from "../vite.config.js";

it("serves the client while denying local data, credentials, and server-only sources", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const id = randomUUID(),
    privatePath = resolve(root, ".local", `security-${id}.txt`),
    envPath = resolve(root, `.env.security-${id}`),
    cache = resolve(root, ".local", `vite-test-${id}`);
  await mkdir(resolve(root, ".local"), { recursive: true });
  await writeFile(privatePath, "PRIVATE_TEST_CANARY", { mode: 0o600 });
  await writeFile(envPath, "SECRET_TEST_CANARY=do-not-serve", { mode: 0o600 });
  const server = await createServer({
    ...config,
    root,
    configFile: false,
    publicDir: false,
    cacheDir: cache,
    logLevel: "silent",
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
      watch: null,
      proxy: undefined,
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of [
      `/.local/security-${id}.txt`,
      `/.local/security-${id}.txt?raw`,
      `/@fs${privatePath}`,
      `/.env.security-${id}`,
      "/src/server/config.ts",
    ]) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(403);
      expect(await response.text()).not.toContain("PRIVATE_TEST_CANARY");
    }
    expect((await fetch(base + "/")).status).toBe(200);
  } finally {
    await server.close();
    await Promise.all([
      rm(privatePath, { force: true }),
      rm(envPath, { force: true }),
      rm(cache, { recursive: true, force: true }),
    ]);
  }
}, 20000);
