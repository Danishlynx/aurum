import { beforeEach, describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts: this replaces the marker. */
vi.mock("server-only", () => ({}));

/**
 * The three things /makeup touches outside itself, replaced so this file runs on
 * a clean clone with no Supabase project, no storage, and no provider key:
 * the profile row, the renders table, and the signed URL.
 *
 * Nothing here reaches a network and nothing here spends a credit. The render
 * this file talks about is one that already exists; the whole point of the
 * behaviour under test is that no new one is ever asked for.
 */
vi.mock("@/lib/server/profile/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/server/profile/db")>();
  return {
    ...original,
    getAestheticProfile: vi.fn(),
    upsertAestheticProfile: vi.fn(),
  };
});

vi.mock("@/lib/server/renders/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/server/renders/db")>();
  return { ...original, findRenderByHash: vi.fn() };
});

vi.mock("@/lib/server/db/storage", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/server/db/storage")>();
  return { ...original, createSignedRead: vi.fn() };
});

vi.mock("@/lib/server/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/db")>();
  return { ...original, getCapture: vi.fn() };
});

import { getCapture } from "@/lib/server/db";
import { createSignedRead } from "@/lib/server/db/storage";
import type { Json, Render } from "@/lib/server/db/types";
import {
  getAestheticProfile,
  upsertAestheticProfile,
  type AestheticProfile,
} from "@/lib/server/profile/db";
import {
  buildMakeupView,
  openingLook,
  readSavedMakeup,
  saveMakeupLook,
} from "@/lib/server/profile/makeup";
import { applySavedShades, buildMakeupCategoryViews } from "@/lib/server/profile/shades";
import { DEMO_FIXTURE_ENV } from "@/lib/server/profile/report-view";
import { findRenderByHash } from "@/lib/server/renders/db";
import { canonicalMakeupParams, paramsHash } from "@/lib/server/renders/params";
import type { AppSession } from "@/lib/server/session";
import {
  makeupRenderParamsSchema,
  type MakeupRenderCategoryInput,
} from "@/lib/shared/color-view";
import { derivePalette } from "@/lib/shared/palette";

/**
 * "Save this look", docs/01-user-flow.md section H item 4, and the reason it has
 * to be more than a stored row.
 *
 * A makeup render is keyed by (user_id, kind, params_hash) and the hash covers
 * the capture and the shades (src/lib/server/renders/params.ts). So a screen
 * that opens on shades the palette derives can only ever find a render made from
 * those same derived shades. The demo profile's one try on was bought with
 * explicit shades, and the palette behind it has since been re derived from the
 * measured colours, so the two no longer meet: the paid render existed and the
 * screen asked for a different one, which the demo profile cannot buy.
 *
 * What is asserted here is the whole chain, in the order it runs: the saved look
 * is read back, the rows open on it, the opening look hashes to the render that
 * exists, and the view carries that render's URL so the hero has it at the first
 * paint without a request that consent or a cap could refuse.
 */

const CAPTURE_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-000000000001";

/** The shades the golden run's makeup render was actually made with. */
const SAVED_CATEGORIES: MakeupRenderCategoryInput[] = [
  { category: "blush", shadeHex: "#c98a6e", shadeName: "Soft terracotta" },
  { category: "lip", shadeHex: "#9c5a44", shadeName: "Terracotta" },
];

const SESSION: AppSession = {
  kind: "user",
  id: OWNER_ID,
  ownerType: "user",
};

const readProfile = vi.mocked(getAestheticProfile);
const writeProfile = vi.mocked(upsertAestheticProfile);
const readRender = vi.mocked(findRenderByHash);
const signRead = vi.mocked(createSignedRead);
const readCapture = vi.mocked(getCapture);

/**
 * The seeded demo profile, in the state the attributes fix leaves it: the
 * measured tone, a neutral undertone, and the palette that derives from them.
 */
function profileRow(overrides: Partial<AestheticProfile> = {}): AestheticProfile {
  return {
    user_id: OWNER_ID,
    capture_id: CAPTURE_ID,
    skin_type_zones: null,
    concerns: [] as unknown as Json,
    skin_age: 31,
    fitzpatrick: null,
    skin_tone_hex: "#997357",
    undertone: "neutral",
    undertone_source: "detected",
    eye_color_hex: "#0f0b0f",
    hair_color_hex: "#faf0be",
    face_shape: null,
    hair_type: null,
    saved_hair_style_id: null,
    saved_hair_color_name: null,
    saved_makeup: { categories: SAVED_CATEGORIES } as unknown as Json,
    season: "clear_winter",
    palette: null,
    reading: null,
    reading_model: null,
    version: 1,
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

/** The renders row the seed writes for the try on the founder paid for. */
function renderRow(paramsHashValue: string): Render {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    user_id: OWNER_ID,
    kind: "makeup",
    params: {} as unknown as Json,
    params_hash: paramsHashValue,
    storage_path: `${OWNER_ID}/00000000-0000-4000-8000-000000000301.png`,
    provider_task_id: "task-makeup",
    credits_used: 1,
    status: "succeeded",
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
  } as Render;
}

/** The hash the seeded render row carries for the saved shades. */
function savedLookHash(): string {
  return paramsHash(
    "makeup",
    canonicalMakeupParams({
      captureId: CAPTURE_ID,
      params: makeupRenderParamsSchema.parse({ categories: SAVED_CATEGORIES }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env[DEMO_FIXTURE_ENV];
  readCapture.mockResolvedValue(null);
  signRead.mockResolvedValue("https://storage.example.com/signed/render.png");
  readRender.mockResolvedValue(null);
});

/* ------------------------------------------------------------------ */
/* The rows a saved look opens on                                      */
/* ------------------------------------------------------------------ */

describe("applySavedShades", () => {
  const rows = buildMakeupCategoryViews({
    palette: derivePalette({
      skinToneHex: "#997357",
      undertone: "neutral",
      eyeColorHex: "#0f0b0f",
      hairColorHex: "#faf0be",
      fitzpatrick: null,
    }),
    skinToneHex: "#997357",
  });

  it("has rows to apply a saved look to", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.shades).toHaveLength(3);
      expect(row.savedIndex).toBeUndefined();
    }
  });

  it("selects a saved shade that is one of the three derived", () => {
    const lip = rows.find((row) => row.category === "lip");
    const derived = lip?.shades[2];
    expect(derived).toBeDefined();

    const applied = applySavedShades(rows, [
      {
        category: "lip",
        // The same colour written in upper case, because a hex is a colour and
        // not a string: it must not add a fourth swatch of the same shade.
        shadeHex: (derived?.hex ?? "").toUpperCase(),
        shadeName: "Whatever it was called when it was saved",
      },
    ]);
    const appliedLip = applied.find((row) => row.category === "lip");

    expect(appliedLip?.shades).toHaveLength(3);
    expect(appliedLip?.savedIndex).toBe(2);
    expect(appliedLip?.shades[2]?.name).toBe(derived?.name);
  });

  it("adds a saved shade the palette no longer derives, and opens on it", () => {
    const applied = applySavedShades(rows, SAVED_CATEGORIES);
    const lip = applied.find((row) => row.category === "lip");
    expect(lip).toBeDefined();

    // Four swatches: the three the palette derives plus the one the person
    // saved, which is the case docs/01 section H item 4 has to survive.
    expect(lip?.shades).toHaveLength(4);
    const savedIndex = lip?.savedIndex ?? -1;
    expect(lip?.shades[savedIndex]?.hex).toBe("#9c5a44");
    expect(lip?.shades[savedIndex]?.name).toBe("Terracotta");
    // It is shoppable like every other swatch: no swatch on this screen carries
    // an empty product query.
    expect(lip?.shades[savedIndex]?.productQuery.length).toBeGreaterThan(0);

    // The recommendation is still the same swatch, wherever it now sits.
    const recommended = lip?.shades[lip.recommendedIndex];
    const originalLip = rows.find((row) => row.category === "lip");
    expect(recommended?.hex).toBe(originalLip?.shades[1]?.hex);
  });

  it("leaves a row alone when nothing was saved for its category", () => {
    const applied = applySavedShades(rows, [
      { category: "lip", shadeHex: "#9c5a44", shadeName: "Terracotta" },
    ]);
    for (const row of applied) {
      if (row.category === "lip") {
        continue;
      }
      expect(row.savedIndex).toBeUndefined();
      expect(row.shades).toHaveLength(3);
    }
  });

  it("keeps the ladder running lightest first", () => {
    const applied = applySavedShades(rows, SAVED_CATEGORIES);
    for (const row of applied) {
      const lightness = row.shades.map((shade) => {
        const value = Number.parseInt(shade.hex.slice(1, 3), 16);
        const green = Number.parseInt(shade.hex.slice(3, 5), 16);
        const blue = Number.parseInt(shade.hex.slice(5, 7), 16);
        return (Math.max(value, green, blue) + Math.min(value, green, blue)) / 2;
      });
      const sorted = [...lightness].sort((a, b) => b - a);
      expect(lightness).toEqual(sorted);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Reading the stored column                                            */
/* ------------------------------------------------------------------ */

describe("readSavedMakeup", () => {
  it("reads back what the save wrote", () => {
    expect(readSavedMakeup(profileRow())).toEqual(SAVED_CATEGORIES);
  });

  it("reads nothing saved as nothing saved", () => {
    expect(readSavedMakeup(profileRow({ saved_makeup: null }))).toEqual([]);
  });

  it("refuses a stored value that is not a look this build can draw", () => {
    for (const stored of [
      { categories: [{ category: "lip", shadeHex: "terracotta" }] },
      { categories: [{ category: "nose", shadeHex: "#9c5a44", shadeName: "X" }] },
      { categories: [] },
      { shades: ["#9c5a44"] },
      "saved",
    ]) {
      expect(
        readSavedMakeup(profileRow({ saved_makeup: stored as unknown as Json })),
      ).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The view                                                             */
/* ------------------------------------------------------------------ */

describe("buildMakeupView with a saved look", () => {
  it("opens on the saved shades and carries the render they were made with", async () => {
    readProfile.mockResolvedValue(profileRow());
    const hash = savedLookHash();
    readRender.mockImplementation((args) =>
      Promise.resolve(args.paramsHash === hash ? renderRow(hash) : null),
    );

    const view = await buildMakeupView(SESSION);
    expect(view).not.toBeNull();
    if (view === null) {
      return;
    }

    // The rows open on the saved shades.
    const opening = openingLook(view.categories);
    expect(opening).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "lip", shadeHex: "#9c5a44" }),
        expect.objectContaining({ category: "blush", shadeHex: "#c98a6e" }),
      ]),
    );

    // And they hash to the render that exists, which is the whole point: the
    // lookup asked for exactly the hash the seeded row carries.
    expect(readRender).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        kind: "makeup",
        paramsHash: hash,
      }),
    );
    expect(view.renderUrl).toBe(
      "https://storage.example.com/signed/render.png",
    );
  });

  it("asks for no render at all when nothing is saved and nothing is stored", async () => {
    readProfile.mockResolvedValue(profileRow({ saved_makeup: null }));

    const view = await buildMakeupView(SESSION);

    expect(view?.renderUrl).toBeNull();
    for (const row of view?.categories ?? []) {
      expect(row.savedIndex).toBeUndefined();
    }
    // The lookup still runs, for the recommended look, and finds nothing. What
    // must never happen is a URL with no render behind it.
    expect(readRender).toHaveBeenCalled();
    expect(signRead).not.toHaveBeenCalled();
  });

  it("shows no render for a look that was never rendered", async () => {
    readProfile.mockResolvedValue(profileRow());
    readRender.mockResolvedValue(null);

    const view = await buildMakeupView(SESSION);

    expect(view?.renderUrl).toBeNull();
  });

  it("shows no render for one that did not succeed", async () => {
    readProfile.mockResolvedValue(profileRow());
    readRender.mockResolvedValue({
      ...renderRow(savedLookHash()),
      status: "failed",
    });

    const view = await buildMakeupView(SESSION);

    expect(view?.renderUrl).toBeNull();
    expect(signRead).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* The save                                                             */
/* ------------------------------------------------------------------ */

describe("saveMakeupLook", () => {
  it("stores the shades in the shape a render is hashed under", async () => {
    readProfile.mockResolvedValue(profileRow({ saved_makeup: null }));
    writeProfile.mockResolvedValue(profileRow());

    const outcome = await saveMakeupLook({
      session: SESSION,
      params: makeupRenderParamsSchema.parse({ categories: SAVED_CATEGORIES }),
    });

    expect(outcome).toEqual({ ok: true });
    const written = writeProfile.mock.calls[0]?.[0];
    expect(written?.user_id).toBe(OWNER_ID);
    expect(written?.saved_makeup).toEqual({ categories: SAVED_CATEGORIES });
    // Only the one column moves: nothing about the reading or the palette
    // changes because a person chose a lipstick.
    expect(Object.keys(written ?? {})).toEqual(["user_id", "saved_makeup"]);
  });

  it("refuses a session with no profile rather than writing one", async () => {
    readProfile.mockResolvedValue(null);

    const outcome = await saveMakeupLook({
      session: SESSION,
      params: makeupRenderParamsSchema.parse({ categories: SAVED_CATEGORIES }),
    });

    expect(outcome).toEqual({ ok: false, reason: "no_profile" });
    expect(writeProfile).not.toHaveBeenCalled();
  });

  it("refuses the demo profile, which is read only", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";

    const outcome = await saveMakeupLook({
      session: SESSION,
      params: makeupRenderParamsSchema.parse({ categories: SAVED_CATEGORIES }),
    });

    expect(outcome).toEqual({ ok: false, reason: "fixture_read_only" });
    expect(writeProfile).not.toHaveBeenCalled();
    expect(readProfile).not.toHaveBeenCalled();
  });
});
