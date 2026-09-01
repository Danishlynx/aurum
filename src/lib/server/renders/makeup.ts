import "server-only";

import type { MakeupCategory } from "@/lib/shared/color-view";

import { getEndpoint } from "../providers/perfectcorp";
import type { StoredMakeupParams } from "./params";

/**
 * The makeup try on request body.
 *
 * The provider module owns the wire format for the envelope, the task creation,
 * and the polling. This file owns the one thing left: which effects we ask for.
 * It is the render twin of src/lib/server/jobs/analysis.ts.
 *
 * docs/04-integrations.md, "Makeup try on (Layer 2): 13 categories; we use lip,
 * blush, foundation, and eye, and the full look try on for the hero."
 *
 * CONFIRMED, from src/lib/server/providers/perfectcorp/endpoints.ts: the path,
 * that the body is { src_file_id or src_file_url, effects: [...],
 * version: "1.0" }, that the category names include foundation, blush,
 * lip_color, and eye_shadow, that the result is data.results.url, and that one
 * successful call costs 1 unit.
 *
 * UNVERIFIED: the field inside an effect that carries the colour. The reference
 * page records the categories but not the colour payload, so the shape below
 * (palettes, each with colors of { color, intensity }) is the shape the YouCam
 * SDKs use and is a best reading, not a confirmed one. Nothing calls it in this
 * build: with no PERFECTCORP_API_KEY the render route refuses before it gets
 * here, and the screen shows "Preview unavailable for this shade."
 *
 * TODO for the human: run one makeup try on from the API playground, record the
 * effect payload in endpoints.ts next to the other confirmed facts, and correct
 * this file if it differs. Until then, no render has ever been produced from it.
 */

/** The provider's category name for each of our four rows. */
export const MAKEUP_EFFECT_CATEGORY: Readonly<
  Record<MakeupCategory, string>
> = {
  lip: "lip_color",
  blush: "blush",
  foundation: "foundation",
  eye: "eye_shadow",
};

/** The API version string the reference page records for this endpoint. */
export const MAKEUP_VTO_VERSION = "1.0";

/** Full strength. The swatch the person picked is the colour they asked for. */
export const MAKEUP_INTENSITY = 100;

function effectFor(entry: {
  readonly category: string;
  readonly shadeHex: string;
}): Record<string, unknown> | null {
  const category =
    MAKEUP_EFFECT_CATEGORY[entry.category as MakeupCategory] ?? null;
  if (category === null) {
    return null;
  }
  return {
    category,
    palettes: [
      {
        colors: [{ color: entry.shadeHex, intensity: MAKEUP_INTENSITY }],
      },
    ],
  };
}

/**
 * The body for one makeup try on task. Returns null when no category survived
 * the mapping, which the caller reads as "there is nothing to render".
 */
export function makeupTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredMakeupParams;
}): Record<string, unknown> | null {
  const endpoint = getEndpoint("makeupTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";

  const effects: Record<string, unknown>[] = [];
  for (const entry of args.params.categories) {
    const effect = effectFor(entry);
    if (effect !== null) {
      effects.push(effect);
    }
  }
  if (effects.length === 0) {
    return null;
  }

  return {
    [fileField]: args.fileId,
    effects,
    version: MAKEUP_VTO_VERSION,
  };
}
