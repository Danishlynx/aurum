import "server-only";

import type {
  StylistGarmentInput,
  StylistInput,
} from "@/lib/prompts/stylist";
import {
  isNearFaceSlot,
  slotOfType,
  type Candidate,
  type LooksGarment,
  type Occasion,
} from "@/lib/shared/looks";
import type { Palette } from "@/lib/shared/palette";
import { GARMENT_TYPES } from "@/lib/shared/wardrobe-view";

import { checkRationale } from "../../../../evals/stylist/rationale";
import { ANTHROPIC_UNITS_PER_CALL, refund, reserve } from "../credits";
import { providerCallsEnabled } from "../env";
import { isAnthropicConfigured, runStylist } from "../providers/anthropic";
import type { AppSession } from "../session";
import { buildRulesRationale } from "./rationale";

/**
 * The stylist: the rules engine made the candidates, the model ranks and
 * explains them.
 *
 * docs/04-integrations.md, Stylist: "The rules engine, not the model, generates
 * candidates; the model ranks and explains." docs/03-architecture.md,
 * "Failure modes": a Claude error leaves the rules ranking with a rule based
 * rationale. Both halves live here, and the second half is the default: with no
 * ANTHROPIC_API_KEY, with the kill switch off, or with a cap reached, nothing
 * is called and every look keeps the deterministic rationale.
 *
 * Three things the model is not allowed to decide, and why:
 *
 * 1. What the person owns. The gaps come from the rules, always. A model that
 *    invented a missing piece would send us shopping for something the person
 *    already has, and spend a SerpApi search doing it.
 * 2. Whether its own rationale is good enough. Every rationale it writes goes
 *    through the hard checks in evals/stylist/rationale.ts (2 sentences, names
 *    the occasion, references the coloring, no numbers, no superlatives, no
 *    banned lexicon). A rationale that fails is replaced by the rules one for
 *    that look alone, so one bad sentence does not cost the screen its model
 *    ranking.
 * 3. Which garment carries the look, beyond the pieces next to the face. The
 *    hero is what cloth try on renders on the person, and cloth-v4 takes one
 *    garment per call, so the hero has to be the piece a person sees first. A
 *    model hero that is a shoe is kept out and the rules hero stands.
 *
 * The checker is imported from evals/stylist rather than copied because it is
 * the same check the eval suite runs. Its own header says so: "the eval runs it
 * over samples, and the looks layer runs it over a real model output before
 * storing one".
 */

/** What the classifier could not tell us, said plainly inside the prompt. */
const NOT_RECORDED = "not recorded";

export interface RankedLook {
  readonly candidateId: string;
  readonly rationale: string;
  readonly rationaleSource: "model" | "rules";
  readonly heroGarmentId: string | null;
}

export type StylistOutcome =
  | "model"
  | "model_partial"
  | "fallback_no_candidates"
  | "fallback_not_configured"
  | "fallback_kill_switch"
  | "fallback_cap"
  | "fallback_provider_error";

export interface RankLooksResult {
  readonly ranked: RankedLook[];
  readonly outcome: StylistOutcome;
  /** How many model rationales failed the hard checks. For the log line. */
  readonly rejectedRationales: number;
}

export interface RankLooksInput {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly palette: Palette | null;
  /** Every garment the candidates are built from, by id. */
  readonly garmentsById: ReadonlyMap<string, LooksGarment>;
  readonly candidates: readonly Candidate[];
  readonly onProviderCall?: (count: number) => void;
  readonly onCredits?: (units: number) => void;
  /**
   * The model call, injected so the pipeline can be exercised with no key.
   * Defaults to the real one, and the key gate above still runs first.
   */
  readonly call?: typeof runStylist;
}

function garmentsOf(
  candidate: Candidate,
  garmentsById: ReadonlyMap<string, LooksGarment>,
): LooksGarment[] {
  const found: LooksGarment[] = [];
  for (const id of candidate.garmentIds) {
    const garment = garmentsById.get(id);
    if (garment !== undefined) {
      found.push(garment);
    }
  }
  return found;
}

/** The deterministic answer for one candidate. Always available. */
function rulesLookFor(
  candidate: Candidate,
  input: RankLooksInput,
): RankedLook {
  return {
    candidateId: candidate.id,
    rationale: buildRulesRationale({
      occasion: input.occasion,
      palette: input.palette,
      garments: garmentsOf(candidate, input.garmentsById),
      ruleNotes: candidate.ruleNotes,
      gaps: candidate.gaps,
    }),
    rationaleSource: "rules",
    heroGarmentId: candidate.heroGarmentId,
  };
}

function rulesResult(
  input: RankLooksInput,
  outcome: StylistOutcome,
): RankLooksResult {
  return {
    ranked: input.candidates.map((candidate) => rulesLookFor(candidate, input)),
    outcome,
    rejectedRationales: 0,
  };
}

/** The prompt input: the palette, the occasion, the garments, the candidates. */
export function toStylistInput(input: RankLooksInput): StylistInput {
  const used = new Set<string>();
  for (const candidate of input.candidates) {
    for (const id of candidate.garmentIds) {
      used.add(id);
    }
  }

  const garments: StylistGarmentInput[] = [];
  for (const id of used) {
    const garment = input.garmentsById.get(id);
    if (garment === undefined) {
      continue;
    }
    garments.push({
      id: garment.id,
      type: garment.type ?? NOT_RECORDED,
      colorNames:
        garment.colors.length > 0
          ? garment.colors.map((color) => color.name)
          : [NOT_RECORDED],
      pattern: garment.pattern ?? NOT_RECORDED,
      formality: garment.formality ?? NOT_RECORDED,
    });
  }

  return {
    occasion: input.occasion,
    palette: {
      season: input.palette?.seasonDisplayName ?? null,
      undertone: null,
      wear: input.palette?.wear.map((color) => color.name) ?? [],
      avoid: input.palette?.avoid.map((color) => color.name) ?? [],
    },
    garments,
    combinations: input.candidates.map((candidate) => ({
      combinationId: candidate.id,
      garmentIds: [...candidate.garmentIds],
      notes: [...candidate.ruleNotes],
    })),
    garmentTypeVocabulary: [...GARMENT_TYPES],
  };
}

/**
 * The hero the model asked for, when it is one this layer can render.
 *
 * It has to be a garment in that combination and it has to sit next to the
 * face, which is the same rule the rules engine follows
 * (src/lib/shared/looks.ts, HERO_SLOT_PREFERENCE). Anything else keeps the
 * rules hero.
 */
export function acceptModelHero(args: {
  readonly proposed: string;
  readonly candidate: Candidate;
  readonly garmentsById: ReadonlyMap<string, LooksGarment>;
}): string | null {
  if (!args.candidate.garmentIds.includes(args.proposed)) {
    return null;
  }
  const garment = args.garmentsById.get(args.proposed);
  if (garment === undefined) {
    return null;
  }
  const slot = slotOfType(garment.type);
  if (slot === null || !isNearFaceSlot(slot)) {
    return null;
  }
  return args.proposed;
}

/**
 * Ranks the candidates for one occasion.
 *
 * Never throws. Every failure path returns the rules ranking with a rules
 * rationale, which is a complete, honest answer for the screen.
 */
export async function rankLooks(
  input: RankLooksInput,
): Promise<RankLooksResult> {
  if (input.candidates.length === 0) {
    return { ranked: [], outcome: "fallback_no_candidates", rejectedRationales: 0 };
  }

  const call = input.call ?? runStylist;
  if (input.call === undefined && !isAnthropicConfigured()) {
    return rulesResult(input, "fallback_not_configured");
  }
  if (!providerCallsEnabled()) {
    return rulesResult(input, "fallback_kill_switch");
  }

  const reservation = await reserve({
    session: input.session,
    provider: "anthropic",
    units: ANTHROPIC_UNITS_PER_CALL,
    note: "reserve stylist ranking",
  });
  if (!reservation.ok) {
    return rulesResult(input, "fallback_cap");
  }
  input.onCredits?.(reservation.reservation.units);

  let result: Awaited<ReturnType<typeof runStylist>>;
  try {
    result = await call(toStylistInput(input));
    input.onProviderCall?.(1);
  } catch {
    // The typed provider error is already logged by the provider module. The
    // person still gets looks, which is the point of the fallback. Nothing was
    // ranked, so nothing is owed.
    await refund({ session: input.session, reservation: reservation.reservation });
    return rulesResult(input, "fallback_provider_error");
  }

  const byId = new Map(
    input.candidates.map((candidate) => [candidate.id, candidate] as const),
  );
  const ranked: RankedLook[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const entry of result.value.ranked) {
    const candidate = byId.get(entry.combination_id);
    if (candidate === undefined || seen.has(entry.combination_id)) {
      // runStylist already validates that every combination id appears exactly
      // once. This is the belt to that pair of braces.
      continue;
    }
    seen.add(candidate.id);

    const fallback = rulesLookFor(candidate, input);
    const problems = checkRationale(entry.rationale, {
      occasion: input.occasion,
      palette: input.palette,
    });
    if (problems.length > 0) {
      rejected += 1;
      ranked.push(fallback);
      continue;
    }

    ranked.push({
      candidateId: candidate.id,
      rationale: entry.rationale.trim(),
      rationaleSource: "model",
      heroGarmentId:
        acceptModelHero({
          proposed: entry.hero_garment_id,
          candidate,
          garmentsById: input.garmentsById,
        }) ?? candidate.heroGarmentId,
    });
  }

  // Anything the model left out keeps its place at the end with the rules
  // rationale, so a short answer never loses the person a look.
  for (const candidate of input.candidates) {
    if (!seen.has(candidate.id)) {
      ranked.push(rulesLookFor(candidate, input));
    }
  }

  console.log(
    JSON.stringify({
      event: "aurum.stylist_ranked",
      ownerType: input.session.ownerType,
      ownerId: input.session.id,
      occasion: input.occasion,
      candidates: input.candidates.length,
      rejectedRationales: rejected,
      model: result.model,
      attempts: result.attempts,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    }),
  );

  return {
    ranked,
    outcome: rejected > 0 ? "model_partial" : "model",
    rejectedRationales: rejected,
  };
}
