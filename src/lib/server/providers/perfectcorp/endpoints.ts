import "server-only";

/**
 * The verified surface of the Perfect Corp YouCam API.
 *
 * Every entry records where its facts came from and when they were checked.
 * An entry marked "unverified" is one we could not fully read from the live
 * docs. Calling it is refused unless PERFECTCORP_ALLOW_UNVERIFIED is set, so a
 * guess never turns into a credit spend or a wrong request shape.
 *
 * Spec: docs/04-integrations.md (verify first, the call pattern, credit table).
 *
 * Note on sources: https://docs.perfectcorp.com was unreachable from this
 * machine on every attempt. The same documentation is served from
 * https://docs.makeupar.com, which is the host recorded below.
 */

export const PERFECTCORP_DEFAULT_BASE_URL = "https://yce-api-01.makeupar.com";

/** Every HTTP call to the provider gets this budget. */
export const PERFECTCORP_HTTP_TIMEOUT_MS = 15_000;

/** A task that has been running longer than this is failed by the jobs layer. */
export const PERFECTCORP_TASK_TIMEOUT_MS = 120_000;

export type VerificationState = "confirmed" | "unverified";

export interface Verification {
  readonly state: VerificationState;
  /** The page the facts were read from. */
  readonly source: string;
  /** ISO date the page was read. */
  readonly checkedOn: string;
  /** What is known, and for "unverified", exactly what is still missing. */
  readonly note: string;
}

/**
 * What one successful call costs. Failed tasks cost nothing: "If the engine
 * fails to process the task, the task's status will change to 'error' and no
 * unit will be consumed."
 */
export type UnitCost =
  | { readonly kind: "fixed"; readonly units: number }
  | {
      readonly kind: "tiered";
      /** What the tier boundary counts, for example "attributes requested". */
      readonly countedBy: string;
      readonly tiers: ReadonlyArray<{ readonly upTo: number; readonly units: number }>;
    }
  | { readonly kind: "unknown"; readonly note: string };

export interface ImageConstraints {
  readonly minShortSidePx: number | null;
  readonly maxLongSidePx: number | null;
  readonly maxBytes: number;
  readonly formats: readonly string[];
  /** How much of the frame the face or subject has to fill. */
  readonly framingNote: string;
  /** How many images one call takes. */
  readonly imagesPerCall: number;
}

const TEN_MB = 10 * 1024 * 1024;

/** The five analyses that fan out from one uploaded selfie. */
export const CAPTURE_ANALYSIS_KEYS = [
  "skinAnalysis",
  "fitzpatrick",
  "facialColorTones",
  "faceAttributes",
  "hairType",
] as const;

export type CaptureAnalysisKey = (typeof CAPTURE_ANALYSIS_KEYS)[number];

/** The analyses.kind values in docs/03-architecture.md. */
export type AnalysisKind =
  | "skin"
  | "fitzpatrick"
  | "attributes"
  | "face_shape"
  | "hair_type";

export const PERFECTCORP_ENDPOINT_KEYS = [
  "skinAnalysis",
  "fitzpatrick",
  "facialColorTones",
  "faceAttributes",
  "hairType",
  "makeupTryOn",
  "hairstyleTryOn",
  "hairColorTryOn",
  "clothTryOn",
  "skinSimulation",
  "watchTryOn",
  "braceletTryOn",
  "ringTryOn",
  "earringsTryOn",
  "necklaceTryOn",
  "scarfTryOn",
  "hatTryOn",
  "shoesTryOn",
  "bagTryOn",
] as const;

export type PerfectCorpEndpointKey = (typeof PERFECTCORP_ENDPOINT_KEYS)[number];

export interface PerfectCorpEndpoint {
  readonly key: PerfectCorpEndpointKey;
  /** Path we POST to in order to create a task. */
  readonly createPath: string;
  /** Status path is this value, a slash, then the task id. */
  readonly statusPathPrefix: string;
  /** Request field names that carry the uploaded file id. */
  readonly sourceFileFields: readonly string[];
  readonly unitCost: UnitCost;
  readonly imageConstraints: ImageConstraints | null;
  readonly verification: Verification;
  /** Set for the five capture analyses, null for renders. */
  readonly analysisKind: AnalysisKind | null;
}

const MAKEUPAR = "https://docs.makeupar.com";
const CHECKED_ON = "2026-09-01";

/** The live API itself, probed with the real key. The strongest source we have. */
const LIVE_API = "live API probe against https://yce-api-01.makeupar.com";
const AUTH_CHECKED_ON = "2026-09-02";

/**
 * The OpenAPI bundle behind a reference page, for example
 * https://docs.makeupar.com/_bundle/reference/ai_hair_color.json.
 *
 * It is the same documentation the page renders from, and it carries the request
 * schemas the page itself sometimes fails to draw: the hair colour task path and
 * the hair colour colour fields, which this file called a placeholder for two
 * days, are stated outright in it. A plain GET, no task, no credit spent.
 */
const OPENAPI = `${MAKEUPAR}/_bundle/reference`;

/**
 * The day every render request body below was driven through the free oracle.
 *
 * The oracle: a task creation that is rejected costs nothing, and a src_file_id
 * the file service cannot resolve is always rejected, so a bogus file id turns
 * a create endpoint into a validator that answers for free. A wrong body answers
 * with a detailed enumeration naming the fields it wanted. A right body with a
 * wrong file id answers the generic "One or more parameters in this request are
 * invalid." The credit balance was 0 units before the probes and 0 after, so
 * every answer below was free and no task was ever created.
 */
const PROBED_ON = "2026-09-02";

/**
 * How we authenticate.
 *
 * The API console issues a key and a secret, which looks like a token exchange.
 * It is not one, at least not a required one. Both shapes were exercised against
 * the live API on 2026-09-02 and the finding is recorded here so nobody has to
 * spend an afternoon on it again:
 *
 * 1. "Authorization: Bearer <PERFECTCORP_API_KEY>" is accepted directly. A GET
 *    on /s2s/v2.0/task/skin-analysis/<made up id> answered 400 InvalidTaskId,
 *    which means the request got past auth and died on the task id. The same GET
 *    with no Authorization header answered 401 InvalidApiKey. So the key alone
 *    authenticates, and client.ts is right to send it.
 * 2. The RSA token exchange also exists and works:
 *    POST /s2s/v1.0/client/auth with { client_id, id_token }, where id_token is
 *    "client_id=<key>&timestamp=<ms since epoch>" encrypted with the secret
 *    (a base64 DER RSA 1024 bit public key, PKCS1 padding) and base64 encoded.
 *    It answers 200 with { status, result: { access_token } }, and a deliberately
 *    corrupt id_token answers 401 InvalidAuthentication, so the server really does
 *    verify it. The access token is opaque, carries no expiry field, and is
 *    accepted on exactly the same endpoints as the raw key.
 *
 * Since the exchange buys nothing and costs a round trip plus an expiry we
 * cannot see, we do not do it. PERFECTCORP_API_SECRET is unused on purpose.
 */
export const PERFECTCORP_AUTH = {
  /** What client.ts sends: the API key straight into the Authorization header. */
  scheme: "bearer_api_key",
  /** Real, works, deliberately not used. Kept so the finding is not lost. */
  tokenExchangePath: "/s2s/v1.0/client/auth",
  verification: {
    state: "confirmed",
    source: LIVE_API,
    checkedOn: AUTH_CHECKED_ON,
    note:
      "Bearer <api key> answered 400 InvalidTaskId on a bogus task id (auth passed) and 401 " +
      "InvalidApiKey with no header. The /s2s/v1.0/client/auth RSA exchange answered 200 with " +
      "result.access_token and 401 InvalidAuthentication on a corrupt id_token. Both shapes " +
      "authenticate; the key alone is enough, so the secret is not read anywhere.",
  },
} as const satisfies {
  scheme: string;
  tokenExchangePath: string;
  verification: Verification;
};

/**
 * Remaining units on the account. A plain GET, no task, no credit spent.
 * Not on the public reference pages: found by probing the live API.
 */
export const PERFECTCORP_CREDIT_ENDPOINT = {
  path: "/s2s/v1.0/client/credit",
  verification: {
    state: "confirmed",
    source: LIVE_API,
    checkedOn: AUTH_CHECKED_ON,
    note:
      "GET with the API key as a bearer token answers 200 with " +
      "{ status, results: [{ id, type, amount, amount_dec, expiry }] }. Note results, not the " +
      "{ status, data } envelope the task APIs use. type is a grant kind such as ApiPaygToken, " +
      "amount is the remaining units on that grant, and expiry is milliseconds since epoch. " +
      "The neighbouring guesses (/client/credits, /credit, /client/quota, /client/balance, and " +
      "the v2.0 equivalents) all answer 404, so this is the only spelling that exists.",
  },
} as const satisfies { path: string; verification: Verification };

/**
 * The hairstyle template list. A plain GET, no task, no credit spent.
 *
 * This is the catalog the hair transfer task selects a template_id from. It is
 * the one thing that was missing before a hairstyle could render, and reading it
 * is free: the balance was 24 units before and 24 after.
 *
 * The templates themselves are recorded in src/lib/server/renders/hair.ts, next
 * to the mapping from our style ids onto them, because which cut we call which
 * is a decision of that layer and not a fact about this API.
 */
export const PERFECTCORP_HAIR_TEMPLATE_ENDPOINT = {
  path: "/s2s/v2.1/task/template/hair-transfer",
  /** 20 is accepted. 50 and 100 both answer 400 InvalidParameters. */
  maxPageSize: 20,
  verification: {
    state: "confirmed",
    source: LIVE_API,
    checkedOn: AUTH_CHECKED_ON,
    note:
      "GET with the API key as a bearer token answers 200 with { status, data: { next_token, " +
      "templates: [{ id, thumb, title, category_name, keep_users_color }] } }. Paginate by " +
      "passing next_token back as starting_token; it is null on the last page. 116 templates in " +
      "all, 17 category_name \"Male\" and 99 \"Female\". The v2.0 spelling of the path returns the " +
      "identical list. /s2s/v2.1/hair-transfer/styles and " +
      "/s2s/v2.1/task/template/hair-transfer/styles both answer 404 NotFound, so this is the " +
      "only spelling. The sibling /s2s/v2.0/task/template/hair-color answers 200 with an empty " +
      "templates array, so hair colour is not template driven.",
  },
} as const satisfies {
  path: string;
  maxPageSize: number;
  verification: Verification;
};

/**
 * The file API. Confirmed request and response bodies, quoted on the skin
 * analysis integration guide.
 */
export const PERFECTCORP_FILE_ENDPOINT = {
  createPath: "/s2s/v2.0/file",
  verification: {
    state: "confirmed",
    source: `${MAKEUPAR}/reference/ai_skin_analysis/section/overview/integration-guide`,
    checkedOn: CHECKED_ON,
    note:
      "Request body is { files: [{ content_type, file_name, file_size }] }. Response is " +
      "{ status, data: { files: [{ content_type, file_name, file_id, requests: [{ method, url, headers }] }] } }. " +
      "The bytes go to requests[0].url with requests[0].method and the headers echoed exactly.",
  },
} as const satisfies { createPath: string; verification: Verification };

/**
 * The shape every task status GET answers with.
 *
 * Read live from the skin analysis task on 2026-09-02, which is the only task
 * API that has ever run against this account. Recorded here once, rather than
 * on every endpoint, because it is the envelope and not the payload: the
 * payload under data.results differs per API and is recorded per endpoint.
 *
 *     { status, data: { error: string|null, task_status: string, results?: ... } }
 *
 * error is present and null on success, which is the detail that cost us a
 * paid task the first time (see taskStatusResponseSchema in schemas.ts).
 * polling_interval and error_code have not been seen on the wire at all.
 *
 * UNVERIFIED for skin-tone-analysis, face-attr-analysis, makeup-vto,
 * hair-transfer and the rest: they are assumed to share this envelope because
 * they share the /s2s task pattern, and the schema is permissive enough that
 * the assumption costs nothing if one of them omits a field. Any endpoint that
 * turns out to differ gets its own note on its own row.
 */
export const PERFECTCORP_TASK_STATUS_ENVELOPE = {
  verification: {
    state: "confirmed",
    source: LIVE_API,
    checkedOn: AUTH_CHECKED_ON,
    note:
      "GET <statusPathPrefix>/<taskId> answers 200 with { status, data: { error, results, " +
      "task_status } }. error is null on success, not absent. task_status is \"success\" on the " +
      "one completed task we have read. Confirmed for skin-analysis only; assumed for the other " +
      "task APIs until one of them is run.",
  },
} as const satisfies { verification: Verification };

export const PERFECTCORP_ENDPOINTS: Readonly<
  Record<PerfectCorpEndpointKey, PerfectCorpEndpoint>
> = {
  skinAnalysis: {
    key: "skinAnalysis",
    createPath: "/s2s/v2.0/task/skin-analysis",
    statusPathPrefix: "/s2s/v2.0/task/skin-analysis",
    sourceFileFields: ["src_file_id"],
    /**
     * Measured, not published. One task with all 16 SD concern keys took the
     * balance from 40 to 24 on 2026-09-02. The public unit consumption page
     * still does not carry a figure for this API, so this row is a measurement
     * of one call and not a price list: a call asking for fewer concerns may
     * well cost less, which nobody has tested and nobody should assume.
     */
    unitCost: { kind: "fixed", units: 16 },
    imageConstraints: {
      minShortSidePx: 480,
      maxLongSidePx: 2560,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote: "Face width greater than 60 percent of image width. SD needs a short side of 480px, HD needs 1080px.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: LIVE_API,
      checkedOn: AUTH_CHECKED_ON,
      note:
        "Request body { src_file_id, dst_actions, format }. Confirmed live on 2026-09-02, one " +
        "task, all 16 SD keys: GET /s2s/v2.0/task/skin-analysis/<id> answers 200 with " +
        "{ status, data: { error: null, results: { output: [...] }, task_status: \"success\" } }. " +
        "Note error is present and null on success. Each output entry carries type, and then " +
        "either (ui_score, raw_score, mask_urls) for a concern, or (region, skin_type, mask_urls) " +
        "for skin_type which repeats per zone (whole, t_zone, u_zone), or score for \"all\" and " +
        "\"skin_age\", or mask_urls alone for \"resize_image\". ui_score is a condition score: " +
        "higher is better. Cost measured at 16 units, balance 40 to 24. SD and HD concern keys " +
        "cannot be mixed in one call.",
    },
    analysisKind: "skin",
  },

  fitzpatrick: {
    key: "fitzpatrick",
    createPath: "/s2s/v2.0/task/fitzpatrick-scale-analyzer",
    statusPathPrefix: "/s2s/v2.0/task/fitzpatrick-scale-analyzer",
    sourceFileFields: ["src_file_id"],
    unitCost: { kind: "fixed", units: 10 },
    imageConstraints: {
      minShortSidePx: 320,
      maxLongSidePx: 4096,
      maxBytes: TEN_MB,
      formats: ["image/jpeg"],
      framingNote: "Front facing, evenly lit. A face that is too small or a dim frame is rejected.",
      imagesPerCall: 1,
    },
    verification: {
      state: "unverified",
      source: `${MAKEUPAR}/reference/ai_fitzpatrick_skin_type`,
      checkedOn: CHECKED_ON,
      note:
        "Paths, image limits, and the cost of 10 units are confirmed. The result payload field " +
        "names that carry the type I to VI are not confirmed. Read them from the API playground.",
    },
    analysisKind: "fitzpatrick",
  },

  facialColorTones: {
    key: "facialColorTones",
    createPath: "/s2s/v2.0/task/skin-tone-analysis",
    statusPathPrefix: "/s2s/v2.0/task/skin-tone-analysis",
    sourceFileFields: ["src_file_id"],
    unitCost: { kind: "fixed", units: 20 },
    imageConstraints: {
      minShortSidePx: 320,
      maxLongSidePx: 4096,
      maxBytes: TEN_MB,
      formats: ["image/jpeg"],
      framingNote: "Single person, face width greater than 60 percent of image width.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: LIVE_API,
      checkedOn: AUTH_CHECKED_ON,
      note:
        "Confirmed live on 2026-09-02. The path was the last open question and a real task settled " +
        "it: POST /s2s/v2.0/task/skin-tone-analysis created a task that ran to success and measured " +
        "20 units, recorded in the golden run manifest with its task id. Result fields are " +
        "confirmed: data.results.color with skin_color, eye_color, eye_color_name, lip_color, " +
        "eyebrow_color, hair_color, hair_color_name. face_angle_strictness_level is confirmed as a " +
        "request field, and this endpoint enforces it: a head that is not square to the camera comes " +
        "back failed with error_face_angle_rightward or error_face_not_forward_facing, and an empty " +
        "frame with error_no_face. A failed task is charged nothing. The skin analyzer accepts " +
        "frames this one refuses, so a capture can lose its tone reading and keep its skin reading.",
    },
    analysisKind: "attributes",
  },

  faceAttributes: {
    key: "faceAttributes",
    createPath: "/s2s/v2.0/task/face-attr-analysis",
    statusPathPrefix: "/s2s/v2.0/task/face-attr-analysis",
    sourceFileFields: ["src_file_id"],
    unitCost: {
      kind: "tiered",
      countedBy: "attributes requested",
      tiers: [
        { upTo: 5, units: 10 },
        { upTo: 14, units: 20 },
        { upTo: 28, units: 30 },
      ],
    },
    imageConstraints: {
      minShortSidePx: null,
      maxLongSidePx: 4096,
      maxBytes: TEN_MB,
      formats: ["image/jpeg"],
      framingNote: "Single person, face width greater than 60 percent of image width.",
      imagesPerCall: 1,
    },
    verification: {
      state: "unverified",
      source: `${MAKEUPAR}/reference/ai_face_analyzer`,
      checkedOn: CHECKED_ON,
      note:
        "Attribute names (faceShape and the rest), the face shape value set, the image limits, " +
        "and the 10, 20, 30 unit tiers are confirmed. The docs render the task name as " +
        "task/face-attr-analysis without the /s2s/v2.0 prefix, and the request field that carries " +
        "the attribute list is not confirmed. Read both from the API playground.",
    },
    analysisKind: "face_shape",
  },

  hairType: {
    key: "hairType",
    createPath: "/s2s/v2.0/task/hair-type-detection",
    statusPathPrefix: "/s2s/v2.0/task/hair-type-detection",
    sourceFileFields: ["src_file_ids"],
    unitCost: { kind: "fixed", units: 2 },
    imageConstraints: {
      minShortSidePx: 320,
      maxLongSidePx: 4096,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote:
        "Three photos of the same size (front, right side, left side). Face fills 50 to 80 percent of image width.",
      imagesPerCall: 3,
    },
    verification: {
      state: "unverified",
      source: `${MAKEUPAR}/reference/ai_hair_type_detection`,
      checkedOn: CHECKED_ON,
      note:
        "Paths, the three image requirement, the result fields (mapping and term), and the cost of " +
        "2 units are confirmed. The request field name that carries the three file ids is not " +
        "confirmed. This endpoint cannot run from a single selfie, so the one selfie flow needs a " +
        "product decision before it is wired.",
    },
    analysisKind: "hair_type",
  },

  makeupTryOn: {
    key: "makeupTryOn",
    createPath: "/s2s/v2.0/task/makeup-vto",
    statusPathPrefix: "/s2s/v2.0/task/makeup-vto",
    sourceFileFields: ["src_file_id", "src_file_url"],
    unitCost: { kind: "fixed", units: 1 },
    imageConstraints: {
      minShortSidePx: null,
      maxLongSidePx: 1920,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote: "Face fully visible and front facing, face width at least 100px, head tilt within 10 degrees.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: `${MAKEUPAR}/reference/makeup_vto/section/overview/integration-guide and ${LIVE_API}`,
      checkedOn: AUTH_CHECKED_ON,
      note:
        "Request body { src_file_url or src_file_id, effects: [...], version: \"1.0\" }. Both source " +
        "fields are real: src_file_url with an unreachable host creates a task (which then errors " +
        "and is refunded), and src_file_id with a real uploaded id gets past the source check. " +
        "Categories include foundation, blush, lip_color, eye_shadow, eye_liner, eyebrows, " +
        "highlighter, bronzer, concealer, contour, eyelashes, lip_liner, skin_smooth. One effect is " +
        "{ category, then a shape selector, then palettes: [{ color, texture, colorIntensity }] }, " +
        "where palettes is a FLAT list of colours and the strength field is colorIntensity. The " +
        "shape selector is pattern: { name } for blush and eye_shadow (name from the catalogs at " +
        "plugins-media.makeupar.com/wcm-saas/patterns/<blush|eyeshadow>.json, whose colorNum sets " +
        "how many palette entries are required), and shape: { name } plus style: { type } for " +
        "lip_color. foundation needs no selector but its palette entry needs color, colorIntensity, " +
        "coverageIntensity, and glowIntensity. All of this was driven out for free: a src_file_id " +
        "the file service cannot resolve is always rejected, and the 400 body distinguishes a wrong " +
        "effects array (a detailed \"... is required but wasn't included\" enumeration) from a right " +
        "one (\"One or more parameters in this request are invalid.\"). Result is data.results.url. " +
        "Cost is 1 unit per successful call, reserved at creation and refunded if the engine errors. " +
        "Checked again on 2026-09-02 against the OpenAPI bundle and the same oracle, because only " +
        "lip_color and blush had ever run: the foundation body this app sends passes, and dropping " +
        "coverageIntensity from it answers \"coverageIntensity is required but wasn't included in " +
        "your request.\", so all four of its palette fields are real and required; the eye_shadow " +
        "body passes; and all four rows in one task pass together. One warning worth keeping: an " +
        "invented pattern name passes creation, so a wrong pattern is not caught here and only " +
        "shows up as a failed task later. The names this app sends come from the live catalogs.",
    },
    analysisKind: null,
  },

  hairstyleTryOn: {
    key: "hairstyleTryOn",
    createPath: "/s2s/v2.1/task/hair-transfer",
    statusPathPrefix: "/s2s/v2.1/task/hair-transfer",
    sourceFileFields: ["src_file_id", "src_file_url"],
    unitCost: { kind: "fixed", units: 2 },
    imageConstraints: {
      minShortSidePx: null,
      maxLongSidePx: 1024,
      maxBytes: TEN_MB,
      formats: ["image/jpeg"],
      framingNote:
        "Single face, full face visible, face width at least 128px, pitch within 10 degrees, yaw within 45 degrees, roll within 15 degrees.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: `${MAKEUPAR}/reference/ai_hairstyle and ${LIVE_API}`,
      checkedOn: AUTH_CHECKED_ON,
      note:
        "Note the v2.1 path, not v2.0. Request takes src_file_id or src_file_url plus one of " +
        "ref_file_id, ref_file_url, or template_id, and the server names all four itself: a body " +
        "with no source answers 400 InvalidParameters listing ref_file_url, src_file_url, " +
        "ref_file_id, and src_file_id, and a body with a source but no reference lists the other " +
        "three plus template_id. An invented template answers 400 InvalidTemplate, \"This template " +
        "ID doesn't exist.\", so template_id is looked up server side and the catalog ids resolve. " +
        "Both facts came from free rejections. Result carries a url. Cost is 2 units whether a " +
        "template or a reference image is used. The template ids come from " +
        "PERFECTCORP_HAIR_TEMPLATE_ENDPOINT, read live on 2026-09-02 and recorded in " +
        "src/lib/server/renders/hair.ts. Still unwatched: whether a template renders as the cut " +
        "its title names, which only looking at a render settles.",
    },
    analysisKind: null,
  },

  hairColorTryOn: {
    key: "hairColorTryOn",
    createPath: "/s2s/v2.0/task/hair-color",
    statusPathPrefix: "/s2s/v2.0/task/hair-color",
    sourceFileFields: ["src_file_id", "src_file_url"],
    unitCost: { kind: "fixed", units: 1 },
    imageConstraints: {
      minShortSidePx: 320,
      maxLongSidePx: 1920,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote: "Face width at least 100px. The hair to be coloured has to be visible in the frame.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: `${OPENAPI}/ai_hair_color.json and ${LIVE_API}`,
      checkedOn: PROBED_ON,
      note:
        "The path is /s2s/v2.0/task/hair-color. The reference page never rendered it, which is " +
        "why this row sat unverified with a placeholder; the OpenAPI bundle behind that page " +
        "states it outright, and the live API agrees (a body with no source answers 400 naming " +
        "src_file_url and src_file_id, so the path exists and reads a source). Request body is " +
        "{ src_file_id or src_file_url, then either preset, or pattern plus palettes }. pattern " +
        "is { name: \"full\" or \"ombre\" }, with blend_strength, line_offset, and " +
        "coloring_section required for ombre. palettes is a flat list, one entry for full mode " +
        "and two for ombre, each { color: \"#RRGGBB\", color_intensity 0 to 100, shine_intensity " +
        "0 to 100 }. The snake case is the point: this endpoint does not spell it colorIntensity " +
        "the way makeup-vto does. Driven out for free with an unresolvable src_file_id: the body " +
        "this app used to send ({ mode, palettes: [{ color, colorIntensity }] }) answers " +
        "\"'pattern' is required and can't be null.\"; a camel case colorIntensity of 500 passes " +
        "validation, so that field was being ignored; a snake case color_intensity of 500 answers " +
        "\"color_intensity is above the allowed maximum.\"; an invented pattern name answers " +
        "\"name is not one of the accepted values.\"; a colour without its leading hash answers " +
        "\"color doesn't match the required format.\"; and the corrected body answers the generic " +
        "\"One or more parameters in this request are invalid.\", which is what a right body with " +
        "a wrong file id says. Result is data.results.url. Cost is 1 unit for full and for ombre. " +
        "Still unwatched: what the render looks like, which only looking at one settles.",
    },
    analysisKind: null,
  },

  clothTryOn: {
    key: "clothTryOn",
    createPath: "/s2s/v2.0/task/cloth-v4",
    statusPathPrefix: "/s2s/v2.0/task/cloth-v4",
    sourceFileFields: ["src_file_id", "src_file_url"],
    unitCost: {
      kind: "unknown",
      note:
        "2 units per call is published for V2.0 and V3.0. The cloth-v4 path may cost more. Read it from the API console.",
    },
    imageConstraints: {
      minShortSidePx: 384,
      maxLongSidePx: 4096,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote:
        "Single person filling at least 80 percent of the frame. 1024 by 768 is the recommended size.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: `${OPENAPI}/ai_clothes.json and ${LIVE_API}`,
      checkedOn: PROBED_ON,
      note:
        "Request body is { src_file_id or src_file_url, ref_file_id or ref_file_url, " +
        "garment_category }, with an optional change_shoes boolean that defaults to true and only " +
        "has an effect on full_body and lower_body. One garment_category per call, so a multi " +
        "garment outfit needs one call per garment and a Look renders as a sequence of renders. " +
        "garment_category is an enum, and the whole enum is now known rather than read out of " +
        "prose: full_body, lower_body, upper_body, shoes, auto, outer. Confirmed live for free " +
        "with an unresolvable src_file_id: all six accepted values answer the generic \"One or " +
        "more parameters in this request are invalid.\", and \"torso\" answers " +
        "\"garment_category is not one of the accepted values.\", so the value really is read and " +
        "checked at creation. Result is data.results.url. The unit cost is still unpublished: the " +
        "consumption table lists 2 units for V2.0 and V3.0 and omits V4.0 entirely.",
    },
    analysisKind: null,
  },

  skinSimulation: {
    key: "skinSimulation",
    createPath: "/s2s/v2.0/task/skin-simulation",
    statusPathPrefix: "/s2s/v2.0/task/skin-simulation",
    sourceFileFields: ["src_file_id"],
    unitCost: {
      kind: "tiered",
      countedBy: "concerns simulated",
      tiers: [
        { upTo: 4, units: 4 },
        { upTo: 10, units: 6 },
      ],
    },
    imageConstraints: {
      minShortSidePx: 480,
      maxLongSidePx: 2560,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote:
        "Face fills at least 60 percent of image width, frontal, evenly lit, no backlighting or coloured lights.",
      imagesPerCall: 1,
    },
    verification: {
      state: "confirmed",
      source: `${OPENAPI}/ai_skin_simulation.json and ${LIVE_API}`,
      checkedOn: PROBED_ON,
      note:
        "There is no concern to intensity map: the concerns are top level fields on the request " +
        "itself. The body is { src_file_id or src_file_url } plus one field per concern, each a " +
        "number from 0.0 to 1.0, and at least one of them has to be above zero. The ten field " +
        "names are wrinkle, radiance, oiliness, acne, eye_bags, dark_circle, spots, pores, " +
        "texture, redness. Two of those are singular where our own concern keys are plural, which " +
        "is the whole reason this was worth probing. Confirmed live for free with an unresolvable " +
        "src_file_id: the array shape this app used to send ({ simulations: [{ concern, " +
        "intensity }] }) answers \"Simulation intensity cannot be all zero\", and so do the " +
        "spellings wrinkles and dark_circles, because an unknown field is dropped and nothing is " +
        "left above zero; the ten documented names answer the generic \"One or more parameters in " +
        "this request are invalid.\"; and a texture of 5 answers \"texture is above the allowed " +
        "maximum.\", so the value is read and range checked. Result is data.results.url, the same " +
        "single url shape as the other renders. Cost is 4 units for 1 to 4 concerns and 6 for 5 " +
        "to 10.",
    },
    analysisKind: null,
  },

  watchTryOn: accessoryEndpoint("watchTryOn", "/s2s/v2.0/task/2d-vto/watch", {
    state: "confirmed",
    source: `${OPENAPI}/ai_watch.json and ${LIVE_API}`,
    checkedOn: PROBED_ON,
    note:
      "Path is /s2s/v2.0/task/2d-vto/watch. The request needs four things and not two: a source " +
      "(src_file_id or src_file_url), the product (ref_file_ids or ref_file_urls), " +
      "source_info { name }, and object_infos [{ name }]. Each name repeats the file id or URL it " +
      "points at, which is how the engine matches a source to its mask and a product to its mask; " +
      "an object_infos entry also takes an optional parameter object " +
      "(watch_need_remove_background, watch_anchor_point, watch_wearing_location, " +
      "watch_shadow_intensity, watch_ambient_light_intensity). Confirmed live for free with an " +
      "unresolvable src_file_id: the body this app used to send ({ src_file_id, ref_file_ids }) " +
      "answers \"source_info is required but wasn't included in your request., or object_infos is " +
      "required but wasn't included in your request.\", and adding both answers the generic \"One " +
      "or more parameters in this request are invalid.\" The masks (srcmsk_file_id, " +
      "refmsk_file_ids) are optional. Result is data.results.url. Cost is 1 unit per single item " +
      "simulation.",
  }),
  braceletTryOn: accessoryEndpoint(
    "braceletTryOn",
    "/s2s/v2.0/task/2d-vto/bracelet",
    inferredAccessoryNote("ai_bracelet"),
  ),
  ringTryOn: accessoryEndpoint(
    "ringTryOn",
    "/s2s/v2.0/task/2d-vto/ring",
    inferredAccessoryNote("ring_vto"),
  ),
  earringsTryOn: accessoryEndpoint("earringsTryOn", "/s2s/v2.0/task/2d-vto/earring", {
    state: "unverified",
    source: `${OPENAPI}/ai_earrings.json and ${LIVE_API}`,
    checkedOn: PROBED_ON,
    note:
      "The path is corrected and now real: 2d-vto/earring, singular. The spelling this file " +
      "carried before (2d-vto/earrings) answers 404 NotFound, so the request would have failed " +
      "with no picture and nothing to read. The body is the same 2d-vto shape as the watch, and " +
      "the server names all of it in one free rejection: a source, ref_file_ids or ref_file_urls, " +
      "source_info, and object_infos. This row stays unverified, and so refused, because the unit " +
      "cost is published nowhere we can read: the credits layer would have nothing true to " +
      "reserve against it.",
  }),
  necklaceTryOn: accessoryEndpoint(
    "necklaceTryOn",
    "/s2s/v2.0/task/2d-vto/necklace",
    inferredAccessoryNote("ai_necklace"),
  ),
  scarfTryOn: accessoryEndpoint(
    "scarfTryOn",
    "/s2s/v2.0/task/2d-vto/scarf",
    inferredAccessoryNote("ai_scarf"),
  ),
  hatTryOn: accessoryEndpoint(
    "hatTryOn",
    "/s2s/v2.0/task/2d-vto/hat",
    inferredAccessoryNote("ai_hat"),
  ),
  shoesTryOn: accessoryEndpoint(
    "shoesTryOn",
    "/s2s/v2.0/task/2d-vto/shoes",
    inferredAccessoryNote("ai_shoes"),
  ),
  bagTryOn: accessoryEndpoint("bagTryOn", "/s2s/v2.0/task/bag", {
    state: "unverified",
    source: `${OPENAPI}/ai_bag.json and ${LIVE_API}`,
    checkedOn: PROBED_ON,
    note:
      "The path is corrected: /s2s/v2.0/task/bag, which is not a 2d-vto endpoint at all. The " +
      "spelling this file carried before (2d-vto/bag) answers 404 NotFound. This is also not the " +
      "same API as the watch and the earrings: one free rejection has it asking for a source, " +
      "ref_file_id or ref_file_url, and gender, and gender is required. This app does not hold a " +
      "gender and does not ask anyone for one, so the row stays unverified and stays refused, and " +
      "accessoryTaskBody deliberately sends nothing for it rather than sending the 2d-vto body, " +
      "which would be the wrong body for this endpoint.",
  }),
};

function inferredAccessoryNote(referenceSlug: string): Verification {
  return {
    state: "unverified",
    source: `${MAKEUPAR}/reference/${referenceSlug}`,
    checkedOn: CHECKED_ON,
    note:
      "The path is a guess from the 2d-vto pattern the watch endpoint confirms, and that pattern " +
      "is not reliable: the earrings endpoint turned out to be 2d-vto/earring, singular, and the " +
      "bag endpoint is not under 2d-vto at all, and both of this file's guesses for those two " +
      "answered 404 NotFound. So read this path as probably wrong until a probe says otherwise. " +
      "Confirm the path, the request fields, and the unit cost before enabling it. The bundle at " +
      "docs.makeupar.com/_bundle/reference/<page>.json answers the first two for free.",
  };
}

function accessoryEndpoint(
  key: PerfectCorpEndpointKey,
  path: string,
  verification: Verification,
): PerfectCorpEndpoint {
  return {
    key,
    createPath: path,
    statusPathPrefix: path,
    sourceFileFields: ["src_file_id", "src_file_url"],
    unitCost:
      verification.state === "confirmed"
        ? { kind: "fixed", units: 1 }
        : { kind: "unknown", note: "Read it from the API console." },
    imageConstraints: {
      minShortSidePx: null,
      maxLongSidePx: 4096,
      maxBytes: TEN_MB,
      formats: ["image/jpeg", "image/png"],
      framingNote: "The body part that wears the item has to be fully visible and unobstructed.",
      imagesPerCall: 1,
    },
    verification,
    analysisKind: null,
  };
}

export function getEndpoint(key: PerfectCorpEndpointKey): PerfectCorpEndpoint {
  return PERFECTCORP_ENDPOINTS[key];
}

export function statusPathFor(key: PerfectCorpEndpointKey, taskId: string): string {
  return `${PERFECTCORP_ENDPOINTS[key].statusPathPrefix}/${encodeURIComponent(taskId)}`;
}

/** Endpoints we are allowed to call without an override. */
export function verifiedEndpointKeys(): PerfectCorpEndpointKey[] {
  return PERFECTCORP_ENDPOINT_KEYS.filter(
    (key) => PERFECTCORP_ENDPOINTS[key].verification.state === "confirmed",
  );
}

/**
 * Units one call reserves. Returns null when the cost is still unknown, which
 * the credits layer treats as "do not reserve, do not call".
 */
export function unitsForCall(key: PerfectCorpEndpointKey, itemCount = 1): number | null {
  const cost = PERFECTCORP_ENDPOINTS[key].unitCost;
  if (cost.kind === "fixed") {
    return cost.units;
  }
  if (cost.kind === "unknown") {
    return null;
  }
  for (const tier of cost.tiers) {
    if (itemCount <= tier.upTo) {
      return tier.units;
    }
  }
  return cost.tiers.length === 0 ? null : cost.tiers[cost.tiers.length - 1].units;
}
