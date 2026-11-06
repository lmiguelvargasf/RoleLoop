import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Migration tests take table-wide DDL locks in the shared local database.
    // Keep files serial; concurrency within a test still exercises real races.
    fileParallelism: process.env.ROLELOOP_INTEGRATION !== "1",
  },
});
