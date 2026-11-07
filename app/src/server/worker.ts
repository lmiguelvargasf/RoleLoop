import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  db,
  createWorkspaceStore,
  setGlobalRuntime,
  listOwnedWorkspaces,
  isOwnedWorkspace,
  claimRun,
  type WorkspaceStore,
} from "./store.js";
import { enqueue, processRun } from "./service.js";
import type { Run } from "../shared/types.js";

let stopping = false;
const shutdown = new AbortController();
const owner = randomUUID();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    shutdown.abort();
  });
async function pause(milliseconds: number) {
  try {
    await delay(milliseconds, undefined, { signal: shutdown.signal });
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  }
}
async function update(store: WorkspaceStore, run: Run, patch: Partial<Run>) {
  Object.assign(run, patch, {
    workspaceId: store.workspaceId,
    updatedAt: new Date().toISOString(),
  });
  await store.save("runs", run);
}
async function heartbeat() {
  await setGlobalRuntime("worker", {
    at: new Date().toISOString(),
    pid: process.pid,
  });
}
async function lease(
  action:
    "acquire_worker_lease" | "renew_worker_lease" | "release_worker_lease",
) {
  const { data, error } = await db.rpc(action, { owner });
  if (error) throw new Error(error.message);
  return data === true;
}
async function recoverInterruptedRuns() {
  // Scope recovery to owned workspaces. Existing, unclaimed data is not opened by the worker.
  for (const workspace of await listOwnedWorkspaces()) {
    if (stopping) break;
    const store = createWorkspaceStore({
      workspaceId: workspace.id,
      client: db,
    });
    try {
      for (const run of await store.list("runs", 10000)) {
        if (stopping) break;
        if (run.status === "running") {
          await update(store, run, {
            status: "failed",
            message:
              "Interrupted by a previous worker shutdown. Review the result and retry.",
            progress: 0,
          });
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Task recovery failed";
      console.error(`Could not recover workspace ${workspace.id}: ${message}`);
      await store
        .event(`Previous tasks could not be recovered: ${message}`, "error")
        .catch(() => {});
      // One workspace's invalid historic data must not stop the shared worker.
    }
  }
}
const scheduleErrors = new Map<string, string>();
async function scheduleDiscovery() {
  for (const record of await listOwnedWorkspaces()) {
    if (stopping) break;
    const store = createWorkspaceStore({ workspaceId: record.id, client: db });
    try {
      const workspace = await store.getWorkspace();
      if (workspace.preferences.scheduleEnabled) {
        const schedule = await store.runtime<{ at: string }>("last-discovery");
        if (
          !schedule ||
          Date.now() - Date.parse(schedule.at) >
            workspace.preferences.scheduleMinutes * 60000
        ) {
          await enqueue(store, { action: "discover" });
          await store.setRuntime("last-discovery", {
            at: new Date().toISOString(),
          });
        }
      }
      scheduleErrors.delete(record.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Workspace schedule failed";
      if (scheduleErrors.get(record.id) !== message) {
        await store
          .event(`Scheduled discovery: ${message}`, "error")
          .catch(() => {});
        scheduleErrors.set(record.id, message);
      }
      // An invalid workspace or source must not interrupt other users' work.
    }
  }
}
async function main() {
  const deadline = Date.now() + 35000;
  let acquired = false,
    announcedWait = false;
  while (!stopping) {
    acquired = await lease("acquire_worker_lease");
    if (acquired) break;
    if (Date.now() >= deadline)
      throw new Error(
        "Another local worker is active. Stop it before starting a second worker.",
      );
    if (!announcedWait) {
      console.log("Waiting for the previous worker lease to expire…");
      announcedWait = true;
    }
    await pause(Math.min(5000, Math.max(0, deadline - Date.now())));
  }
  if (!acquired) return;
  if (stopping) {
    await lease("release_worker_lease");
    return;
  }
  let releasing = false;
  const timer = setInterval(
    () =>
      void (async () => {
        try {
          if (releasing) return;
          if (!(await lease("renew_worker_lease")))
            throw new Error("Worker lease lost");
          if (!releasing) await heartbeat();
        } catch {
          if (releasing) return;
          console.error(
            "Worker lease unavailable. Stopping to avoid duplicate execution.",
          );
          process.exit(1);
        }
      })(),
    5000,
  );
  let lastError = "",
    nextScheduleCheck = 0;
  try {
    await recoverInterruptedRuns();
    await heartbeat();
    console.log(
      "RoleLoop worker ready • private workspace queues • test delivery only",
    );
    while (!stopping) {
      try {
        if (Date.now() >= nextScheduleCheck) {
          await scheduleDiscovery();
          nextScheduleCheck = Date.now() + 15000;
        }
        if (stopping) break;
        const run = await claimRun();
        if (!run) {
          await pause(1200);
          continue;
        }
        const store = createWorkspaceStore({
          workspaceId: run.workspaceId,
          client: db,
          actorUserId: run.requestedBy,
        });
        if (stopping) {
          await update(store, run, {
            status: "queued",
            progress: 0,
            message: "Waiting for the local worker",
          });
          break;
        }
        try {
          if (!(await isOwnedWorkspace(run.workspaceId, run.requestedBy)))
            throw new Error(
              run.requestedBy
                ? "The requesting account no longer owns this workspace."
                : "This workspace needs an owner before running its tasks.",
            );
          await update(store, run, {
            status: "running",
            progress: 5,
            message: "Worker started",
          });
          const message = await processRun(store, run, (progress, message) =>
            update(store, run, { progress, message }),
          );
          await update(store, run, {
            status: "completed",
            progress: 100,
            message,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Worker task failed";
          await update(store, run, { status: "failed", message });
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
        await pause(3000);
      }
    }
  } finally {
    releasing = true;
    clearInterval(timer);
    if (await lease("release_worker_lease"))
      await setGlobalRuntime("worker", {
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
