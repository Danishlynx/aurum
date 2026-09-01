import "server-only";

import {
  ACCESSORY_CATEGORIES,
  type AccessoryCategory,
} from "@/lib/shared/color-view";
import { slotOfType } from "@/lib/shared/looks";

import { getEndpoint, type PerfectCorpEndpointKey } from "../providers/perfectcorp";
import type { StoredAccessoryParams } from "./params";

/**
 * The accessory try on request body: the person's own capture, one accessory of
 * theirs, one category.
 *
 * The provider module owns the envelope, the task creation, and the polling.
 * This file owns the two things left: which endpoint a category goes to, and how
 * the accessory photo is attached. It is the Layer 6 twin of
 * src/lib/server/renders/cloth.ts.
 *
 * docs/09-build-order-and-demo.md, Layer 6: "One accessory try on in the top
 * look (earrings or a bag) from the fashion APIs".
 *
 * CONFIRMED, from src/lib/server/providers/perfectcorp/endpoints.ts, for the
 * watch and the watch alone: the path is /s2s/v2.0/task/2d-vto/watch, the
 * request takes src_file_id or src_file_url plus ref_file_ids or ref_file_urls,
 * and one single item simulation costs 1 unit.
 *
 * UNVERIFIED: every other accessory page. Their paths follow the same 2d-vto
 * pattern, which is why endpoints.ts records them, but no reference page was
 * read for them and their unit costs are not published. So the two categories
 * docs/09 names, earrings and bag, are gated today and the watch is not.
 *
 * That is what the map below is for: a category is callable when the endpoint
 * behind it is confirmed (or when PERFECTCORP_ALLOW_UNVERIFIED is set), so
 * whichever endpoint the human verifies first is the one the screen offers, and
 * the rest stay refused rather than guessed at.
 *
 * TODO for the human: read the earrings and bag reference pages, record their
 * paths, reference file fields, and unit costs in endpoints.ts, and mark those
 * entries confirmed. Nothing else has to change.
 */

/** The endpoint behind each accessory category. */
export const ENDPOINT_FOR_ACCESSORY_CATEGORY: Readonly<
  Record<AccessoryCategory, PerfectCorpEndpointKey>
> = {
  earrings: "earringsTryOn",
  bag: "bagTryOn",
  watch: "watchTryOn",
};

export function accessoryEndpointFor(
  category: AccessoryCategory,
): PerfectCorpEndpointKey {
  return ENDPOINT_FOR_ACCESSORY_CATEGORY[category];
}

const ACCESSORY_CATEGORY_SET: ReadonlySet<string> = new Set<string>(
  ACCESSORY_CATEGORIES,
);

/** True when a stored params value is one of the categories we send. */
export function isAccessoryCategory(value: string): value is AccessoryCategory {
  return ACCESSORY_CATEGORY_SET.has(value);
}

/**
 * The categories a caller may offer, given a test for whether an endpoint can be
 * called at all.
 *
 * The predicate is passed in rather than read here so this module stays free of
 * the environment: src/lib/server/renders/index.ts owns
 * isRenderEndpointCallable, which is the same gate the Perfect Corp client
 * applies at the call site, and importing it back here would be a cycle.
 */
export function callableAccessoryCategories(
  callable: (key: PerfectCorpEndpointKey) => boolean,
): AccessoryCategory[] {
  return ACCESSORY_CATEGORIES.filter((category) =>
    callable(accessoryEndpointFor(category)),
  );
}

/**
 * True when a stored garment type can be worn as an accessory.
 *
 * The wardrobe records every accessory under one type
 * (src/lib/shared/wardrobe-view.ts), so this says only that the photo is of an
 * accessory, never which one. Which one is the person's choice, and it arrives
 * as the category on the request.
 */
export function isAccessoryGarmentType(type: string | null): boolean {
  return slotOfType(type) === "accessory";
}

/**
 * The body for one accessory try on.
 *
 * Two files: the person's capture as the source, and their own photo of the
 * accessory as the reference. The reference is never a stock image, never a
 * listing thumbnail, and never someone else's photo, which is the rule in
 * CLAUDE.md and the same rule the cloth try on follows.
 *
 * The reference field is plural (ref_file_ids) because that is what the watch
 * page confirms, and one item is sent in it: one accessory, one picture.
 */
export function accessoryTaskBody(args: {
  readonly fileId: string;
  readonly referenceFileId: string;
  readonly params: StoredAccessoryParams;
}): Record<string, unknown> | null {
  if (!isAccessoryCategory(args.params.category)) {
    return null;
  }
  const endpoint = getEndpoint(accessoryEndpointFor(args.params.category));
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    ref_file_ids: [args.referenceFileId],
  };
}
