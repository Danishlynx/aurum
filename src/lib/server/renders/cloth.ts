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
 * UNVERIFIED, and recorded rather than guessed away: the exact spelling of the
 * category values. The reference page lists them in prose as "full_body, upper
 * body, and lower body", which reads as one snake case token and two written
 * with spaces. The tokens below are the snake case forms, which is what every
 * other field on this API uses, and the cost of the call is not published
 * either (the credit table says TBD, so the credits layer reserves one unit).
 *
 * TODO for the human: run one cloth try on from the API playground, record the
 * accepted garment_category values and the real unit cost in endpoints.ts and
 * in the credit table in docs/04-integrations.md, and correct the map below if
 * it differs. Nothing else has to change.
 */

/** The garment categories cloth-v4 accepts, as the reference page lists them. */
export const CLOTH_GARMENT_CATEGORIES = [
  "full_body",
  "upper_body",
  "lower_body",
] as const;

export type ClothGarmentCategory = (typeof CLOTH_GARMENT_CATEGORIES)[number];

/**
 * Where a garment sits, and which category it is sent as.
 *
 * A dress is the full body. A top and a layer are the upper body: a blazer is
 * worn over a shirt, and both are the piece a person sees from across a room,
 * which is why the hero is always one of these three
 * (src/lib/shared/looks.ts, HERO_SLOT_PREFERENCE). Bottoms and shoes have a
 * category too, so a later layer that renders them does not have to invent one.
 *
 * An accessory has no cloth category: accessory try on is its own set of
 * endpoints (docs/04-integrations.md, Layer 6), so it returns null here rather
 * than being sent to the cloth model as clothing.
 */
export const CLOTH_CATEGORY_OF_SLOT: Readonly<
  Record<GarmentSlot, ClothGarmentCategory | null>
> = {
  dress: "full_body",
  top: "upper_body",
  outerwear: "upper_body",
  bottom: "lower_body",
  shoes: "lower_body",
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
