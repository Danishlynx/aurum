import "server-only";

/**
 * The SerpApi surface we use, with the verification state of each engine.
 * Spec: docs/04-integrations.md (SerpApi).
 */

export const SERPAPI_BASE_URL = "https://serpapi.com/search";

export const SERPAPI_HTTP_TIMEOUT_MS = 15_000;

export type VerificationState = "confirmed" | "unverified";

export interface Verification {
  readonly state: VerificationState;
  readonly source: string;
  readonly checkedOn: string;
  readonly note: string;
}

export const SERPAPI_ENGINE_KEYS = ["shopping", "maps", "local"] as const;
export type SerpApiEngineKey = (typeof SERPAPI_ENGINE_KEYS)[number];

export interface SerpApiEngine {
  readonly key: SerpApiEngineKey;
  /** The value of the engine query parameter. */
  readonly engine: string;
  /** Request parameter names we send. */
  readonly requestParams: readonly string[];
  /** The array in the response body that holds the results. */
  readonly resultsField: string;
  /** Result fields we read. */
  readonly resultFields: readonly string[];
  /** How long a cached response stays usable, per docs/03-architecture.md. */
  readonly cacheTtlMs: number;
  readonly verification: Verification;
}

const CHECKED_ON = "2026-09-01";
const HOURS = 60 * 60 * 1000;

export const SERPAPI_ENGINES: Readonly<Record<SerpApiEngineKey, SerpApiEngine>> = {
  shopping: {
    key: "shopping",
    engine: "google_shopping",
    requestParams: ["engine", "q", "gl", "hl", "location", "google_domain", "num", "api_key"],
    resultsField: "shopping_results",
    resultFields: [
      "position",
      "title",
      "product_link",
      "source",
      "price",
      "extracted_price",
      "thumbnail",
      "serpapi_thumbnail",
      "rating",
      "reviews",
      "delivery",
      "product_id",
    ],
    cacheTtlMs: 24 * HOURS,
    verification: {
      state: "confirmed",
      source: "https://serpapi.com/google-shopping-api",
      checkedOn: CHECKED_ON,
      note:
        "shopping_results carries product_link, not link. The reference response has no currency " +
        "field, so the currency is read off the price string and stays null when it cannot be read. " +
        "Prices are shown exactly as returned and are never converted.",
    },
  },
  maps: {
    key: "maps",
    engine: "google_maps",
    requestParams: ["engine", "q", "ll", "type", "gl", "hl", "api_key"],
    resultsField: "local_results",
    resultFields: [
      "title",
      "place_id",
      "address",
      "gps_coordinates",
      "rating",
      "reviews",
      "type",
      "phone",
      "website",
      "thumbnail",
    ],
    cacheTtlMs: 6 * HOURS,
    verification: {
      state: "confirmed",
      source: "https://serpapi.com/google-maps-api",
      checkedOn: CHECKED_ON,
      note:
        "The ll parameter takes the form @latitude,longitude,zoom. type is search or place. " +
        "local_results is the array returned for type=search.",
    },
  },
  local: {
    key: "local",
    engine: "google_local",
    requestParams: ["engine", "q", "location", "google_domain", "gl", "hl", "api_key"],
    resultsField: "local_results",
    resultFields: [
      "title",
      "place_id",
      "address",
      "gps_coordinates",
      "rating",
      "reviews",
      "type",
      "thumbnail",
      "provider_id",
    ],
    cacheTtlMs: 6 * HOURS,
    verification: {
      state: "confirmed",
      source: "https://serpapi.com/google-local-api",
      checkedOn: CHECKED_ON,
      note:
        "q and api_key are required. The documented local_results entries carry no website or " +
        "links field, so a place URL is not always available and stays null.",
    },
  },
};

/**
 * Plan quota and rate limits could not be read: https://serpapi.com/pricing
 * needs the account dashboard. The daily caps in the credit ledger
 * (DAILY_CAP_SERPAPI_SEARCHES) are what this build enforces.
 */
export const SERPAPI_QUOTA_NOTE =
  "Plan quota and rate limits are read from the SerpApi dashboard, which needs the account owner. " +
  "This build enforces DAILY_CAP_SERPAPI_SEARCHES in the credit ledger instead.";
