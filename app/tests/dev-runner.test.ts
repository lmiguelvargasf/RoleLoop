import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reloads API and worker together after a shared schema change and stops their children", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await mkdir(resolve(root, ".local"), { recursive: true });
  const fixture = await mkdtemp(resolve(root, ".local/dev-runner-"));
  const fixtureApp = resolve(fixture, "app");
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  let exited: Promise<unknown> | undefined;
  const waitFor = async (pattern: RegExp) => {
    const deadline = Date.now() + 15000;
    while (!pattern.test(output)) {
      if (child?.exitCode !== null || Date.now() > deadline)
        throw new Error(
          `Development runner did not reach ${pattern}: ${output}`,
        );
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  try {
    for (const path of ["scripts", "src/server", "src/shared"])
      await mkdir(resolve(fixtureApp, path), { recursive: true });
    await mkdir(resolve(fixture, "node_modules/vite/bin"), { recursive: true });
    await writeFile(resolve(fixtureApp, "package.json"), '{"type":"module"}');
    await writeFile(
      resolve(fixtureApp, ".env.local"),
      "# Isolated runner fixture\n",
    );
    await writeFile(
      resolve(fixtureApp, "scripts/dev.ts"),
      await readFile(resolve(root, "scripts/dev.ts")),
    );
    const schema = resolve(fixtureApp, "src/shared/schema.ts");
    await writeFile(schema, 'export const version = "old";\n');
    for (const name of ["api", "worker"])
      await writeFile(
        resolve(
          fixtureApp,
          `src/server/${name === "api" ? "index" : "worker"}.ts`,
        ),
        `import { version } from "../shared/schema.ts";\nconsole.log("${name}:" + version + ":" + process.pid);\nsetInterval(() => {}, 1000);\n`,
      );
    await writeFile(
      resolve(fixture, "node_modules/vite/bin/vite.js"),
      'console.log("ui:" + process.pid); setInterval(() => {}, 1000);\n',
    );
    child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(fixtureApp, "scripts/dev.ts")],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      output += String(chunk);
    });
    exited = new Promise((done, reject) => {
      child!.once("exit", done);
      child!.once("error", reject);
    });
    await waitFor(/api:old:\d+/);
    await waitFor(/worker:old:\d+/);
    await waitFor(/ui:\d+/);
    await writeFile(schema, 'export const version = "cv-first";\n');
    await waitFor(/api:cv-first:\d+/);
    await waitFor(/worker:cv-first:\d+/);
    child.kill("SIGTERM");
    await exited;
    expect(child.exitCode).toBe(0);
    for (const match of output.matchAll(
      /(?:api:(?:old|cv-first)|worker:(?:old|cv-first)|ui):(\d+)/g,
    ))
      expect(() => process.kill(Number(match[1]), 0)).toThrow();
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}, 35000);
