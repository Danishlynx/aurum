import "server-only";

import { z } from "zod";

import type { LookItem } from "@/lib/shared/looks-view";
import type { ReportListing } from "@/lib/shared/report-view";

import type { Json } from "../db/types";
import { cachedListingSchema } from "../products/schemas";

/**
 * What the looks.garments column holds, and how a stored look becomes items
 * again.
 *
 * Migration 0003 states the shape: "Ordered array of members: either
 * { garment_id } for an owned piece or a normalized listing for a gap." The
 * column is jsonb because the two shapes are this layer's decision, so this
 * file is where that decision is written down and validated.
 *
 * A stored row is JSON written by an earlier request, which makes it external
 * input in every sense that matters (CLAUDE.md, "Validate every external input
 * with zod"). A member that does not parse is dropped rather than rendered: a
 * saved look with one unreadable member is still a look, and a screen must
 * never be handed a piece whose shape nobody checked.
 *
 * distanceText is deliberately not stored. It is computed for the person who is
 * looking, from a nearby store lookup made minutes ago; keeping it on the row
 * would put a stale "2 km away" under a listing months later. A saved look
 * reads back with distanceText null, which is the "Online listing" state.
 */

const typeField = z.string().min(1).max(48).nullable().catch(null);

/** A piece the person owns. type is a copy of the garment type at save time. */
export const storedLookGarmentSchema = z.object({
  garment_id: z.string().min(1).max(64),
  type: typeField.optional(),
});

/** A piece that came from a listing, in the normalized listing shape. */
export const storedLookListingSchema = cachedListingSchema.extend({
  type: typeField.optional(),
});

export const storedLookMemberSchema = z.union([
  storedLookGarmentSchema,
  storedLookListingSchema,
]);

export const storedLookGarmentsSchema = z.array(z.unknown());

export type StoredLookGarment = z.infer<typeof storedLookGarmentSchema>;
export type StoredLookListing = z.infer<typeof storedLookListingSchema>;
export type StoredLookMember = z.infer<typeof storedLookMemberSchema>;

/** The word a stored member carries, or the empty string when it lost one. */
function typeOf(member: { type?: string | null }): string {
  return member.type ?? "";
}

/** One look item as it is written to the column. */
export function toStoredMember(item: LookItem): StoredLookMember {
  if (item.source === "garment") {
    return { garment_id: item.garmentId, type: item.type };
  }
  const listing = item.listing;
  return {
    title: listing.title,
    priceText: listing.priceText,
    priceValue: listing.priceValue,
    currency: listing.currency,
    url: listing.url,
    imageUrl: listing.imageUrl,
    store: listing.store,
    type: item.type,
  };
}

export function toStoredGarments(items: readonly LookItem[]): Json {
  return items.map(toStoredMember) as unknown as Json;
}

/**
 * The members of a stored look, in order, with anything unreadable dropped.
 * Never throws: a column written by an older deploy is a thing to read what we
 * can from, not a reason for /looks to fail.
 */
export function readStoredMembers(value: Json | null): StoredLookMember[] {
  if (value === null) {
    return [];
  }
  const array = storedLookGarmentsSchema.safeParse(value);
  if (!array.success) {
    return [];
  }
  const members: StoredLookMember[] = [];
  for (const entry of array.data) {
    const parsed = storedLookMemberSchema.safeParse(entry);
    if (parsed.success) {
      members.push(parsed.data);
    }
  }
  return members;
}

export function isStoredGarmentMember(
  member: StoredLookMember,
): member is StoredLookGarment {
  return "garment_id" in member;
}

/** A stored listing member as the screen reads it. Distance is not stored. */
export function toReportListing(member: StoredLookListing): ReportListing {
  return {
    title: member.title,
    priceText: member.priceText,
    priceValue: member.priceValue,
    currency: member.currency,
    url: member.url,
    imageUrl: member.imageUrl,
    store: member.store,
    distanceText: null,
  };
}

/**
 * The identity of a look, as a string.
 *
 * Two looks are the same look when they hold the same pieces in the same order.
 * It is what lets a rebuilt composition find the row it wrote last time instead
 * of inserting a second one, and it is computed from the members rather than
 * stored, so no column can drift away from the pieces it describes.
 */
export function lookKeyOfMembers(members: readonly StoredLookMember[]): string {
  return members
    .map((member) =>
      isStoredGarmentMember(member)
        ? `g:${member.garment_id}`
        : `l:${typeOf(member)}:${member.url}`,
    )
    .join("|");
}

export function lookKeyOfItems(items: readonly LookItem[]): string {
  return lookKeyOfMembers(items.map(toStoredMember));
}
