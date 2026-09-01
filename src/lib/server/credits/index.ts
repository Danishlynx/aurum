import "server-only";

import { serviceClient, unwrap } from "../db/service";
import type { CreditLedgerEntry, CreditProvider, Insert } from "../db/types";
import { dailyCaps } from "../env";
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

export type ReserveResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | {
      readonly ok: false;
      readonly reason: "daily_cap" | "session_cap";
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

async function sumUnits(args: {
  readonly owner: CreditOwner;
  readonly provider: CreditProvider;
  readonly since: string | null;
}): Promise<number> {
  let query = serviceClient()
    .from("credit_ledger")
    .select("units")
    .eq("owner_type", args.owner.ownerType)
    .eq("owner_id", args.owner.ownerId)
    .eq("provider", args.provider);

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
 * Reserves units before a provider call. Returns a typed refusal instead of
 * throwing, because a cap is an expected answer the routes turn into a 429 with
 * the judge copy, not an error.
 *
 * For a judge session the session counter is moved first: it is the counter the
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

  const cap = dailyCapFor(args.provider);
  if (cap !== null) {
    const used = await spentToday(owner, args.provider);
    if (used + units > cap) {
      return { ok: false, reason: "daily_cap", remaining: Math.max(0, cap - used) };
    }
  }

  if (args.session.kind === "judge") {
    const outcome = await adjustJudgeCredits(args.session.id, units);
    if (!outcome.ok) {
      const remaining = Math.max(
        0,
        args.session.session.credits_cap - args.session.session.credits_used,
      );
      return { ok: false, reason: "session_cap", remaining };
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

  if (args.session.kind === "judge") {
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

  if (args.session.kind === "judge") {
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

  const reservationRow = rows.find(
    (row) => row.units > 0 && (row.note ?? "").startsWith("reserve"),
  );
  if (reservationRow === undefined) {
    return null;
  }

  const settled = rows.some(
    (row) => (row.note ?? "") === `refund ${reservationRow.id}`,
  );
  if (settled) {
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

/** What the health route and the judge banner read. */
export async function capSnapshot(
  session: AppSession,
  provider: CreditProvider,
): Promise<CapSnapshot> {
  const owner = ownerOf(session);
  return {
    provider,
    usedToday: await spentToday(owner, provider),
    dailyCap: dailyCapFor(provider),
    sessionUsed:
      session.kind === "judge" ? session.session.credits_used : null,
    sessionCap: session.kind === "judge" ? session.session.credits_cap : null,
  };
}
