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
 *
 * Checked again on 2026-09-02, one category at a time, because only lip colour
 * and blush had ever been rendered and the other two rows had never been sent to
 * the API at all:
 *
 *   foundation alone            passes
 *   foundation without
 *     coverageIntensity         "coverageIntensity is required but wasn't
 *                               included in your request."
 *   eye_shadow alone            passes
 *   all four rows in one task   passes
 *
 * So the foundation branch really does want all four palette fields, and the
 * eye_shadow body is the blush body with a different category, which is what
 * this file already assumed. The same check was run against the request schema
 * in the OpenAPI bundle behind the reference page
 * (docs.makeupar.com/_bundle/reference/makeup_vto.json), which agrees field for
 * field and names "original" as a lip shape label.
 *
 * One thing the oracle does not catch: an invented pattern name passes creation.
 * A wrong pattern is only found later, as a failed task. So the names below are
 * read from the live catalogs rather than trusted, most recently on 2026-09-02.
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

/**
 * How much of the swatch lands on the face, 0 to 100.
 *
 * This was 100, on the reasoning that the swatch the person picked is the colour
 * they asked for. The first real render settled that argument against us: full
 * strength put hard magenta discs on both cheeks and a flat red lip, which is
 * stage makeup and not a try on. Nobody looking at it would believe they were
 * seeing a person wearing makeup, which is the only thing this render is for.
 *
 * 35 is the default now. A try on is a picture of the person, lightly tinted,
 * not a picture of the pigment.
 */
export const MAKEUP_INTENSITY = 35;

/**
 * Per category strength, where the default is not the right answer.
 *
 * Only the two rows that have been checked against a real render are here. The
 * others sit on MAKEUP_INTENSITY until a render says otherwise, which is the
 * honest place for them: a number nobody has looked at should not be dressed up
 * as a tuned one.
 *
 * Blush is the lowest because it covers the most skin over the widest area, so
 * it is the first thing to read as painted on.
 */
export const MAKEUP_CATEGORY_INTENSITY: Readonly<
  Partial<Record<MakeupCategory, number>>
> = {
  lip: 30,
  blush: 22,
};

/** The strength for one row: its own tuned value, or the default. */
export function intensityFor(category: MakeupCategory): number {
  return MAKEUP_CATEGORY_INTENSITY[category] ?? MAKEUP_INTENSITY;
}

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
 *
 * It is also the softest of the 227 single colour blush patterns, which was
 * checked rather than assumed: every pattern carries a thumbnail URL, and the
 * catalog splits into a "Blush 3D" family (1color1 to 1color8) and a "Blush 2D"
 * family of shape stamps (Circle, Heart, Oblique, Oblong, Rectangle, Round,
 * Triangle). Comparing thumbnails across both, the 2D stamps are larger, higher
 * on the cheek, and far more saturated; 1color1 is a small diffuse patch sitting
 * low on the cheek. The hard discs on the first render came from an intensity of
 * 100 and a saturated magenta, not from this pattern.
 */
export const MAKEUP_ONE_COLOR_PATTERN = "1color1";

/** Lip colour takes a shape instead of a pattern. This one leaves lips as they are. */
export const LIP_SHAPE_NAME = "original";

/** Full lips rather than ombre or two tone: one swatch is one colour. */
export const LIP_STYLE_TYPE = "full";

/**
 * Foundation coverage. Light, for the same reason MAKEUP_INTENSITY came down:
 * full coverage paints over the skin the report just finished describing.
 *
 * UNVERIFIED. Foundation was left out of the corrected render, so no picture has
 * confirmed this number the way 30 and 22 were confirmed for lip and blush. It
 * is a sane default, not a measured one. The field it rides on is confirmed
 * (see the header): it is the number that nobody has looked at.
 */
export const FOUNDATION_COVERAGE_INTENSITY = 35;

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
  const ours = entry.category as MakeupCategory;
  const category = MAKEUP_EFFECT_CATEGORY[ours] ?? null;
  if (category === null) {
    return null;
  }
  const color = providerHex(entry.shadeHex);
  const colorIntensity = intensityFor(ours);

  if (category === "foundation") {
    return {
      category,
      palettes: [
        {
          color,
          colorIntensity,
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
      palettes: [{ color, texture: MAKEUP_TEXTURE, colorIntensity }],
    };
  }

  // blush and eye_shadow, which both select their shape with a pattern.
  return {
    category,
    pattern: { name: MAKEUP_ONE_COLOR_PATTERN },
    palettes: [{ color, texture: MAKEUP_TEXTURE, colorIntensity }],
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
