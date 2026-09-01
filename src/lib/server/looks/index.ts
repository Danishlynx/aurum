import "server-only";

/**
 * The looks layer, in one door.
 *
 * docs/01-user-flow.md section K is the screen. The pieces behind it:
 *
 *   compose.ts    the view: candidates, ranking, gaps, renders, rows
 *   stylist.ts    the model call and its deterministic fallback
 *   rationale.ts  the rules rationale the fallback is built from
 *   gaps.ts       shop the gap, and the listing only look
 *   stored.ts     what the looks.garments column holds
 *   db.ts         the row
 *
 * The rules engine itself is src/lib/shared/looks.ts, which is pure, and the
 * only thing allowed to decide what may be worn with what.
 */

export { buildLooksView, clothHashFor } from "./compose";
export { GAP_STORE_CATEGORY, formalityWordFor, groundGaps } from "./gaps";
export {
  buildListingLookRationale,
  buildRulesRationale,
  coloringSentence,
  occasionSentence,
  type RulesRationaleInput,
} from "./rationale";
export { saveLook, type SaveLookOutcome } from "./save";
export {
  rankLooks,
  toStylistInput,
  type RankLooksInput,
  type RankLooksResult,
  type RankedLook,
  type StylistOutcome,
} from "./stylist";
