import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React Server Component. The same replacement the other eval suites use.
 */
vi.mock("server-only", () => ({}));

import {
  buildProfileDownload,
  ProfileDownloadError,
  type ProfileDownloadReads,
} from "@/lib/server/profile/download";
import {
  BUCKETS,
  deleteEverything,
  ownedObjectsOf,
  type DeletedCounts,
  type DeleteEverythingSteps,
  type OwnedObjects,
} from "@/lib/server/profile/delete";
import { DEMO_FIXTURE_ENV } from "@/lib/server/profile/report-view";
import {
  buildProfileView,
  savedHairRow,
  savedLookRow,
  skinTypeRowValue,
  toneRowValue,
  topConcernRowValue,
} from "@/lib/server/profile/view";
import { checkLexicon, describeViolation } from "@/lib/shared/lexicon";
import type {
  Analysis,
  Capture,
  Garment,
  Look,
  Profile,
  Render,
} from "@/lib/server/db/types";
import type { AppSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";
import {
  findExcludedDownloadField,
  profileDeleteRequestSchema,
  profileDownloadFileName,
  profileDownloadSchema,
  profileUpdateRequestSchema,
  PROFILE_DOWNLOAD_FORMAT,
} from "@/lib/shared/profile-view";
import type { AestheticProfile } from "@/lib/server/profile/db";

/**
 * eval:safety, the person's controls.
 *
 * Spec: docs/06-safety-privacy.md, "Person's controls":
 * "/profile shows exactly what is stored, in plain rows. 'Download my data'
 * returns JSON of profile, analyses summaries, garments metadata, and looks.
 * 'Delete everything' requires typing DELETE and removes rows and storage
 * objects in one transaction, then signs the person out."
 * and, under "Keys, sessions, abuse": "Judge sessions cannot delete the demo
 * profile and cannot download data."
 *
 * There is no Supabase project on this build, so the two paths are exercised
 * with their reads and their steps handed in: buildProfileDownload takes a
 * ProfileDownloadReads and deleteEverything takes a DeleteEverythingSteps, both
 * with a production default. What that buys is the two things a database could
 * not prove more convincingly anyway:
 *
 * 1. That the export cannot carry a storage path, a signed URL, a mask path, or
 *    a raw provider payload. The rows fed in below carry all four, on purpose.
 * 2. That the delete removes objects before it removes the rows that point at
 *    them, and signs the person out last. The order is the whole design
 *    (src/lib/server/profile/delete.ts), and order is exactly what a recorded
 *    call list can assert.
 *
 * What it does not prove: that the queries are correct SQL, or that Supabase
 * removes what it is asked to. Both need the live project, and both are on the
 * human's list for the day the keys exist.
 */

/* ------------------------------------------------------------------ */
/* Rows that carry everything the export must not leak                 */
/* ------------------------------------------------------------------ */

const OWNER = "11111111-1111-4111-8111-111111111111";

const CAPTURE_PATH = `${OWNER}/capture-one.jpg`;
const MASK_PATH_FROM_ANALYSIS = `${OWNER}/capture-one/pigmentation.png`;
const MASK_PATH_FROM_PROFILE = `${OWNER}/capture-one/dark_spots.png`;
const RENDER_PATH = `${OWNER}/render-one.png`;
const GARMENT_PATH = `${OWNER}/garment-one.jpg`;

/** A signed read, in the shape Supabase mints them. Never allowed to travel. */
const SIGNED_URL =
  "https://example.supabase.co/storage/v1/object/sign/captures/one.jpg?token=abc.def.ghi";

const PROFILE_ROW: Profile = {
  user_id: OWNER,
  display_name: "Aditi",
  consent_at: "2026-08-01T10:00:00.000Z",
  consent_version: "2026-07-01",
  is_adult_confirmed: true,
  keep_originals: false,
  location_consent: true,
  approx_location: { city: "Bengaluru", lat: 12.97, lng: 77.59 },
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-02T10:00:00.000Z",
};

const AESTHETIC_ROW: AestheticProfile = {
  user_id: OWNER,
  capture_id: "capture-one",
  skin_type_zones: { t_zone: "oily", cheeks: "dry" },
  concerns: [
    { key: "pigmentation", score: 71, rank: 1, mask_path: MASK_PATH_FROM_PROFILE },
    { key: "dark_spots", score: 62, rank: 2, mask_path: null },
  ],
  skin_age: 31,
  fitzpatrick: 5,
  skin_tone_hex: "#6b4a2f",
  undertone: "warm",
  undertone_source: "detected",
  eye_color_hex: "#3b2b22",
  hair_color_hex: "#1e1613",
  face_shape: "Oval",
  hair_type: null,
  saved_hair_style_id: "textured-crop",
  saved_hair_color_name: "Warm chestnut",
  saved_makeup: null,
  season: "deep_autumn",
  palette: null,
  reading: "Your skin is combination: oilier through the T zone, drier on the cheeks.",
  reading_model: "fallback/rules",
  version: 1,
  created_at: "2026-08-01T10:05:00.000Z",
  updated_at: "2026-08-01T10:05:00.000Z",
};

const ANALYSIS_ROW: Analysis = {
  id: "analysis-one",
  capture_id: "capture-one",
  user_id: OWNER,
  kind: "skin",
  status: "succeeded",
  provider_task_id: "pc-task-42",
  // The provider's own response body. Kept for debugging, never exported.
  raw: { vendor: "payload", storage_path: CAPTURE_PATH },
  summary: {
    concerns: [
      { providerType: "spot_cheek", key: "pigmentation", uiScore: 71, rawScore: 29 },
    ],
    skinAge: 31,
  },
  mask_paths: [MASK_PATH_FROM_ANALYSIS],
  credits_used: 4,
  error: null,
  created_at: "2026-08-01T10:02:00.000Z",
  updated_at: "2026-08-01T10:03:00.000Z",
};

const GARMENT_ROW: Garment = {
  id: "garment-one",
  user_id: OWNER,
  storage_path: GARMENT_PATH,
  type: "blazer",
  colors: [{ name: "Navy", hex: "#1f2a44" }],
  pattern: "solid",
  formality: "formal",
  classification: { confidence: 0.9, storage_path: GARMENT_PATH },
  user_edited: false,
  created_at: "2026-08-02T09:00:00.000Z",
  updated_at: "2026-08-02T09:00:00.000Z",
};

const LOOK_ROW: Look = {
  id: "look-one",
  user_id: OWNER,
  occasion: "wedding_guest",
  garments: [
    { garment_id: "garment-one", type: "blazer" },
    {
      title: "Chocolate leather derby shoes",
      priceText: "Rs 4,299",
      priceValue: 4299,
      currency: "INR",
      url: "https://shop.example.com/derby",
      imageUrl: "https://cdn.example.com/derby.jpg",
      store: "Example Store",
      type: "shoes",
    },
  ],
  rationale:
    "Navy against your warm deep skin reads sharp and calm. It is the quiet end of what a wedding asks a guest to wear.",
  render_path: RENDER_PATH,
  is_saved: true,
  created_at: "2026-08-02T09:30:00.000Z",
  updated_at: "2026-08-02T09:30:00.000Z",
};

const CAPTURE_ROW: Capture = {
  id: "capture-one",
  user_id: OWNER,
  sha256: "a".repeat(64),
  storage_path: CAPTURE_PATH,
  width: 1024,
  height: 1024,
  quality: null,
  deleted_at: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
};

const RENDER_ROW: Render = {
  id: "render-one",
  user_id: OWNER,
  kind: "cloth",
  params: { garmentId: "garment-one" },
  params_hash: "b".repeat(64),
  storage_path: RENDER_PATH,
  provider_task_id: "pc-render-7",
  credits_used: 2,
  status: "succeeded",
  created_at: "2026-08-02T09:31:00.000Z",
  updated_at: "2026-08-02T09:32:00.000Z",
};

const FULL_READS: ProfileDownloadReads = {
  profile: async () => PROFILE_ROW,
  aesthetic: async () => AESTHETIC_ROW,
  analyses: async () => [ANALYSIS_ROW],
  garments: async () => [GARMENT_ROW],
  looks: async () => [LOOK_ROW],
};

const USER_SESSION: AppSession = {
  kind: "user",
  id: OWNER,
  ownerType: "user",
};

const JUDGE_SESSION: AppSession = {
  kind: "judge",
  id: "22222222-2222-4222-8222-222222222222",
  ownerType: "judge_session",
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    code_hash: "hash",
    expires_at: "2099-01-01T00:00:00.000Z",
    analyses_allowed: 3,
    analyses_used: 0,
    credits_cap: 100,
    credits_used: 0,
    last_seen_at: null,
    consent_at: "2026-08-01T10:00:00.000Z",
    consent_version: "2026-07-01",
    is_adult_confirmed: true,
    keep_originals: false,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
  },
};

/** Fixture mode is off for these tests unless one of them turns it on. */
let previousFixtureEnv: string | undefined;

beforeEach(() => {
  previousFixtureEnv = process.env[DEMO_FIXTURE_ENV];
  delete process.env[DEMO_FIXTURE_ENV];
});

afterEach(() => {
  if (previousFixtureEnv === undefined) {
    delete process.env[DEMO_FIXTURE_ENV];
  } else {
    process.env[DEMO_FIXTURE_ENV] = previousFixtureEnv;
  }
});

/* ------------------------------------------------------------------ */
/* Download my data                                                    */
/* ------------------------------------------------------------------ */

describe("eval:safety, download my data", () => {
  it("returns the four things docs/06 promises", async () => {
    const document = await buildProfileDownload({
      ownerId: OWNER,
      reads: FULL_READS,
      now: new Date("2026-09-01T08:00:00.000Z"),
    });

    expect(document.format).toBe(PROFILE_DOWNLOAD_FORMAT);
    expect(document.exportedAt).toBe("2026-09-01T08:00:00.000Z");

    // 1. the profile, including the reading and the consent record
    expect(document.profile.consentAt).toBe(PROFILE_ROW.consent_at);
    expect(document.profile.aesthetic?.reading).toBe(AESTHETIC_ROW.reading);
    expect(document.profile.aesthetic?.concerns).toEqual([
      { key: "pigmentation", score: 71, rank: 1 },
      { key: "dark_spots", score: 62, rank: 2 },
    ]);
    // 2. analyses summaries
    expect(document.analyses).toHaveLength(1);
    expect(document.analyses[0]?.kind).toBe("skin");
    expect(document.analyses[0]?.summary).toEqual(ANALYSIS_ROW.summary);
    // 3. garments metadata
    expect(document.garments[0]?.type).toBe("blazer");
    expect(document.garments[0]?.colors).toEqual([
      { name: "Navy", hex: "#1f2a44" },
    ]);
    // 4. looks, with the listing that stood in for a piece they do not own
    expect(document.looks[0]?.isSaved).toBe(true);
    expect(document.looks[0]?.items).toEqual([
      { source: "garment", garmentId: "garment-one", type: "blazer" },
      {
        source: "listing",
        type: "shoes",
        title: "Chocolate leather derby shoes",
        priceText: "Rs 4,299",
        store: "Example Store",
        url: "https://shop.example.com/derby",
      },
    ]);
  });

  it("carries no storage path, no mask path, and no raw provider payload", async () => {
    const document = await buildProfileDownload({
      ownerId: OWNER,
      reads: FULL_READS,
    });
    const serialized = JSON.stringify(document);

    for (const path of [
      CAPTURE_PATH,
      MASK_PATH_FROM_ANALYSIS,
      MASK_PATH_FROM_PROFILE,
      RENDER_PATH,
      GARMENT_PATH,
    ]) {
      expect(serialized, `the export leaked ${path}`).not.toContain(path);
    }

    // The provider's own body, and the classifier's stored output, stay behind.
    expect(serialized).not.toContain("vendor");
    expect(serialized).not.toContain("confidence");
    expect(serialized).not.toContain("pc-task-42");
    expect(serialized).not.toContain("pc-render-7");
    // The garment photo url the wardrobe screen shows is a signed read, so the
    // export names the garment and never its picture.
    expect(serialized).not.toContain("imageUrl");
    // No coordinates. The person allowed a city, not a location history.
    expect(serialized).not.toContain("12.97");
    expect(document.profile.approxLocationCity).toBe("Bengaluru");

    expect(findExcludedDownloadField(document)).toBeNull();
  });

  it("refuses rather than repairs when a signed URL reached a stored value", async () => {
    const poisoned: ProfileDownloadReads = {
      ...FULL_READS,
      looks: async () => [
        { ...LOOK_ROW, rationale: `A saved look. ${SIGNED_URL}` },
      ],
    };

    await expect(
      buildProfileDownload({ ownerId: OWNER, reads: poisoned }),
    ).rejects.toBeInstanceOf(ProfileDownloadError);
  });

  it("answers a person with nothing stored, rather than failing", async () => {
    const empty: ProfileDownloadReads = {
      profile: async () => null,
      aesthetic: async () => null,
      analyses: async () => [],
      garments: async () => [],
      looks: async () => [],
    };
    const document = await buildProfileDownload({ ownerId: OWNER, reads: empty });
    expect(document.profile.aesthetic).toBeNull();
    expect(document.profile.isAdultConfirmed).toBe(false);
    expect(document.analyses).toEqual([]);
    expect(document.looks).toEqual([]);
  });

  it("serializes to valid JSON that parses back through its own schema", async () => {
    /*
     * docs/09-build-order-and-demo.md Layer 5, definition of done: "Download
     * returns valid JSON." The route hands over
     * `JSON.stringify(payload, null, 2)`, so this asserts the document survives
     * that round trip: it serializes, it parses, and what comes back is still
     * the document the strict schema accepts, with nothing added or lost on the
     * way. The route itself is a serializer over this function
     * (src/app/api/profile/download/route.ts) and its refusals are covered end
     * to end in e2e/smoke.spec.ts.
     */
    const built = await buildProfileDownload({
      ownerId: OWNER,
      reads: FULL_READS,
      now: new Date("2026-09-01T08:00:00.000Z"),
    });

    const body = `${JSON.stringify(built, null, 2)}\n`;
    const reparsed: unknown = JSON.parse(body);
    const checked = profileDownloadSchema.safeParse(reparsed);
    expect(
      checked.success ? [] : checked.error.issues.map((issue) => issue.path),
    ).toEqual([]);
    expect(checked.success && checked.data).toEqual(built);

    // The file the browser is offered: plain, dated, and not a person's name.
    expect(profileDownloadFileName(built.exportedAt)).toBe(
      "aurum-my-data-2026-09-01.json",
    );

    // The round trip is the last place an address could appear, so the guard
    // runs on what was actually serialized rather than on the object alone.
    expect(findExcludedDownloadField(reparsed)).toBeNull();
  });

  it("has a schema that rejects a field nobody declared", () => {
    const document = {
      format: PROFILE_DOWNLOAD_FORMAT,
      exportedAt: "2026-09-01T08:00:00.000Z",
      note: "note",
      profile: {
        consentAt: null,
        consentVersion: null,
        isAdultConfirmed: false,
        keepOriginals: false,
        locationConsent: false,
        approxLocationCity: null,
        aesthetic: null,
      },
      analyses: [],
      garments: [],
      looks: [],
    };
    expect(profileDownloadSchema.safeParse(document).success).toBe(true);
    expect(
      profileDownloadSchema.safeParse({
        ...document,
        profile: { ...document.profile, storage_path: CAPTURE_PATH },
      }).success,
    ).toBe(false);
  });

  it("finds an excluded field at any depth, and says where", () => {
    expect(findExcludedDownloadField({ a: { b: [{ storage_path: "x" }] } })).toBe(
      "$.a.b[0].storage_path",
    );
    expect(findExcludedDownloadField({ note: SIGNED_URL })).toContain("$.note");
    // A public listing url is meant to be there and is not an address into our
    // own storage.
    expect(
      findExcludedDownloadField({ url: "https://shop.example.com/derby" }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Delete everything                                                   */
/* ------------------------------------------------------------------ */

const NO_ROWS_DELETED: DeletedCounts = {
  jobs: 0,
  looks: 0,
  renders: 0,
  garments: 0,
  analyses: 0,
  aestheticProfiles: 0,
  captures: 0,
  profiles: 0,
};

const OWNED: OwnedObjects = {
  captures: [CAPTURE_PATH],
  masks: [MASK_PATH_FROM_ANALYSIS, MASK_PATH_FROM_PROFILE],
  renders: [RENDER_PATH],
  garments: [GARMENT_PATH],
};

/** Records every step in the order it happened. */
function recordingSteps(): {
  readonly steps: DeleteEverythingSteps;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      readObjects: async () => {
        calls.push("read");
        return OWNED;
      },
      removeObjects: async (bucket, paths) => {
        calls.push(`remove:${bucket}:${paths.length}`);
      },
      deleteRows: async () => {
        calls.push("rows");
        return { ...NO_ROWS_DELETED, captures: 1, profiles: 1 };
      },
      signOut: async () => {
        calls.push("signout");
      },
    },
  };
}

describe("eval:safety, delete everything", () => {
  it("removes every object before it removes a single row, then signs out", async () => {
    const recorder = recordingSteps();
    const outcome = await deleteEverything({
      session: USER_SESSION,
      steps: recorder.steps,
    });

    expect(outcome.ok).toBe(true);
    expect(recorder.calls).toEqual([
      "read",
      `remove:${BUCKETS.captures}:1`,
      `remove:${BUCKETS.masks}:2`,
      `remove:${BUCKETS.renders}:1`,
      `remove:${BUCKETS.garments}:1`,
      "rows",
      "signout",
    ]);

    // The order is the design: a crash between the two halves has to leave rows
    // pointing at objects that are gone, never objects nothing points at, so the
    // next attempt can still find everything.
    const rowsAt = recorder.calls.indexOf("rows");
    const lastRemoveAt = recorder.calls.findLastIndex((call) =>
      call.startsWith("remove:"),
    );
    expect(lastRemoveAt).toBeLessThan(rowsAt);
    expect(recorder.calls.indexOf("signout")).toBeGreaterThan(rowsAt);
  });

  it("touches all four private buckets, so nothing is left in one of them", async () => {
    const recorder = recordingSteps();
    await deleteEverything({ session: USER_SESSION, steps: recorder.steps });
    for (const bucket of Object.values(BUCKETS)) {
      expect(
        recorder.calls.some((call) => call.startsWith(`remove:${bucket}:`)),
        `nothing was removed from ${bucket}`,
      ).toBe(true);
    }
  });

  it("refuses a judge session without touching anything", async () => {
    const recorder = recordingSteps();
    const outcome = await deleteEverything({
      session: JUDGE_SESSION,
      steps: recorder.steps,
    });
    expect(outcome).toEqual({ ok: false, reason: "read_only" });
    expect(recorder.calls).toEqual([]);
  });

  it("refuses in fixture mode without touching anything", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";
    const recorder = recordingSteps();
    const outcome = await deleteEverything({
      session: USER_SESSION,
      steps: recorder.steps,
    });
    expect(outcome).toEqual({ ok: false, reason: "read_only" });
    expect(recorder.calls).toEqual([]);
  });

  it("reports the delete as done when only the sign out failed", async () => {
    const recorder = recordingSteps();
    const outcome = await deleteEverything({
      session: USER_SESSION,
      steps: {
        ...recorder.steps,
        signOut: async () => {
          throw new Error("auth server unreachable");
        },
      },
    });
    // The data is gone. Telling the person it was not would be the worse lie.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.signedOut).toBe(false);
      expect(outcome.removed.masks).toBe(2);
    }
  });

  it("gathers mask paths from the analyses and from the profile, once each", () => {
    const objects = ownedObjectsOf({
      captures: [CAPTURE_ROW, { ...CAPTURE_ROW, id: "two", storage_path: null }],
      analyses: [
        ANALYSIS_ROW,
        // The same mask recorded twice must not be removed twice.
        { ...ANALYSIS_ROW, id: "analysis-two" },
      ],
      aesthetic: AESTHETIC_ROW,
      renders: [RENDER_ROW, { ...RENDER_ROW, id: "two", storage_path: null }],
      garments: [GARMENT_ROW],
    });

    // A capture whose original was already deleted by retention has no path.
    expect(objects.captures).toEqual([CAPTURE_PATH]);
    expect(objects.renders).toEqual([RENDER_PATH]);
    expect(objects.garments).toEqual([GARMENT_PATH]);
    expect([...objects.masks].sort()).toEqual(
      [MASK_PATH_FROM_ANALYSIS, MASK_PATH_FROM_PROFILE].sort(),
    );
  });
});

/* ------------------------------------------------------------------ */
/* What the profile screen says is stored                              */
/* ------------------------------------------------------------------ */

describe("eval:safety, the plain rows", () => {
  it("shows the six rows docs/01 section L lists, in that order", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";
    const view = await buildProfileView(USER_SESSION);

    expect(view.rows.map((row) => row.key)).toEqual([
      "skin_type",
      "top_concern",
      "tone_undertone",
      "season",
      "face_shape",
      "hair_type",
    ]);
    expect(view.rows.map((row) => row.label)).toEqual([
      copy.profile.rowSkinType,
      copy.profile.rowTopConcern,
      copy.profile.rowToneAndUndertone,
      copy.profile.rowSeason,
      copy.profile.rowFaceShape,
      copy.profile.rowHairType,
    ]);
    expect(view.rows.map((row) => row.action)).toEqual([
      "retake",
      "retake",
      "adjust",
      null,
      "retake",
      "retake",
    ]);
  });

  it("reads the demo profile from the same fixture every other screen reads", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";
    const view = await buildProfileView(USER_SESSION);
    const valueOf = (key: string): string | null =>
      view.rows.find((row) => row.key === key)?.value ?? null;

    expect(valueOf("skin_type")).toBe("Combination, oily T zone and dry cheeks");
    expect(valueOf("top_concern")).toBe("Pigmentation");
    expect(valueOf("tone_undertone")).toBe("Deep tone, warm undertone");
    expect(valueOf("season")).toBe("Deep Autumn");
    expect(valueOf("face_shape")).toBe("Oval");
    // Null, and honestly: hair type detection needs three photos and is skipped
    // in the one selfie fan out, so no profile this build writes has one. The
    // screen renders copy.profile.valueUnavailable for it.
    expect(valueOf("hair_type")).toBeNull();

    // Read only, and shown as such: docs/01 "Judge mode across the flow".
    expect(view.isJudgeSession).toBe(true);
    expect(view.keepOriginals).toBe(false);
  });

  it("lists the demo profile's two saved looks and claims no saved makeup", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";
    const view = await buildProfileView(USER_SESSION);

    expect(view.saved.map((item) => item.kind)).toEqual(["look", "look"]);
    expect(view.saved.map((item) => item.label)).toEqual([
      copy.looks.occasionWeddingGuest,
      copy.looks.occasionInterview,
    ]);
    for (const item of view.saved) {
      expect(item.detail).not.toBeNull();
    }
    // No column stores a makeup selection and no route writes one, so a makeup
    // row here would claim a save the server never made.
    expect(view.saved.some((item) => item.kind === "makeup")).toBe(false);
  });

  it("writes every row value in the same words the rest of the copy passes", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";
    const view = await buildProfileView(USER_SESSION);
    for (const row of view.rows) {
      if (row.value === null) {
        continue;
      }
      expect(
        checkLexicon(row.value).map(describeViolation),
        `"${row.value}" is not lexicon clean`,
      ).toEqual([]);
    }
    for (const item of view.saved) {
      expect(checkLexicon(item.label).map(describeViolation)).toEqual([]);
      expect(
        checkLexicon(item.detail ?? "").map(describeViolation),
      ).toEqual([]);
    }
  });

  it("says nothing about a reading nobody took", () => {
    // Both zones agree, so the row is the type word alone rather than the same
    // word three times.
    expect(skinTypeRowValue({ tZone: "balanced", cheeks: "balanced" })).toBe(
      "Balanced",
    );
    expect(skinTypeRowValue({ tZone: null, cheeks: null })).toBeNull();

    expect(topConcernRowValue([])).toBeNull();
    expect(
      topConcernRowValue([
        { key: "not_a_concern", score: 90, rank: 1, mask_path: null },
        { key: "redness", score: 40, rank: 2, mask_path: null },
      ]),
    ).toBe("Redness");

    // Half a tone reading is not a value, it is half a sentence.
    expect(
      toneRowValue({ skinToneHex: "#6b4a2f", undertone: null, fitzpatrick: 5 }),
    ).toBeNull();
    expect(
      toneRowValue({ skinToneHex: null, undertone: "warm", fitzpatrick: null }),
    ).toBeNull();
  });

  it("drops a saved choice the app can no longer draw", () => {
    expect(
      savedHairRow({ styleId: "a-style-nobody-has", colorName: null }),
    ).toBeNull();
    expect(savedHairRow({ styleId: null, colorName: "Warm chestnut" })).toBeNull();

    expect(savedLookRow({ ...LOOK_ROW, occasion: "brunch" })).toBeNull();
    expect(savedLookRow({ ...LOOK_ROW, garments: [] })).toBeNull();
    expect(savedLookRow(LOOK_ROW)).toEqual({
      kind: "look",
      label: copy.looks.occasionWeddingGuest,
      detail: "Blazer, shoes",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The typed confirmation                                              */
/* ------------------------------------------------------------------ */

describe("eval:safety, the typed confirmation", () => {
  it("accepts the exact word and nothing else", () => {
    expect(
      profileDeleteRequestSchema.safeParse({
        confirmation: copy.profile.deleteConfirmWord,
      }).success,
    ).toBe(true);

    for (const typed of ["delete", "Delete", "DELETE ", " DELETE", "", "yes"]) {
      expect(
        profileDeleteRequestSchema.safeParse({ confirmation: typed }).success,
        `"${typed}" armed the delete`,
      ).toBe(false);
    }
    expect(profileDeleteRequestSchema.safeParse({}).success).toBe(false);
  });

  it("takes a boolean and only a boolean for the retention toggle", () => {
    expect(
      profileUpdateRequestSchema.safeParse({ keepOriginals: true }).success,
    ).toBe(true);
    expect(
      profileUpdateRequestSchema.safeParse({ keepOriginals: "true" }).success,
    ).toBe(false);
    expect(profileUpdateRequestSchema.safeParse({}).success).toBe(false);
  });
});
