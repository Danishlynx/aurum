import "server-only";

import { slotOfType, type GarmentSlot } from "@/lib/shared/looks";

import { getEndpoint } from "../providers/perfectcorp";
import type { StoredClothParams } from "./params";

/**
 * The cloth try on request body: the person's own capture, one garment of
 * theirs, one garment category.
 *
 * The provider module owns the envelope, the task creation, and the polling.
 * This file owns the two things left: which category the garment is sent as,
 * and how the garment photo is attached. It is the Layer 4 twin of
 * src/lib/server/renders/hair.ts.
 *
 * CONFIRMED, from src/lib/server/providers/perfectcorp/endpoints.ts: the path
 * is /s2s/v2.0/task/cloth-v4, the request takes src_file_id or src_file_url
 * plus ref_file_id, ref_file_url, or template_id, the result carries a url, and
 * one garment_category goes per call. That last fact is the one that shapes the
 * whole layer: a Look renders as the hero garment alone and the rest of the
 * outfit is a flat lay, which is the fallback docs/09-build-order-and-demo.md
 * names for Layer 4.
 *
 * CONFIRMED on 2026-09-02, where the category values used to be a guess: the
 * reference page lists them in prose as "full_body, upper body, and lower body",
 * and the snake case tokens below were inferred from that. The whole enum is now
 * known, from the OpenAPI bundle behind that page and from the live API itself:
 * full_body, lower_body, upper_body, shoes, auto, outer. It cost nothing to
 * settle, with the oracle the makeup body was corrected with: a task creation
 * that is rejected is free, and a src_file_id the file service cannot resolve is
 * always rejected. Every one of the six passes; "torso" answers 400 with
 * "garment_category is not one of the accepted values.", so the value really is
 * read and checked when the task is created rather than at render time.
 *
 * Two of the six were news, and both are used below: there is a dedicated
 * "shoes" category, and a dedicated "outer" for a layer worn over something.
 *
 * The request also takes an optional change_shoes boolean, which defaults to
 * true and only has an effect on full_body and lower_body. It is deliberately
 * not sent: it decides whether shoes are swapped when the reference image is a
 * full body photo that happens to include them, and our reference is a photo of
 * one garment.
 *
 * Still unpublished: the cost of a V4.0 call. The consumption table lists 2
 * units for V2.0 and V3.0 and omits V4.0, so the credit table still says TBD and
 * the credits layer reserves the unknown cost fallback of one unit.
 */

/**
 * The garment categories cloth-v4 accepts.
 *
 * The full enum, in the order the request schema lists it. "auto" is real and
 * deliberately unused: the category is what decides whether a photo lands as a
 * shirt or as trousers, and we already know which it is from the type the person
 * or the classifier recorded. Asking the engine to guess again would be handing
 * back the one thing we are sure of.
 */
export const CLOTH_GARMENT_CATEGORIES = [
  "full_body",
  "lower_body",
  "upper_body",
  "shoes",
  "auto",
  "outer",
] as const;

export type ClothGarmentCategory = (typeof CLOTH_GARMENT_CATEGORIES)[number];

/**
 * Where a garment sits, and which category it is sent as.
 *
 * A dress is the full body. A top is the upper body. A layer is "outer", which
 * is the category the enum keeps for a piece worn over another: a blazer is worn
 * over a shirt, and sending it as an upper body garment asks the engine to put
 * it in the shirt's place instead of over it. Both are still the piece a person
 * sees from across a room, which is why the hero is one of these three
 * (src/lib/shared/looks.ts, HERO_SLOT_PREFERENCE).
 *
 * Shoes have their own category too. They used to be sent as lower_body, which
 * would have asked the engine to wear a photo of a shoe where the trousers are.
 * Nobody had run one, so nobody had seen it happen.
 *
 * An accessory has no cloth category: accessory try on is its own set of
 * endpoints (docs/04-integrations.md, Layer 6), so it returns null here rather
 * than being sent to the cloth model as clothing.
 *
 * Which category each slot maps to is a curation call, not a fact the provider
 * states. What is confirmed is only that all of these values are accepted. What
 * a given one renders as is unwatched.
 */
export const CLOTH_CATEGORY_OF_SLOT: Readonly<
  Record<GarmentSlot, ClothGarmentCategory | null>
> = {
  dress: "full_body",
  top: "upper_body",
  outerwear: "outer",
  bottom: "lower_body",
  shoes: "shoes",
  accessory: null,
};

/**
 * The category for a stored garment type, or null when there is nothing to
 * send. Null is a refusal, not a default: a garment nobody has classified has
 * no slot, and guessing "upper body" for it would put an unread photo in front
 * of the model as a shirt.
 */
export function clothCategoryForType(
  type: string | null,
): ClothGarmentCategory | null {
  const slot = slotOfType(type);
  if (slot === null) {
    return null;
  }
  return CLOTH_CATEGORY_OF_SLOT[slot];
}

/**
 * The body for one cloth try on.
 *
 * Two files: the person's capture as the source, and their own garment photo as
 * the reference. The reference is never a stock image and never someone else's
 * photo, which is the rule in CLAUDE.md: the person only ever processes their
 * own face and their own clothes.
 */
export function clothTaskBody(args: {
  readonly fileId: string;
  readonly referenceFileId: string;
  readonly params: StoredClothParams;
}): Record<string, unknown> | null {
  const endpoint = getEndpoint("clothTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    ref_file_id: args.referenceFileId,
    garment_category: args.params.garmentCategory,
  };
}
