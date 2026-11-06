import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (Number(process.versions.node.split(".")[0]) !== 26)
  throw new Error(
    "Run nvm install && nvm use from the repository root. This project is pinned to Node.js 26.13.0.",
  );
if (!existsSync(resolve(appDir, ".env.local")))
  throw new Error("Run npm run setup first to start the local database.");
const production = process.argv.includes("--production"),
  children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const finished = children.map(
    (child) =>
      new Promise<void>((done) => {
        if (
          !child.pid ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          done();
          return;
        }
        child.once("exit", () => done());
        child.kill("SIGTERM");
      }),
  );
  const timeout = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 10000);
  void Promise.all(finished).then(() => {
    clearTimeout(timeout);
    process.exit(code);
  });
}
function launch(args: string[]) {
  const child = spawn(process.execPath, args, {
    cwd: appDir,
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 1);
  });
}
launch([
  "--import",
  "tsx",
  "src/server/index.ts",
  ...(production ? ["--production"] : []),
]);
launch(["--import", "tsx", "src/server/worker.ts"]);
if (!production)
  launch([
    resolve(appDir, "../node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
  ]);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => stop());
console.log(
  `RoleLoop • ${production ? "http://127.0.0.1:4310" : "http://127.0.0.1:5173"} • Docker is used only by Supabase`,
);
