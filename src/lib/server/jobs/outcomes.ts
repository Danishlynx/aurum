import "server-only";

import { z } from "zod";

import { serviceClient } from "../db/service";
import { isSupabaseConfigured } from "../env";

/**
 * The one go reading rate, read from the capture_outcomes view (migration
 * 0015) for /api/judge/stats.
 *
 * The definition, from docs/05-evals.md: over first camera captures (path
 * camera, attempt 1) that the client accepted and a face model measured, with
 * no provider failure touching them, the share where all four runnable readings
 * succeeded and the profile pointed at the capture within 120 seconds. A cache
 * hit never makes a captures row, so it is out by construction.
 *
 * Null whenever the view cannot be read: no Supabase project, a project the
 * migration has not reached, or a query that failed. The stats route reports
 * the other numbers either way; a missing rate is a missing rate, never a zero.
 */

export const ONE_GO_WINDOW_DAYS = 7;

export interface OneGoWindow {
  /** Rows in the window that qualify (first camera capture, accepted, measured). */
  readonly n: number;
  /** Of those, the ones read in one go. */
  readonly ok: number;
  /** ok over n, or null when n is zero. */
  readonly rate: number | null;
}

export interface OneGoStats {
  readonly window7d: OneGoWindow;
}

/** Only the two columns the rate needs, read back through zod like any row. */
const outcomeRowSchema = z.object({
  one_go: z.boolean(),
  provider_failed: z.boolean(),
});

/** Pure, so the arithmetic is testable without a view behind it. */
export function oneGoWindowOf(
  rows: ReadonlyArray<{ readonly one_go: boolean; readonly provider_failed: boolean }>,
): OneGoWindow {
  let n = 0;
  let ok = 0;
  for (const row of rows) {
    if (row.provider_failed) {
      continue;
    }
    n += 1;
    if (row.one_go) {
      ok += 1;
    }
  }
  return { n, ok, rate: n === 0 ? null : ok / n };
}

export async function readOneGoStats(now: Date = new Date()): Promise<OneGoStats | null> {
  if (!isSupabaseConfigured()) {
    return null;
  }
  const since = new Date(now.getTime() - ONE_GO_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  try {
    const result = await serviceClient()
      .from("capture_outcomes")
      .select("one_go, provider_failed")
      .gte("created_at", since.toISOString())
      .eq("path", "camera")
      .eq("attempt", 1)
      .eq("verdict", "accept")
      .eq("measured", true);
    if (result.error !== null) {
      return null;
    }
    const rows = z.array(outcomeRowSchema).safeParse(result.data);
    if (!rows.success) {
      return null;
    }
    return { window7d: oneGoWindowOf(rows.data) };
  } catch {
    // The view is not there yet, or the project is unreachable. The rate is
    // unknown, which is what null says.
    return null;
  }
}
