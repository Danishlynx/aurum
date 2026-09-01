import "server-only";

import { copy, fill } from "@/lib/shared/copy";
import { checkLexicon } from "@/lib/shared/lexicon";
import {
  dominantColorOf,
  garmentColorMatch,
  isBelowWaistSlot,
  slotOfType,
  type LooksGarment,
  type Occasion,
} from "@/lib/shared/looks";
import { OCCASION_PHRASES } from "@/lib/shared/looks-view";
import type { Palette } from "@/lib/shared/palette";

/**
 * The deterministic rationale: the rules engine's own notes, turned into one or
 * two plain sentences.
 *
 * docs/03-architecture.md, "Failure modes and what the person sees": "Claude
 * API error: ... the stylist ranks looks by the rules alone with a one line
 * rule based rationale." This is that line. It is used whenever the model
 * cannot run (no key, kill switch, cap) and whenever its answer fails the hard
 * checks in evals/stylist/rationale.ts, per look rather than per screen.
 *
 * It aims at the same standard the model is held to (docs/04-integrations.md:
 * "The rationale must reference the person's coloring and the occasion by
 * name"), and it says less when it knows less. A person with no palette gets
 * one sentence about the occasion rather than a sentence inventing a season.
 *
 * Two sources, and no third:
 *
 * 1. The colouring sentence is computed here from the palette and the garments,
 *    through the pure helpers src/lib/shared/looks.ts already exports. Nothing
 *    is inferred that the rules did not establish.
 * 2. The occasion sentence quotes a rule note verbatim. The notes are written
 *    for exactly this ("the deterministic fallback builds its rationale out of
 *    them when there is no model") and every one of them is lexicon checked in
 *    src/lib/shared/looks.test.ts.
 *
 * The one coupling to watch: gap notes are recognised by rebuilding the phrase
 * the rules engine writes for them, because a rationale should not end on what
 * the person does not own (the "Shop the gap" card says that in its own words,
 * docs/01-user-flow.md section K item 3). If that phrase ever changes in
 * looks.ts the rationale gets a little worse, not wrong.
 */

/** The phrase src/lib/shared/looks.ts writes for a missing garment type. */
function gapNoteFor(gapType: string): string {
  return `you do not own ${gapType} yet`;
}

/** Upper cases the first letter so a name can start a sentence. */
function sentenceStart(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function isClean(text: string): boolean {
  return checkLexicon(text).length === 0;
}

export interface RulesRationaleInput {
  readonly occasion: Occasion;
  readonly palette: Palette | null;
  /** The pieces in the look, in the order the rules put them. */
  readonly garments: readonly LooksGarment[];
  /** The rules engine's notes for this combination, in its own order. */
  readonly ruleNotes: readonly string[];
  /** The garment types this combination is missing. */
  readonly gaps: readonly string[];
}

/**
 * The sentence about the person's colouring, or null when there is nothing true
 * to say. Never guesses a season and never claims a colour flatters when the
 * palette does not say so.
 */
export function coloringSentence(input: RulesRationaleInput): string | null {
  const palette = input.palette;
  if (palette === null) {
    return null;
  }

  for (const garment of input.garments) {
    const match = garmentColorMatch(garment, palette);
    const dominant = dominantColorOf(garment);
    if (match.family === "wear" && dominant !== null) {
      return fill(copy.looks.rationale.colorTemplate, {
        color: sentenceStart(dominant.name),
        season: palette.seasonDisplayName,
      });
    }
  }

  for (const garment of input.garments) {
    const slot = slotOfType(garment.type);
    const match = garmentColorMatch(garment, palette);
    const dominant = dominantColorOf(garment);
    if (
      slot !== null &&
      isBelowWaistSlot(slot) &&
      match.family === "avoid" &&
      dominant !== null
    ) {
      return fill(copy.looks.rationale.avoidColorTemplate, {
        color: sentenceStart(dominant.name),
      });
    }
  }

  return fill(copy.looks.rationale.noColorTemplate, {
    season: palette.seasonDisplayName,
  });
}

/**
 * The sentence about the occasion. Always returned: an occasion is the one
 * thing this layer always knows.
 *
 * The reason is the last rule note that is not about a gap, which by the order
 * notesFor writes them is the formality or the layer note, the two facts that
 * are actually about the occasion. With no notes at all it falls back to the
 * plainest true statement: these are the pieces you own that fit.
 */
export function occasionSentence(input: RulesRationaleInput): string {
  const gapNotes = new Set(input.gaps.map(gapNoteFor));
  const usable = input.ruleNotes.filter(
    (note) => !gapNotes.has(note) && isClean(note),
  );
  const reason = usable[usable.length - 1] ?? copy.looks.rationale.reasonOwnedPieces;

  return fill(copy.looks.rationale.occasionTemplate, {
    occasion: OCCASION_PHRASES[input.occasion],
    reason,
  });
}

/**
 * The rules rationale for one candidate combination.
 *
 * One to two sentences. The colouring sentence is dropped when there is no
 * palette, and either sentence is dropped if it fails the safety lexicon, which
 * can only happen through a garment colour name (data from the classifier or
 * typed by the person, never trusted as copy). What is left is always at least
 * one sentence written entirely from copy.ts.
 */
export function buildRulesRationale(input: RulesRationaleInput): string {
  const coloring = coloringSentence(input);
  const occasion = occasionSentence(input);

  const sentences: string[] = [];
  if (coloring !== null && isClean(coloring)) {
    sentences.push(coloring);
  }
  if (isClean(occasion)) {
    sentences.push(occasion);
  } else {
    sentences.push(
      fill(copy.looks.rationale.occasionTemplate, {
        occasion: OCCASION_PHRASES[input.occasion],
        reason: copy.looks.rationale.reasonOwnedPieces,
      }),
    );
  }

  return sentences.join(" ");
}

/**
 * The rationale for a look composed from listings, docs/01-user-flow.md section
 * K states: "No wardrobe: the looks are composed entirely from live listings
 * within the palette."
 *
 * The second sentence says plainly that nothing here is theirs yet, because the
 * screen is showing a person clothes they do not own and must not imply
 * otherwise.
 */
export function buildListingLookRationale(args: {
  readonly occasion: Occasion;
  readonly palette: Palette | null;
  /** The palette colour the listings were searched for, when there was one. */
  readonly colorName: string | null;
}): string {
  const sentences: string[] = [];

  if (args.palette !== null && args.colorName !== null) {
    const coloring = fill(copy.looks.rationale.colorTemplate, {
      color: sentenceStart(args.colorName),
      season: args.palette.seasonDisplayName,
    });
    if (isClean(coloring)) {
      sentences.push(coloring);
    }
  }

  sentences.push(
    fill(copy.looks.rationale.occasionTemplate, {
      occasion: OCCASION_PHRASES[args.occasion],
      reason: copy.looks.rationale.reasonListings,
    }),
  );

  return sentences.join(" ");
}
