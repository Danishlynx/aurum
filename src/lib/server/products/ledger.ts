import "server-only";

import {
  refund,
  reserve,
  SERPAPI_UNITS_PER_SEARCH,
  type Reservation,
} from "../credits";
import { loadJudgeSession } from "../judge";
import type { AppSession } from "../session";
import type { GroundingReason } from "./logging";

/**
 * The credit ledger, as the grounding layer uses it.
 *
 * docs/03-architecture.md, "Credits and caps": every provider call reserves
 * credits before it starts and reconciles after; a person has a daily cap
 * (DAILY_CAP_SERPAPI_SEARCHES) and a judge session has a hard cap.
 *
 * The reservation goes through src/lib/server/credits so there is one ledger
 * implementation, not two. This file only turns the owner the grounding
 * contract is given (ownerType and ownerId, not a request session) back into an
 * AppSession, and turns a refusal into a reason the log can carry.
 *
 * A SerpApi search costs exactly one unit (SERPAPI_UNITS_PER_SEARCH), so the
 * reservation is always the actual cost and there is nothing to reconcile. A
 * search that failed is refunded, matching the rule that a call which produced
 * nothing must not leave a spend behind.
 *
 * A search is a search and a Perfect Corp unit is a unit: for a judge session
 * the two are counted against separate caps (src/lib/server/credits), so a
 * finished analysis can no longer leave the report with nothing to ground with.
 */

export interface SearchOwner {
  readonly ownerType: "user" | "judge_session";
  readonly ownerId: string;
}

type ReserveOutcome = Awaited<ReturnType<typeof reserve>>;

/**
 * The grounding contract is called from the profile builder, which may be
 * running outside a request (a job, a seed), so it passes the owner rather than
 * a session. Rebuilding the session here keeps reserve() and refund() working
 * unchanged, including the judge session counter they move.
 */
async function sessionForOwner(owner: SearchOwner): Promise<AppSession | null> {
  if (owner.ownerType === "user") {
    return { kind: "user", id: owner.ownerId, ownerType: "user" };
  }
  const session = await loadJudgeSession(owner.ownerId);
  if (session === null) {
    return null;
  }
  return {
    kind: "judge",
    id: session.id,
    ownerType: "judge_session",
    session,
  };
}

export type SearchBudget =
  | {
      readonly ok: true;
      readonly reserve: () => Promise<
        { readonly ok: true; readonly reservation: Reservation } | {
          readonly ok: false;
          readonly reason: GroundingReason;
        }
      >;
      readonly refund: (reservation: Reservation) => Promise<void>;
    }
  | { readonly ok: false; readonly reason: GroundingReason };

/**
 * Opens the budget for one grounding run. Resolving the session once means a
 * judge session is loaded once, not once per routine step.
 *
 * A ledger that cannot be reached at all is a refusal, not an exception: with no
 * ledger there is no cap, and spending without a cap is the one thing the judge
 * mode rules do not allow.
 */
export async function openSearchBudget(
  owner: SearchOwner,
): Promise<SearchBudget> {
  let resolved: AppSession | null;
  try {
    resolved = await sessionForOwner(owner);
  } catch {
    return { ok: false, reason: "ledger_unavailable" };
  }
  if (resolved === null) {
    // A judge session that expired or was never there. Reported as itself, not
    // as a cap: a cap is a number to raise, and this is a cookie to mint again.
    return { ok: false, reason: "session_expired" };
  }
  const session: AppSession = resolved;

  return {
    ok: true,
    reserve: async () => {
      let outcome: ReserveOutcome;
      try {
        outcome = await reserve({
          session,
          provider: "serpapi",
          units: SERPAPI_UNITS_PER_SEARCH,
          note: "reserve serpapi search",
        });
      } catch {
        return { ok: false as const, reason: "ledger_unavailable" as const };
      }
      if (!outcome.ok) {
        return {
          ok: false as const,
          reason:
            outcome.reason === "daily_cap"
              ? ("daily_cap" as const)
              : ("session_cap" as const),
        };
      }
      return { ok: true as const, reservation: outcome.reservation };
    },
    refund: async (reservation: Reservation) => {
      try {
        await refund({ session, reservation });
      } catch {
        // A refund that cannot be written leaves a spend recorded for a call
        // that produced nothing. That is the safe direction to fail in: it
        // undercounts the remaining budget, never overcounts it.
      }
    },
  };
}
