import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(".") } },
  test: { include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"], testTimeout: 30_000 },
});
