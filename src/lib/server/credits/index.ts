import "server-only";

import { serviceClient, unwrap } from "../db/service";
import type { CreditLedgerEntry, CreditProvider, Insert } from "../db/types";
import {
  dailyCaps,
  globalDailyCap,
  judgePerSessionCapsEnabled,
  judgeSearchesAllowed,
} from "../env";
import { adjustJudgeCredits } from "../judge";
import type { AppSession } from "../session";

export {
  ANTHROPIC_UNITS_PER_CALL,
  ENDPOINT_FOR_ANALYSIS,
  hasUnknownCost,
  perfectCorpUnits,
  SERPAPI_UNITS_PER_SEARCH,
  UNKNOWN_COST_FALLBACK_UNITS,
  unitsForProvider,
} from "./costs";

/**
 * The credit ledger.
 *
 * docs/03-architecture.md, "Credits and caps": every provider call reserves
 * credits before it starts and reconciles after. A person has a daily cap; a
 * judge session has a hard cap for its whole life. Requests beyond a cap return
 * 429 and the UI falls back to cache or the demo profile.
 *
 * Above both of those sits one ceiling that is not per owner at all: the
 * deployment's own Perfect Corp spend for the UTC day
 * (GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY, src/lib/server/env.ts). Every per owner
 * cap is only as strong as the number of owners, and owners are free to mint, so
 * the total needs a number of its own.
 *
 * The ledger is append only. A reservation is a positive row, a refund is a
 * negative row, and reconciliation is a signed adjustment. The balance is
 * always a sum, so nothing is ever silently rewritten.
 */

export interface CreditOwner {
  readonly ownerType: "user" | "judge_session";
  readonly ownerId: string;
}

export function ownerOf(session: AppSession): CreditOwner {
  return { ownerType: session.ownerType, ownerId: session.id };
}

export interface Reservation {
  readonly id: string;
  readonly owner: CreditOwner;
  readonly provider: CreditProvider;
  readonly units: number;
  readonly subjectId: string | null;
}

/**
 * Why a reservation was refused.
 *
 * - daily_cap: this owner has spent their own allowance for the UTC day.
 * - session_cap: this judge session has spent its allowance for its whole life.
 *   Returned only while JUDGE_PER_SESSION_CAPS is on (src/lib/server/env.ts);
 *   with it off the allowance is still counted and never refused.
 * - global_cap: the deployment has spent its Perfect Corp allowance for the UTC
 *   day, whoever spent it. The only refusal here that is not about the caller,
 *   and the only one another owner's traffic can cause.
 */
export type ReserveRefusal = "daily_cap" | "session_cap" | "global_cap";

export type ReserveResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | {
      readonly ok: false;
      readonly reason: ReserveRefusal;
      readonly remaining: number;
    };

/** Daily caps are per person, per provider, per UTC day. */
function startOfUtcDay(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function dailyCapFor(provider: CreditProvider): number | null {
  const caps = dailyCaps();
  if (provider === "perfectcorp") {
    return caps.perfectcorpUnits;
  }
  if (provider === "serpapi") {
    return caps.serpapiSearches;
  }
  // Claude usage is recorded, not capped: docs/04-integrations.md sets no
  // per person ceiling for it.
  return null;
}

/**
 * Sums ledger rows for one provider, optionally narrowed to one owner.
 *
 * A null owner is the deployment wide total, and it is the one query in this
 * file that deliberately does not filter on ownership. It reads no row content,
 * only the units column, so it cannot hand one person another person's data: the
 * answer is a single number about the account, which is exactly what a global
 * ceiling has to be measured against.
 *
 * Refunds are negative rows, so they come out of this sum on their own. A task
 * the engine refused therefore gives its units back to the ceiling as well as to
 * its owner, and does not eat a day's allowance for nothing.
 */
async function sumUnits(args: {
  readonly owner: CreditOwner | null;
  readonly provider: CreditProvider;
  readonly since: string | null;
}): Promise<number> {
  let query = serviceClient()
    .from("credit_ledger")
    .select("units")
    .eq("provider", args.provider);

  if (args.owner !== null) {
    query = query
      .eq("owner_type", args.owner.ownerType)
      .eq("owner_id", args.owner.ownerId);
  }

  if (args.since !== null) {
    query = query.gte("created_at", args.since);
  }

  const rows = unwrap("sum credit ledger", await query);
  let total = 0;
  for (const row of rows) {
    total += row.units;
  }
  return total;
}

/** Units spent today by this owner on this provider, refunds included. */
export async function spentToday(
  owner: CreditOwner,
  provider: CreditProvider,
): Promise<number> {
  return sumUnits({ owner, provider, since: startOfUtcDay() });
}

/** Units spent over the whole life of this owner, refunds included. */
export async function spentTotal(
  owner: CreditOwner,
  provider: CreditProvider,
): Promise<number> {
  return sumUnits({ owner, provider, since: null });
}

/**
 * Units spent today on this provider by every owner together, refunds included.
 * The number the global ceiling is checked against.
 */
export async function spentTodayAllOwners(
  provider: CreditProvider,
): Promise<number> {
  return sumUnits({ owner: null, provider, since: startOfUtcDay() });
}

/**
 * What is left of the deployment's Perfect Corp allowance for this UTC day.
 * Read by GET /api/health so the ceiling can be watched rather than discovered
 * from a drained account.
 */
export async function globalRemainingToday(): Promise<number> {
  const ceiling = globalDailyCap();
  const used = await spentTodayAllOwners("perfectcorp");
  return Math.max(0, ceiling - used);
}

/**
 * Which counter a judge session's per session cap is kept in, per provider.
 *
 * Units and searches are two currencies, bought from two companies, and they
 * used to share one counter. credits_cap is sized in Perfect Corp units
 * (docs/04-integrations.md: one capture set is 58 of them), so a session that had
 * run its analyses had nothing left to buy a search with, and every routine step
 * on the report fell back to "No listing found near you yet" while the log said
 * session_cap after zero searches. They are separate here:
 *
 * - perfectcorp: the judge_sessions.credits_used column, which is what
 *   credits_cap counts and what the judge banner reads.
 * - serpapi: its own allowance, JUDGE_SERPAPI_SEARCHES, measured from this
 *   session's own serpapi rows in the ledger. No column, no migration, and
 *   refunds are already part of the sum.
 * - anthropic: recorded, never capped, exactly as dailyCapFor already treats it.
 */
type JudgeCapKind = "units" | "searches" | "uncapped";

function judgeCapKindFor(provider: CreditProvider): JudgeCapKind {
  if (provider === "perfectcorp") {
    return "units";
  }
  if (provider === "serpapi") {
    return "searches";
  }
  return "uncapped";
}

/**
 * Reserves units before a provider call. Returns a typed refusal instead of
 * throwing, because a cap is an expected answer the routes turn into a 429 with
 * the judge copy, not an error.
 *
 * The global Perfect Corp ceiling is checked first, before anything per owner
 * and before any counter moves, because it is the only check that can refuse a
 * caller who has done nothing wrong and it must not leave a half spend behind.
 *
 * For a judge session the session counter is moved next: it is the counter the
 * cap is checked against, so if it refuses, no ledger row is written and no
 * provider call happens.
 */
export async function reserve(args: {
  readonly session: AppSession;
  readonly provider: CreditProvider;
  readonly units: number;
  readonly subjectId?: string | null;
  readonly note?: string;
}): Promise<ReserveResult> {
  const owner = ownerOf(args.session);
  const units = Math.max(1, Math.round(args.units));

  /*
   * The deployment wide ceiling, Perfect Corp only.
   *
   * SerpApi is left alone on purpose: it has its own per owner daily cap and its
   * own plan quota, and its unit is a search rather than a share of one prepaid
   * unit balance. Claude is recorded, never capped. Only Perfect Corp units come
   * out of a single number that can reach zero mid demo.
   */
  if (args.provider === "perfectcorp") {
    const ceiling = globalDailyCap();
    const spentEverywhere = await spentTodayAllOwners("perfectcorp");
    if (spentEverywhere + units > ceiling) {
      return {
        ok: false,
        reason: "global_cap",
        remaining: Math.max(0, ceiling - spentEverywhere),
      };
    }
  }

  const cap = dailyCapFor(args.provider);
  if (cap !== null) {
    const used = await spentToday(owner, args.provider);
    if (used + units > cap) {
      return { ok: false, reason: "daily_cap", remaining: Math.max(0, cap - used) };
    }
  }

  /*
   * The per session caps, and only they, answer to JUDGE_PER_SESSION_CAPS
   * (src/lib/server/env.ts). With it off, session_cap is never returned: the
   * units counter is still moved, because credits_used is what the stats route
   * and the banner read and it has to stay true, and the searches are still
   * counted in the ledger. Both ceilings above are already past at this point
   * and neither of them reads this switch.
   */
  if (args.session.kind === "judge") {
    const kind = judgeCapKindFor(args.provider);
    if (kind === "units") {
      const outcome = await adjustJudgeCredits(args.session.id, units);
      if (!outcome.ok && judgePerSessionCapsEnabled()) {
        const remaining = Math.max(
          0,
          args.session.session.credits_cap - args.session.session.credits_used,
        );
        return { ok: false, reason: "session_cap", remaining };
      }
    } else if (kind === "searches" && judgePerSessionCapsEnabled()) {
      const allowed = judgeSearchesAllowed();
      const used = await spentTotal(owner, args.provider);
      if (used + units > allowed) {
        return {
          ok: false,
          reason: "session_cap",
          remaining: Math.max(0, allowed - used),
        };
      }
    }
  }

  const row: Insert<"credit_ledger"> = {
    owner_type: owner.ownerType,
    owner_id: owner.ownerId,
    provider: args.provider,
    units,
    subject_id: args.subjectId ?? null,
    note: args.note ?? "reserve",
  };

  const entry: CreditLedgerEntry = unwrap(
    "reserve credits",
    await serviceClient().from("credit_ledger").insert(row).select("*").single(),
  );

  return {
    ok: true,
    reservation: {
      id: entry.id,
      owner,
      provider: args.provider,
      units,
      subjectId: entry.subject_id,
    },
  };
}

/**
 * Settles a reservation against what the call actually cost. A zero difference
 * writes nothing, because the ledger refuses a zero row by constraint and a no
 * op row would only add noise.
 */
export async function reconcile(args: {
  readonly session: AppSession;
  readonly reservation: Reservation;
  readonly actualUnits: number;
}): Promise<void> {
  const delta = Math.round(args.actualUnits) - args.reservation.units;
  if (delta === 0) {
    return;
  }

  // Only the counter reserve() actually moved is moved back, or a serpapi
  // settlement would hand the session free Perfect Corp units.
  if (
    args.session.kind === "judge" &&
    judgeCapKindFor(args.reservation.provider) === "units"
  ) {
    await adjustJudgeCredits(args.session.id, delta);
  }

  const row: Insert<"credit_ledger"> = {
    owner_type: args.reservation.owner.ownerType,
    owner_id: args.reservation.owner.ownerId,
    provider: args.reservation.provider,
    units: delta,
    subject_id: args.reservation.subjectId,
    note: `reconcile ${args.reservation.id}`,
  };
  unwrap(
    "reconcile credits",
    await serviceClient().from("credit_ledger").insert(row).select("*").single(),
  );
}

/**
 * Gives a reservation back when the call failed.
 * docs/04-integrations.md: "If the engine fails to process the task, the task's
 * status will change to 'error' and no unit will be consumed", so a failed job
 * must not leave a spend behind.
 *
 * Refunds are keyed by the reservation id in the note, so a second refund for
 * the same reservation is a no op rather than free credit.
 */
export async function refund(args: {
  readonly session: AppSession;
  readonly reservation: Reservation;
}): Promise<void> {
  const note = `refund ${args.reservation.id}`;

  const existing = unwrap(
    "check refund",
    await serviceClient()
      .from("credit_ledger")
      .select("id")
      .eq("owner_type", args.reservation.owner.ownerType)
      .eq("owner_id", args.reservation.owner.ownerId)
      .eq("note", note),
  );
  if (existing.length > 0) {
    return;
  }

  if (
    args.session.kind === "judge" &&
    judgeCapKindFor(args.reservation.provider) === "units"
  ) {
    await adjustJudgeCredits(args.session.id, -args.reservation.units);
  }

  const row: Insert<"credit_ledger"> = {
    owner_type: args.reservation.owner.ownerType,
    owner_id: args.reservation.owner.ownerId,
    provider: args.reservation.provider,
    units: -args.reservation.units,
    subject_id: args.reservation.subjectId,
    note,
  };
  unwrap(
    "refund credits",
    await serviceClient().from("credit_ledger").insert(row).select("*").single(),
  );
}

/**
 * Rebuilds a reservation from the ledger so a later request (a poll, a retry)
 * can refund or reconcile a spend an earlier request made.
 */
export async function findReservation(args: {
  readonly owner: CreditOwner;
  readonly subjectId: string;
  readonly provider: CreditProvider;
}): Promise<Reservation | null> {
  const rows = unwrap(
    "find reservation",
    await serviceClient()
      .from("credit_ledger")
      .select("*")
      .eq("owner_type", args.owner.ownerType)
      .eq("owner_id", args.owner.ownerId)
      .eq("provider", args.provider)
      .eq("subject_id", args.subjectId)
      .order("created_at", { ascending: true }),
  );

  // The newest reservation that has not been refunded. A subject can carry more
  // than one: a render that failed and was asked for again reserves a second
  // time, and returning the first (already refunded) row would leave the second
  // spend with nothing able to refund it.
  const refunded = new Set(
    rows
      .map((row) => row.note ?? "")
      .filter((note) => note.startsWith("refund "))
      .map((note) => note.slice("refund ".length)),
  );
  const reservationRow = [...rows]
    .reverse()
    .find(
      (row) =>
        row.units > 0 &&
        (row.note ?? "").startsWith("reserve") &&
        !refunded.has(row.id),
    );
  if (reservationRow === undefined) {
    return null;
  }

  return {
    id: reservationRow.id,
    owner: args.owner,
    provider: args.provider,
    units: reservationRow.units,
    subjectId: reservationRow.subject_id,
  };
}

export interface CapSnapshot {
  readonly provider: CreditProvider;
  readonly usedToday: number;
  readonly dailyCap: number | null;
  readonly sessionUsed: number | null;
  readonly sessionCap: number | null;
}

/**
 * What the health route and the judge banner read.
 *
 * The session pair is the counter this provider is actually checked against, so
 * a serpapi snapshot answers in searches and a perfectcorp one in units. Reading
 * credits_used for both was the same conflation the reservation had.
 */
export async function capSnapshot(
  session: AppSession,
  provider: CreditProvider,
): Promise<CapSnapshot> {
  const owner = ownerOf(session);
  const base = {
    provider,
    usedToday: await spentToday(owner, provider),
    dailyCap: dailyCapFor(provider),
  } as const;

  if (session.kind !== "judge") {
    return { ...base, sessionUsed: null, sessionCap: null };
  }
  const kind = judgeCapKindFor(provider);
  if (kind === "units") {
    return {
      ...base,
      sessionUsed: session.session.credits_used,
      sessionCap: session.session.credits_cap,
    };
  }
  if (kind === "searches") {
    return {
      ...base,
      sessionUsed: await spentTotal(owner, provider),
      sessionCap: judgeSearchesAllowed(),
    };
  }
  return { ...base, sessionUsed: null, sessionCap: null };
}
