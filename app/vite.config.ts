import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const localPath = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4310" },
    fs: {
      strict: true,
      allow: [
        localPath("./src/ui"),
        localPath("./src/shared"),
        localPath("./index.html"),
        localPath("./node_modules"),
        localPath("../node_modules"),
      ],
      // Preserve Vite's credential protections and exclude local data/backups.
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/.local/**",
        "**/.playwright*/**",
        "**/output/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/supabase/.temp/**",
        "**/*.{sqlite,sqlite3,db,sql,dump,backup,bak}",
      ],
    },
  },
  build: { outDir: "dist" },
});
