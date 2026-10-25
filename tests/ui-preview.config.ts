import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Isolated visual acceptance harness. Production builds never use these aliases.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [
    { find: "@/lib/codex-task-api", replacement: path.resolve("tests/fixtures/codex-api.ts") },
    { find: "@/lib/supabase-board", replacement: path.resolve("tests/fixtures/board-api.ts") },
    { find: "@/lib/idea-organizer", replacement: path.resolve("tests/fixtures/board-api.ts") },
    { find: "@", replacement: path.resolve(".") },
  ] },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
