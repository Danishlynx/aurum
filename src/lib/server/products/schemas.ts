import "server-only";

import { z } from "zod";

/**
 * zod at the two boundaries this layer owns: what the profile layer hands it,
 * and what comes back out of the product_cache table.
 *
 * A cached row is JSON written by an earlier deploy, so it is external input in
 * every sense that matters. It is parsed, not trusted (CLAUDE.md, "Validate
 * every external input with zod").
 *
 * The provider wire format is not validated here. That belongs to
 * src/lib/server/providers/serpapi/schemas.ts and stays there.
 */

/** An http or https URL. A listing URL ends up in an anchor, so nothing else. */
const httpUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Expected an http or https URL.");

/**
 * One routine step, as much of it as this layer reads. The synthesis layer
 * produces product_query (docs/04-integrations.md, synthesis output schema);
 * everything else on the step is none of grounding's business.
 */
export const routineStepInputSchema = z.object({
  productQuery: z.string().min(1).max(300),
});

export const approxLocationSchema = z.object({
  city: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * gl and hl are two letter market and language codes (docs/04-integrations.md,
 * "Location comes from the profile's approximate location (city level) with gl
 * and hl set from the person's locale").
 */
const marketCode = z
  .string()
  .min(2)
  .max(8)
  .regex(/^[a-zA-Z-]+$/u, "Expected a market or language code.");

/**
 * The store category the local lookup asks for. The four the provider module
 * accepts (src/lib/server/providers/serpapi/index.ts, LOCAL_CATEGORIES), never
 * free text: docs/04-integrations.md names the categories and the provider
 * refuses anything else.
 */
const storeCategory = z.enum([
  "pharmacy",
  "beauty store",
  "menswear",
  "womenswear",
  "clothing store",
]);

export const groundingOptionsSchema = z.object({
  location: approxLocationSchema.nullable(),
  gl: marketCode,
  hl: marketCode,
  ownerType: z.enum(["user", "judge_session"]),
  ownerId: z.string().min(1).max(64),
  /**
   * Which kind of shop the nearby lookup asks for. Absent means the routine's
   * pharmacy, which is what Layer 1 grounds (see ROUTINE_STORE_CATEGORY).
   */
  storeCategory: storeCategory.optional(),
});

export type GroundingOptions = z.infer<typeof groundingOptionsSchema>;

/**
 * A normalized listing as product_cache.results stores it, which is the shape
 * the SerpApi provider module's toListing produces:
 * { title, priceText, priceValue, currency, url, imageUrl, store }.
 *
 * priceText and url are required. That pair is the grounding rule from
 * docs/06-safety-privacy.md in one schema: no URL or no price, no product.
 * priceValue is nullable because it only exists for sorting; the price a person
 * reads is priceText, exactly as the provider returned it.
 */
export const cachedListingSchema = z.object({
  title: z.string().min(1).max(300),
  priceText: z.string().min(1).max(64),
  priceValue: z.number().nullable(),
  currency: z.string().min(1).max(8).nullable(),
  url: httpUrl,
  imageUrl: z.string().min(1).max(2048).nullable(),
  store: z.string().min(1).max(120).nullable(),
});

export const cachedListingsSchema = z.array(cachedListingSchema);

export type CachedListing = z.infer<typeof cachedListingSchema>;

/** A nearby place as product_cache.results stores it for the local engines. */
export const cachedPlaceSchema = z.object({
  title: z.string().min(1).max(200),
  address: z.string().min(1).max(400).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  placeId: z.string().min(1).max(200).nullable(),
  url: z.string().min(1).max(2048).nullable(),
  category: z.string().min(1).max(120).nullable(),
});

export const cachedPlacesSchema = z.array(cachedPlaceSchema);

export type CachedPlace = z.infer<typeof cachedPlaceSchema>;
