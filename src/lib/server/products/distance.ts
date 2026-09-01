import "server-only";

import { copy, fill } from "@/lib/shared/copy";

import type { NearbyPlace } from "../providers/serpapi";
import type { ApproxLocation } from "./cache-policy";

/**
 * Local availability: the distance line on a product card.
 *
 * docs/04-integrations.md: nearby stores carrying a category "when the person
 * has allowed location. We show distance computed from the person's approximate
 * location." docs/01-user-flow.md section F item 6 puts that distance on the
 * product card, and only when it is known.
 *
 * The honest rule this file exists to enforce: a distance is shown only when the
 * store the listing actually came from was found near the person. We never
 * attach the distance of some other shop to a listing, and we never show a
 * distance for an online only listing.
 *
 * Pure. The only string it produces comes from copy.ts.
 */

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great circle distance in kilometres between two coordinates. */
export function haversineKm(
  from: { readonly lat: number; readonly lng: number },
  to: { readonly lat: number; readonly lng: number },
): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The distance line, one decimal place. The person's location is only accurate
 * to two decimal degrees (roughly a kilometre), so a second decimal here would
 * claim a precision we do not have. Anything under 0.1 km reads as 0.1 rather
 * than 0, because "0 km away" reads as a bug.
 */
export function formatDistanceKm(km: number): string {
  const shown = Math.max(0.1, Math.round(km * 10) / 10);
  return fill(copy.productCard.distanceTemplate, { distance: shown.toFixed(1) });
}

/**
 * Store names are compared on letters and digits only, so "Nykaa Luxe" and
 * "nykaa-luxe" are the same shop and punctuation cannot break a match.
 */
function normalizeStoreName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Shortest normalized name we will match on. Below this, matches are noise. */
const MIN_STORE_MATCH_LENGTH = 4;

/**
 * The nearby place that is the same shop as the listing's store, or null.
 *
 * Containment in either direction, because a Google Shopping source is usually
 * the brand ("Nykaa") while a Maps title is usually the branch ("Nykaa Luxe,
 * Indiranagar"). Both sides must be at least four characters, so a two letter
 * store name cannot match half the high street.
 */
export function matchStoreToPlace(
  store: string | null,
  places: readonly NearbyPlace[],
): NearbyPlace | null {
  if (store === null) {
    return null;
  }
  const needle = normalizeStoreName(store);
  if (needle.length < MIN_STORE_MATCH_LENGTH) {
    return null;
  }
  for (const place of places) {
    const candidate = normalizeStoreName(place.title);
    if (candidate.length < MIN_STORE_MATCH_LENGTH) {
      continue;
    }
    if (candidate.includes(needle) || needle.includes(candidate)) {
      return place;
    }
  }
  return null;
}

/**
 * The distance text for one listing, or null when we do not know it: no
 * location, no matching nearby store, or a place the provider returned without
 * coordinates.
 */
export function distanceTextForStore(args: {
  readonly store: string | null;
  readonly places: readonly NearbyPlace[];
  readonly location: ApproxLocation | null;
}): string | null {
  if (args.location === null || args.places.length === 0) {
    return null;
  }
  const place = matchStoreToPlace(args.store, args.places);
  if (place === null || place.latitude === null || place.longitude === null) {
    return null;
  }
  return formatDistanceKm(
    haversineKm(
      { lat: args.location.lat, lng: args.location.lng },
      { lat: place.latitude, lng: place.longitude },
    ),
  );
}
