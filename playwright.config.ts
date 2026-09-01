import { defineConfig, devices } from "@playwright/test";

/**
 * The Layer 0 flows from docs/09-build-order-and-demo.md live in e2e/.
 * Mobile first, so the only project is a 390px viewport.
 *
 * The timeouts are generous on purpose. The default web server is `next dev`,
 * which compiles a route the first time it is requested, so the first navigation
 * to a screen can take several seconds on a cold cache. Point
 * PLAYWRIGHT_BASE_URL at a built server (npm run build, then npm run start) to
 * run against production output instead.
 *
 * The server starts with AURUM_DEMO_FIXTURE=true, the switch documented in
 * README.md and implemented in src/lib/server/profile/report-view.ts. It is what
 * lets /report, /color, and /makeup render on a clean clone with no Supabase
 * project and no provider keys: the profile layer answers from the checked in
 * fixture and touches neither. It changes nothing the landing, consent, or
 * health specs assert. Specs that depend on it are grouped so they skip when
 * PLAYWRIGHT_BASE_URL points at a server whose mode this file does not set.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { AURUM_DEMO_FIXTURE: "true" },
      },
});
