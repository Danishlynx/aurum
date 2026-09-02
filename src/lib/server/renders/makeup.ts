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
 * CONFIRMED against the live API on 2026-09-02 and against
 * https://docs.makeupar.com/reference/makeup_vto/section/overview/integration-guide
 * read the same day. The body is:
 *
 *     { src_file_id, effects: [ ... ], version: "1.0" }
 *
 * and one effect is NOT the shape this file used to send. The first golden run
 * was rejected with 400 InvalidParameters because of it, so the correction is
 * written down in full:
 *
 *   was:  { category, palettes: [ { colors: [ { color, intensity } ] } ] }
 *   is:   { category, pattern: { name }, palettes: [ { color, texture, colorIntensity } ] }
 *
 * Three separate mistakes in one line. palettes is a flat list of colours, not a
 * list of palettes each holding a list of colours. The strength field is called
 * colorIntensity, not intensity. And every category needs a shape selector next
 * to its colours, which was missing entirely: a pattern for blush and eye
 * shadow, a shape and a style for lip colour.
 *
 * How this was settled without spending a unit. A task creation that is rejected
 * is free, and a src_file_id the file service cannot resolve is always rejected,
 * so a bogus file id turns the endpoint into an oracle that answers for nothing:
 *
 *   "category is not one of the accepted values., or pattern is required but
 *   wasn't included in your request., or ..."   the effects array is wrong
 *
 *   "One or more parameters in this request are invalid."
 *                                               the effects array is right and
 *                                               only the file id was rejected
 *
 * Every payload below was driven to the second answer before a real file id was
 * ever attached. The same probe proved src_file_id is a field this endpoint
 * knows: with a real uploaded file id and a deliberately broken effect, the
 * answer moves back to the detailed enumeration, which it could only do by
 * getting past the source check first.
 *
 * The enumeration also names what each category wants, which is where the
 * foundation payload below comes from: "colorIntensity, coverageIntensity,
 * glowIntensity is required" is the foundation branch of the union.
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

/**
 * The finish. Every shade we offer is a flat colour rather than a shimmer or a
 * gloss, so "matte" is the honest reading of the swatch: the other textures need
 * companion fields (gloss, shimmerColor, shimmerSize) that no swatch carries.
 */
export const MAKEUP_TEXTURE = "matte";

/**
 * The single colour pattern, confirmed present in both catalogs the provider
 * publishes at https://plugins-media.makeupar.com/wcm-saas/patterns/blush.json
 * and .../eyeshadow.json, read on 2026-09-02. Both list it as category "1 color"
 * with colorNum 1, and colorNum is what decides how many palette entries the
 * request has to carry. One swatch, one colour, one entry.
 */
export const MAKEUP_ONE_COLOR_PATTERN = "1color1";

/** Lip colour takes a shape instead of a pattern. This one leaves lips as they are. */
export const LIP_SHAPE_NAME = "original";

/** Full lips rather than ombre or two tone: one swatch is one colour. */
export const LIP_STYLE_TYPE = "full";

/** Foundation coverage. Full, to match MAKEUP_INTENSITY on the other rows. */
export const FOUNDATION_COVERAGE_INTENSITY = 100;

/** No added sheen. The report speaks about skin, not about a highlighter. */
export const FOUNDATION_GLOW_INTENSITY = 0;

/**
 * The provider takes "#RRGGBB". Our swatches are stored lower cased by
 * canonicalMakeupParams, and the reference examples are upper cased, so the
 * body is upper cased on the way out to match the documented form exactly.
 */
function providerHex(shadeHex: string): string {
  return shadeHex.trim().toUpperCase();
}

function effectFor(entry: {
  readonly category: string;
  readonly shadeHex: string;
}): Record<string, unknown> | null {
  const category =
    MAKEUP_EFFECT_CATEGORY[entry.category as MakeupCategory] ?? null;
  if (category === null) {
    return null;
  }
  const color = providerHex(entry.shadeHex);

  if (category === "foundation") {
    return {
      category,
      palettes: [
        {
          color,
          colorIntensity: MAKEUP_INTENSITY,
          coverageIntensity: FOUNDATION_COVERAGE_INTENSITY,
          glowIntensity: FOUNDATION_GLOW_INTENSITY,
        },
      ],
    };
  }

  if (category === "lip_color") {
    return {
      category,
      shape: { name: LIP_SHAPE_NAME },
      style: { type: LIP_STYLE_TYPE },
      palettes: [
        { color, texture: MAKEUP_TEXTURE, colorIntensity: MAKEUP_INTENSITY },
      ],
    };
  }

  // blush and eye_shadow, which both select their shape with a pattern.
  return {
    category,
    pattern: { name: MAKEUP_ONE_COLOR_PATTERN },
    palettes: [
      { color, texture: MAKEUP_TEXTURE, colorIntensity: MAKEUP_INTENSITY },
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
