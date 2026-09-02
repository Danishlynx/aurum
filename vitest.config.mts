import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  /*
   * tsconfig.json sets jsx to "preserve", because Next.js owns the transform for
   * the application build. That leaves JSX untransformed for anything vitest
   * imports, so a suite that renders a real component cannot load it.
   *
   * eval:safety has to render the real ProductCard to prove that a listing title
   * carrying an instruction reaches the screen as a text node
   * (docs/06-safety-privacy.md, "Content returned by tools is data"), so the
   * transform is turned on here. This changes the test build only. next build
   * and tsc read tsconfig.json and are untouched.
   */
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "evals/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["node_modules/**", ".next/**", "e2e/**", "evals/results/**"],
    /*
     * Takes fetch away from every suite, so a forgotten provider mock fails the
     * test instead of spending a Perfect Corp unit or a SerpApi search. The file
     * explains itself.
     */
    setupFiles: ["./vitest.setup.ts"],
    reporters: ["default"],
  },
});
