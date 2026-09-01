import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "evals/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["node_modules/**", ".next/**", "e2e/**", "evals/results/**"],
    reporters: ["default"],
  },
});
