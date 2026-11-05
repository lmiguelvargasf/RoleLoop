import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import * as store from "./store.js";
import { enqueue, processRun } from "./service.js";
import type { Run } from "../shared/types.js";
let stopping = false;
const owner = randomUUID();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
  });
async function update(run: Run, patch: Partial<Run>) {
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  await store.save("runs", run);
}
async function heartbeat() {
  await store.setRuntime("worker", {
    at: new Date().toISOString(),
    pid: process.pid,
  });
}
async function lease(
  action:
    "acquire_worker_lease" | "renew_worker_lease" | "release_worker_lease",
) {
  const { data, error } = await store.db.rpc(action, { owner });
  if (error) throw new Error(error.message);
  return data === true;
}
async function main() {
  await store.getWorkspace();
  if (!(await lease("acquire_worker_lease")))
    throw new Error(
      "Another local worker is active. Stop it before starting a second worker.",
    );
  for (const run of await store.list("runs", 1000))
    if (run.status === "running")
      await update(run, {
        status: "failed",
        message:
          "Interrupted by a previous worker shutdown. Review the result and retry.",
        progress: 0,
      });
  await heartbeat();
  const timer = setInterval(
    () =>
      void (async () => {
        try {
          if (!(await lease("renew_worker_lease")))
            throw new Error("Worker lease lost");
          await heartbeat();
        } catch {
          console.error(
            "Worker lease unavailable. Stopping to avoid duplicate execution.",
          );
          process.exit(1);
        }
      })(),
    5000,
  );
  console.log("RoleLoop worker ready • database queue • test delivery only");
  let lastError = "";
  try {
    while (!stopping) {
      try {
        const workspace = await store.getWorkspace();
        if (workspace.preferences.scheduleEnabled) {
          const schedule = await store.runtime<{ at: string }>(
            "last-discovery",
          );
          if (
            !schedule ||
            Date.now() - Date.parse(schedule.at) >
              workspace.preferences.scheduleMinutes * 60000
          ) {
            await enqueue({ action: "discover" });
            await store.setRuntime("last-discovery", {
              at: new Date().toISOString(),
            });
          }
        }
        const run = await store.claimRun();
        if (!run) {
          await delay(1200);
          continue;
        }
        try {
          await update(run, {
            status: "running",
            progress: 5,
            message: "Worker started",
          });
          const message = await processRun(run, (progress, message) =>
            update(run, { progress, message }),
          );
          await update(run, { status: "completed", progress: 100, message });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Worker task failed";
          await update(run, { status: "failed", message });
          await store.event(message, "error", run.opportunityId);
        }
        lastError = "";
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Database unavailable";
        if (lastError !== message) {
          console.error(message);
          lastError = message;
        }
        await delay(3000);
      }
    }
  } finally {
    clearInterval(timer);
    if (await lease("release_worker_lease"))
      await store.setRuntime("worker", {
        at: "1970-01-01T00:00:00Z",
        pid: process.pid,
      });
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Worker startup failed",
  );
  process.exitCode = 1;
});
