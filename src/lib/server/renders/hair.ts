import "server-only";

import { isHairStyleId, type HairStyleId } from "@/lib/shared/hair-rules";

import { getEndpoint } from "../providers/perfectcorp";
import type { StoredHairColorParams, StoredHairstyleParams } from "./params";

/**
 * The hairstyle and hair colour try on request bodies.
 *
 * The provider module owns the envelope, the task creation, and the polling.
 * This file owns the two things left: which style we ask for, and which colour.
 * It is the hair twin of src/lib/server/renders/makeup.ts.
 *
 * docs/04-integrations.md, "Hairstyle and hair color try on (Layer 3)", and the
 * credit table: a hairstyle render costs 2 units, a hair colour render costs 1.
 */

/* ------------------------------------------------------------------ */
/* Hairstyle                                                           */
/* ------------------------------------------------------------------ */

/**
 * The provider template id for each catalog style.
 *
 * CONFIRMED, from src/lib/server/providers/perfectcorp/endpoints.ts: the path is
 * /s2s/v2.1/task/hair-transfer (note v2.1, not v2.0), the request takes
 * src_file_id or src_file_url plus one of ref_file_id, ref_file_url, or
 * template_id, the result carries a url, and one successful call costs 2 units.
 *
 * UNVERIFIED, and this is the gap that stops a hairstyle render today: the
 * template catalog itself. The reference page records that a template_id exists;
 * it does not list the ids, and the hackathon key has not been used to read them
 * from the API playground. Every entry below is therefore null, which
 * hairstyleTemplateFor reports as "this style cannot be rendered". The render
 * layer refuses before it reserves a credit and the screen shows its documented
 * "Preview unavailable for this shade." state.
 *
 * The other way in, a reference image of the haircut, is deliberately not used:
 * a reference photo is someone else's face, and the rule in CLAUDE.md is that
 * the person only ever processes their own.
 *
 * TODO for the human: list the hair transfer templates from the API playground,
 * put the id for each cut below, and record the catalog in
 * docs/04-integrations.md next to the credit table. Nothing else has to change:
 * the moment an id is here, that style renders.
 */
export const HAIRSTYLE_TEMPLATE_ID: Readonly<
  Record<HairStyleId, string | null>
> = {
  "textured-crop": null,
  "soft-layers-collarbone": null,
  "blunt-bob-jaw": null,
  "blunt-bob-below-jaw": null,
  "chin-length-bob": null,
  "angled-bob-below-chin": null,
  "curtain-fringe": null,
  "blunt-fringe": null,
  "long-layers-shoulders": null,
  "side-parted-lob": null,
  "side-swept-layers": null,
  "soft-waves-shoulder": null,
  "volume-through-top": null,
};

/** The provider template for a style id, or null when there is none to send. */
export function hairstyleTemplateFor(styleId: string): string | null {
  if (!isHairStyleId(styleId)) {
    return null;
  }
  return HAIRSTYLE_TEMPLATE_ID[styleId];
}

/**
 * The body for one hairstyle try on. Returns null when the style has no
 * provider template, which the caller reads as "there is nothing to render".
 */
export function hairstyleTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredHairstyleParams;
}): Record<string, unknown> | null {
  const templateId = hairstyleTemplateFor(args.params.styleId);
  if (templateId === null) {
    return null;
  }
  const endpoint = getEndpoint("hairstyleTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    template_id: templateId,
  };
}

/* ------------------------------------------------------------------ */
/* Hair colour                                                         */
/* ------------------------------------------------------------------ */

/** Full head rather than ombre. Both cost 1 unit (docs/04-integrations.md). */
export const HAIR_COLOR_MODE = "full";

/** Full strength. The swatch the person picked is the colour they asked for. */
export const HAIR_COLOR_INTENSITY = 100;

/**
 * The body for one hair colour try on.
 *
 * UNVERIFIED, twice over, which is why the endpoint entry itself is marked
 * unverified and the render layer refuses to call it without
 * PERFECTCORP_ALLOW_UNVERIFIED:
 *
 *   1. the task path did not render on the reference page, so the path in
 *      endpoints.ts is a placeholder,
 *   2. the request fields that carry the colour are not confirmed. The shape
 *      below follows the makeup try on payload, which is the closest confirmed
 *      neighbour, with the full versus ombre mode the reference page does
 *      confirm.
 *
 * Nothing has ever been rendered from it. What is confirmed is only the price,
 * 1 unit per render for both modes.
 *
 * TODO for the human: run one hair colour try on from the API playground, record
 * the path and the colour payload in endpoints.ts, mark the entry confirmed, and
 * correct this body if it differs.
 */
export function hairColorTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredHairColorParams;
}): Record<string, unknown> | null {
  const endpoint = getEndpoint("hairColorTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    mode: HAIR_COLOR_MODE,
    palettes: [
      {
        colors: [
          { color: args.params.colorHex, intensity: HAIR_COLOR_INTENSITY },
        ],
      },
    ],
  };
}
