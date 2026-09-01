import "server-only";

import { SYNTHESIS_PROMPT_VERSION } from "@/lib/prompts/synthesis";
import { concernDisplayName, type ConcernKey } from "@/lib/shared/concerns";
import { copy, fill } from "@/lib/shared/copy";

import { countSentences, MIN_SENTENCES } from "./checks";
import { locationOf, type ProfileFacts } from "./facts";
import { buildRoutine, type RoutinePlan } from "./routine";
import { skinTypeWord } from "./skin-type";

/**
 * The deterministic reading and routine.
 *
 * docs/03-architecture.md, "Failure modes and what the person sees": "Claude API
 * error: the reading block shows a deterministic fallback built from the ranked
 * concerns ('Main concern: pigmentation on the cheekbones. Skin type:
 * combination.')".
 *
 * docs/06-safety-privacy.md, "Regeneration and fallback": "A second failure uses
 * the deterministic fallback built from ranked concerns. The fallback is itself
 * lexicon checked in tests."
 *
 * Everything here is built out of copy.ts templates, concern display names, and
 * the location vocabulary, all of which are lexicon checked. That is what makes
 * the fallback safe by construction rather than safe by inspection: there is no
 * free text in it anywhere.
 *
 * It also has to clear the same bar as the model, because docs/05-evals.md
 * applies its hard checks to the reading, not to the writer: 3 to 5 sentences,
 * under 90 words, the top concern named, a place on the face named.
 */

/** Written on aesthetic_profiles.reading_model when the fallback is used. */
export const FALLBACK_READING_MODEL = `fallback/${SYNTHESIS_PROMPT_VERSION}`;

/**
 * A concern scoring at or below this is barely present, which is what makes it
 * honest to say it is going well. Above it, nothing is claimed.
 *
 * The going well line is built from the ranked concerns alone, never from
 * moisture or radiance, for one reason: the line is rebuilt every time the
 * report is rendered, out of what the profile row stores, and the profile row
 * stores the ranked concerns. Using anything else would give the reading one
 * sentence on the day it was written and a different one on the next visit.
 */
export const GOING_WELL_AT_OR_BELOW = 45;

export interface ProfileNarrative {
  readonly reading: string;
  /** One sentence naming something going well. Empty when nothing qualifies. */
  readonly goingWell: string;
  readonly topConcernKey: ConcernKey;
  readonly topConcernLocation: string;
  readonly routine: RoutinePlan;
  readonly source: "model" | "fallback";
  /** Model id plus prompt version, or the fallback tag. */
  readonly readingModel: string;
}

function lowerName(key: ConcernKey): string {
  return concernDisplayName(key).toLowerCase();
}

/**
 * The concerns worth calling out as going well: the lowest scoring ones, up to
 * two. The top concern is never one of them, because a reading cannot lead with
 * a concern and then praise it, and nothing above the threshold qualifies.
 */
export function goingWellKeys(facts: ProfileFacts): ConcernKey[] {
  return [...facts.ranked]
    .slice(1)
    .filter((entry) => entry.score <= GOING_WELL_AT_OR_BELOW)
    .sort((a, b) => (a.score === b.score ? (a.key < b.key ? -1 : 1) : a.score - b.score))
    .map((entry) => entry.key)
    .slice(0, 2);
}

/** The going well sentence, or an empty string when there is nothing to say. */
export function buildGoingWell(facts: ProfileFacts): string {
  const keys = goingWellKeys(facts);
  if (keys.length === 0) {
    return "";
  }
  if (keys.length === 1) {
    return fill(copy.report.fallbackGoingWellSingularTemplate, {
      concern: lowerName(keys[0] as ConcernKey),
    });
  }
  return fill(copy.report.fallbackGoingWellTemplate, {
    concerns: keys.map((key) => lowerName(key)).join(" and "),
  });
}

/**
 * The deterministic reading. Null when the skin analysis did not land, because
 * there is nothing honest to say without concerns.
 */
export function buildFallbackReading(facts: ProfileFacts): string | null {
  const top = facts.ranked[0];
  if (top === undefined) {
    return null;
  }

  const sentences: string[] = [];
  const skinType = skinTypeWord(facts.skinType);
  const topName = lowerName(top.key);
  const topLocation = locationOf(facts, top.key);

  sentences.push(
    skinType === null
      ? fill(copy.report.fallbackReadingNoSkinTypeTemplate, {
          concern: topName,
          location: topLocation,
        })
      : fill(copy.report.fallbackReadingTemplate, {
          concern: topName,
          location: topLocation,
          skinType,
        }),
  );

  const second = facts.ranked[1];
  if (second !== undefined) {
    sentences.push(
      fill(copy.report.fallbackSecondConcernTemplate, {
        concern: lowerName(second.key),
        location: locationOf(facts, second.key),
      }),
    );
  }

  const goingWell = buildGoingWell(facts);
  if (goingWell.length > 0) {
    sentences.push(goingWell);
  }

  // A very thin analysis can leave two sentences. The top concern's own plain
  // description is already written and already lexicon checked, so it is what
  // carries the reading to the 3 sentence floor docs/05-evals.md sets.
  if (countSentences(sentences.join(" ")) < MIN_SENTENCES) {
    sentences.push(copy.report.concerns[top.key].description);
  }

  return sentences.join(" ");
}

/** The whole deterministic narrative: reading, going well line, and routine. */
export function buildFallbackNarrative(facts: ProfileFacts): ProfileNarrative | null {
  const top = facts.ranked[0];
  const reading = buildFallbackReading(facts);
  if (top === undefined || reading === null) {
    return null;
  }
  return {
    reading,
    goingWell: buildGoingWell(facts),
    topConcernKey: top.key,
    topConcernLocation: locationOf(facts, top.key),
    routine: buildDeterministicRoutine(facts),
    source: "fallback",
    readingModel: FALLBACK_READING_MODEL,
  };
}

/**
 * The routine the report shows, built from the ranked concerns and the skin
 * type. See the note at the top of routine.ts for why it is deterministic even
 * when the model answered.
 */
export function buildDeterministicRoutine(facts: ProfileFacts): RoutinePlan {
  return buildRoutine({
    rankedKeys: facts.ranked.map((concern) => concern.key),
    qualityKeys: facts.qualities.map((quality) => quality.key),
    skinType: facts.skinType,
  });
}
