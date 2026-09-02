import "server-only";

import { isSupabaseConfigured } from "../env";
import { getAestheticProfile } from "../profile/db";
import type { AppSession } from "../session";
import { DEMO_OWNER_ID, judgeAnalysesRemaining } from "./index";

/**
 * Where a screen reads from, for this request.
 *
 * There are three sources in this build and they are not interchangeable:
 *
 * 1. The person's own rows, which is every signed in read and every judge read
 *    while the session still has an analysis left.
 * 2. The seeded demo profile, owned by DEMO_OWNER_ID
 *    (docs/07-payments-and-judge-mode.md, "Demo profile", loaded by
 *    scripts/seed-demo.ts). A judge session with no analyses left reads this
 *    one: docs/01-user-flow.md, "Judge mode across the flow", says that at zero
 *    "every screen renders from the demo profile so nothing is dead", and
 *    docs/03-architecture.md says the same in one line: "When a judge session
 *    exceeds its cap, every read route serves the demo profile".
 * 3. The checked in fixture views in src/lib/server/profile/demo-fixture*.ts,
 *    which are the same screens with no database behind them at all.
 *
 * Until this file existed, source 3 was reachable only through the
 * AURUM_DEMO_FIXTURE environment switch, and a judge session at zero analyses
 * read its own empty rows: the report answered null and sent the judge to
 * /capture, which is the dead screen the docs promise never happens. The chain
 * below is the honest version of that promise: the seeded demo profile when it
 * is there, the checked in fixture when it is not, and never the judge's own
 * empty profile.
 *
 * The environment switch keeps its own meaning and its own guard. It stays a
 * development only switch (README.md and .env.example: "it must never be true in
 * production"), and nothing here sets it, reads around it, or lets a request
 * turn it on. The judge path is a server side decision keyed on the judge
 * session row, which is why it needs no environment variable to be true.
 */

/* ------------------------------------------------------------------ */
/* The development fixture switch                                      */
/* ------------------------------------------------------------------ */

/**
 * The environment variable that turns on fixture mode.
 *
 * It lives here, next to the judge decision that reuses the same fixture
 * builders, and src/lib/server/profile/report-view.ts re exports both names so
 * every existing import keeps working.
 */
export const DEMO_FIXTURE_ENV = "AURUM_DEMO_FIXTURE";

export function isDemoFixtureMode(): boolean {
  return process.env[DEMO_FIXTURE_ENV] === "true";
}

/* ------------------------------------------------------------------ */
/* The judge decision                                                  */
/* ------------------------------------------------------------------ */

/**
 * True when this judge session has no analyses left.
 *
 * Deliberately synchronous and deliberately free of any query: it reads the
 * session row the request already carries, so the capture screen, the capture
 * route, and every write guard can ask it without a round trip. A session
 * created with JUDGE_ANALYSES_ALLOWED=0 is exhausted on its first request, which
 * is the whole point of this build: judges spend no Perfect Corp units.
 */
export function judgeAnalysesExhausted(session: AppSession | null): boolean {
  return (
    session !== null &&
    session.kind === "judge" &&
    judgeAnalysesRemaining(session.session) === 0
  );
}

/**
 * True when nothing this request writes may reach a row.
 *
 * docs/07-payments-and-judge-mode.md: "The demo profile is read only for judge
 * sessions." A judge at zero analyses is reading the demo profile on every
 * screen, so a save that stored something under their own owner id would be a
 * write nobody can see: the screen would confirm a change the next read cannot
 * show. Fixture mode has the same shape with no database at all.
 */
export function demoProfileIsReadOnly(session: AppSession | null): boolean {
  return isDemoFixtureMode() || judgeAnalysesExhausted(session);
}

/* ------------------------------------------------------------------ */
/* The read plan                                                       */
/* ------------------------------------------------------------------ */

/** Why a screen is being served from the checked in fixture. */
export type FixtureReason = "env" | "judge_exhausted";

export type DemoReadPlan =
  /** Read the caller's own rows. */
  | { readonly source: "live"; readonly ownerId: string }
  /** Read the seeded demo profile's rows. Never write to them. */
  | { readonly source: "database"; readonly ownerId: string }
  /** Read the checked in fixture views. No database is touched. */
  | { readonly source: "fixture"; readonly reason: FixtureReason };

/**
 * Whether the demo profile is actually in the database.
 *
 * The question is asked rather than assumed, because "the seed script has been
 * run" is not something the server can know from configuration. With no Supabase
 * project there is nothing to ask, and a query that fails is answered the same
 * way a missing row is: the seed is not there, so the fixture is what is true.
 */
async function demoProfileSeeded(): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    return false;
  }
  try {
    return (await getAestheticProfile(DEMO_OWNER_ID)) !== null;
  } catch {
    return false;
  }
}

/**
 * The read source for this request, resolved once per view build.
 *
 * The order matters. The development switch is answered first so a machine with
 * no Supabase project behaves exactly as it did before this file existed. A
 * session that still has an analysis reads its own rows, including a judge with
 * credits left. Only a judge at zero falls through to the demo profile.
 */
export async function planDemoRead(
  session: AppSession,
): Promise<DemoReadPlan> {
  if (isDemoFixtureMode()) {
    return { source: "fixture", reason: "env" };
  }
  if (!judgeAnalysesExhausted(session)) {
    return { source: "live", ownerId: session.id };
  }
  if (await demoProfileSeeded()) {
    console.log(
      JSON.stringify({
        event: "aurum.demo_read",
        source: "database",
        sessionId: session.id,
        ownerId: DEMO_OWNER_ID,
        note: "This judge session has no analyses left, so the screen is read from the seeded demo profile. Nothing is written to it.",
      }),
    );
    return { source: "database", ownerId: DEMO_OWNER_ID };
  }
  return { source: "fixture", reason: "judge_exhausted" };
}

/**
 * The note the fixture log line carries, in the words of whichever of the two
 * reasons is true. A judge reading the fixture must not be logged as an
 * environment switch that is not set.
 */
export function demoFixtureNote(reason: FixtureReason, served: string): string {
  if (reason === "env") {
    return `${DEMO_FIXTURE_ENV} is true: ${served} from the checked in fixture and no database or provider is touched.`;
  }
  return `This judge session has no analyses left and no demo profile is seeded, so ${served} from the checked in fixture and no database or provider is touched.`;
}
