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
 * CONFIRMED on 2026-09-02, for the watch: the path is /s2s/v2.0/task/2d-vto/watch
 * and one single item simulation costs 1 unit, and the request needs four things
 * rather than the two this file used to send. The body it sent before,
 * { src_file_id, ref_file_ids }, is refused:
 *
 *   "source_info is required but wasn't included in your request., or
 *    object_infos is required but wasn't included in your request."
 *
 * So the watch try on, the one accessory this build offers, would have failed on
 * every tap. Adding source_info and object_infos answers the generic "One or
 * more parameters in this request are invalid.", which is what a right body with
 * a wrong file id says. Free, with the oracle the makeup body was corrected with
 * (src/lib/server/renders/makeup.ts): a rejected task creation costs nothing.
 *
 * The earrings endpoint takes the same four fields, at a corrected path
 * (2d-vto/earring, singular). It stays gated because its unit cost is published
 * nowhere we can read.
 *
 * The bag endpoint is not this API at all: it is /s2s/v2.0/task/bag, it takes a
 * single ref_file_id rather than a list, and it requires a gender field this app
 * does not hold and does not ask anyone for. It stays gated, and the body
 * builder below sends nothing for it rather than sending the 2d-vto shape.
 *
 * That is what the map below is for: a category is callable when the endpoint
 * behind it is confirmed (or when PERFECTCORP_ALLOW_UNVERIFIED is set), so
 * whichever endpoint the human verifies first is the one the screen offers, and
 * the rest stay refused rather than guessed at.
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
 * The categories whose endpoint takes the 2d-vto request shape.
 *
 * The watch confirms that shape and the earrings share it. The bag does not: its
 * endpoint is a different API with a different body and a required gender field,
 * so it is left out here rather than served the wrong one.
 */
const TWO_D_VTO_CATEGORIES: ReadonlySet<AccessoryCategory> =
  new Set<AccessoryCategory>(["watch", "earrings"]);

/**
 * The body for one accessory try on.
 *
 * Two files: the person's capture as the source, and their own photo of the
 * accessory as the reference. The reference is never a stock image, never a
 * listing thumbnail, and never someone else's photo, which is the rule in
 * CLAUDE.md and the same rule the cloth try on follows.
 *
 * Four fields, all four required, all four named by the server itself in a free
 * rejection. The reference field is plural (ref_file_ids) and one item is sent
 * in it: one accessory, one picture. source_info and object_infos repeat those
 * same ids under a name, which is how the engine pairs a source with its mask
 * and a product with its mask; we send no masks, so each entry carries only the
 * name it points at.
 *
 * Null for a category whose endpoint is not this API, which today is the bag.
 * The caller reads null as "there is nothing to render" and refuses before a
 * credit is reserved.
 */
export function accessoryTaskBody(args: {
  readonly fileId: string;
  readonly referenceFileId: string;
  readonly params: StoredAccessoryParams;
}): Record<string, unknown> | null {
  if (!isAccessoryCategory(args.params.category)) {
    return null;
  }
  if (!TWO_D_VTO_CATEGORIES.has(args.params.category)) {
    return null;
  }
  const endpoint = getEndpoint(accessoryEndpointFor(args.params.category));
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    ref_file_ids: [args.referenceFileId],
    source_info: { name: args.fileId },
    object_infos: [{ name: args.referenceFileId }],
  };
}
