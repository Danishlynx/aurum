import { defineConfig, devices } from "@playwright/test";

/**
 * The Layer 0 flows from docs/09-build-order-and-demo.md live in e2e/.
 * Mobile first, so every project runs at a 390px viewport.
 *
 * The timeouts are generous on purpose. The default web server is `next dev`,
 * which compiles a route the first time it is requested, so the first navigation
 * to a screen can take several seconds on a cold cache. Point
 * PLAYWRIGHT_BASE_URL at a built server (npm run build, then npm run start) to
 * run against production output instead.
 *
 * Two servers, because the suites need two different builds of the same app.
 *
 * 1. Port 3000, AURUM_DEMO_FIXTURE=true: the switch documented in README.md and
 *    implemented in src/lib/server/judge/demo.ts. It is what lets /report,
 *    /color, and /makeup render on a clean clone with no Supabase project and no
 *    provider keys. It changes nothing the landing, consent, or health specs
 *    assert. Specs that depend on it are grouped so they skip when
 *    PLAYWRIGHT_BASE_URL points at a server whose mode this file does not set.
 *
 * 2. Port 3100, with that switch deliberately unset and JUDGE_ANALYSES_ALLOWED=0
 *    instead. This is the build the judges get
 *    (docs/07-payments-and-judge-mode.md): a judge session that never had an
 *    analysis, whose every screen has to render from the saved demo profile
 *    anyway. Running it without AURUM_DEMO_FIXTURE is the whole point, because
 *    it proves the fixture fallback is reached by the judge session state rather
 *    than by a development switch that must never be on in production.
 *    JUDGE_FIXTURE_SESSION lets that server mint the session in memory, since a
 *    clean clone has no judge_sessions table to write one to. The access code
 *    hash below is the bcrypt hash of JUDGE_E2E_CODE and nothing else: it opens
 *    a test server with no data in it and is not a secret.
 */

/**
 * The ports, both derived from one base.
 *
 * AURUM_E2E_PORT moves the pair. It exists because reuseExistingServer is on
 * outside CI: with a development server already on 3000, started by hand with
 * different environment variables, these specs would attach to it and assert
 * fixture mode behaviour against a build that has none. Moving the run is the
 * honest way to share a machine with a server somebody is using.
 *
 * A moved run also gets its own build output, for the same reason the judge
 * server always has one: two Next servers sharing a .next directory write over
 * each other's compiled routes. Nothing changes on the default ports.
 */
const BASE_PORT = Number(process.env.AURUM_E2E_PORT ?? 3000);
const FIXTURE_PORT = BASE_PORT;
const JUDGE_E2E_PORT = BASE_PORT + 100;

/** True when this run was moved off the default ports. */
const MOVED = BASE_PORT !== 3000;

const FIXTURE_BASE_URL = `http://localhost:${String(FIXTURE_PORT)}`;

/** The code e2e/judge-zero.spec.ts types into the judge access screen. */
export const JUDGE_E2E_CODE = "aurum-e2e-judge";

/**
 * The bcrypt hash of that code, base64 encoded.
 *
 * Encoded because a bcrypt hash starts "$2b$10$" and dotenv expansion eats
 * dollar segments out of a value when a .env file names the same variable, which
 * leaves the server comparing against a hash with holes in it. The base64 form
 * has no dollar in it, so it arrives whole (src/lib/server/env.ts).
 */
const JUDGE_E2E_CODE_HASH_B64 =
  "JDJiJDEwJEJ5MlAuSm1ZVHlVTXRlbkY2Skd5RmU5WHNmd2hLdm4yUkJDZGh2b2lBbVUuRVNLM0JhQm5l";

export const JUDGE_E2E_BASE_URL = `http://localhost:${String(JUDGE_E2E_PORT)}`;

/** The specs that need the judge server, and only they, run on it. */
const JUDGE_SPEC = /judge-zero\.spec\.ts/u;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? FIXTURE_BASE_URL,
    trace: "on-first-retry",
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "mobile",
      testIgnore: JUDGE_SPEC,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "judge-zero",
      testMatch: JUDGE_SPEC,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        baseURL: JUDGE_E2E_BASE_URL,
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command: `npm run dev -- --port ${String(FIXTURE_PORT)}`,
          url: FIXTURE_BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            AURUM_DEMO_FIXTURE: "true",
            // Only on a moved run: on 3000 this is the ordinary .next, which is
            // what npm run dev builds and what a developer already has warm.
            ...(MOVED ? { AURUM_DIST_DIR: ".next/e2e-fixture" } : {}),
          },
        },
        {
          command: `npm run dev -- --port ${String(JUDGE_E2E_PORT)}`,
          url: JUDGE_E2E_BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            JUDGE_FIXTURE_SESSION: "true",
            JUDGE_ACCESS_CODE_HASH_B64: JUDGE_E2E_CODE_HASH_B64,
            JUDGE_ANALYSES_ALLOWED: "0",
            JUDGE_CREDITS_CAP: "0",
            // Its own build output, so the two development servers do not write
            // over each other's compiled routes (next.config.ts). It sits inside
            // .next, which is already ignored by git, eslint, and tsc.
            AURUM_DIST_DIR: ".next/e2e-judge",
          },
        },
      ],
});
