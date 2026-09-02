import { beforeEach, describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts: this replaces the marker. */
vi.mock("server-only", () => ({}));

/**
 * The database behind the colour layer, replaced by two functions that remember
 * what they were handed. Nothing here reaches Supabase, so the whole file runs
 * on a clean clone with no project and no keys.
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

import {
  confirmUndertone,
  paletteForProfile,
  parseUndertoneSource,
} from "@/lib/server/profile/color";
import {
  getAestheticProfile,
  upsertAestheticProfile,
  type AestheticProfile,
} from "@/lib/server/profile/db";
import {
  DEMO_FIXTURE_COLOR_VIEW,
  DEMO_FIXTURE_CONCERNS,
  DEMO_FIXTURE_EYE_COLOR_HEX,
  DEMO_FIXTURE_HAIR_COLOR_HEX,
  DEMO_FIXTURE_FITZPATRICK,
  DEMO_FIXTURE_PALETTE,
  DEMO_FIXTURE_SKIN_TONE_HEX,
} from "@/lib/server/profile/demo-fixture";
import { DEMO_FIXTURE_ENV } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import type { Json } from "@/lib/server/db/types";
import { FALLBACK_READING_MODEL } from "@/lib/server/profile/fallback";
import { DEEP_SEASONS, type Palette } from "@/lib/shared/palette";

import { loadGoldenPalette, loadProfileFixture } from "../fixtures/profiles";

/**
 * The Layer 2 definition of done, first half: "Adjusting undertone changes the
 * palette and re renders the hero" (docs/09-build-order-and-demo.md).
 *
 * The screen half of that is a server component that re reads GET
 * /api/profile/color after the save, so what has to be proven here is the write:
 * a confirmed undertone is stored as confirmed, the season and the palette are
 * derived again from it, and the reading is written again with it
 * (docs/03-architecture.md, "Caching": the synthesis is regenerated when the
 * person adjusts undertone).
 *
 * Why this is a unit test and not an end to end one: fixture mode is read only
 * by construction. AURUM_DEMO_FIXTURE serves a checked in profile and has no
 * database behind it, so POST /api/profile/undertone answers 403 with
 * messages.demoProfileReadOnly rather than pretending to save. Writing to
 * nothing and reporting success is the one thing this route must not do, so the
 * write path is exercised here, against the real derivation and the real
 * synthesis fallback, with only the two database calls replaced.
 */

const readProfile = vi.mocked(getAestheticProfile);
const writeProfile = vi.mocked(upsertAestheticProfile);

/**
 * A judge session, because readFirstName returns null for one without asking
 * Supabase for a display name. The reading it produces is the deterministic
 * fallback either way (no ANTHROPIC_API_KEY on a clean clone).
 */
const SESSION: AppSession = {
  kind: "judge",
  id: "judge-session-1",
  ownerType: "judge_session",
  session: {
    id: "judge-session-1",
    code_hash: "not a real hash",
    expires_at: "2026-12-31T00:00:00.000Z",
    analyses_allowed: 3,
    analyses_used: 1,
    credits_cap: 60,
    credits_used: 12,
    last_seen_at: null,
    consent_at: "2026-01-01T00:00:00.000Z",
    consent_version: "2026-01-01",
    is_adult_confirmed: true,
    keep_originals: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
};

/** The deep warm coloring, the same one the demo fixture and a09 carry. */
function profileRow(overrides: Partial<AestheticProfile> = {}): AestheticProfile {
  return {
    user_id: SESSION.id,
    capture_id: "capture-a09",
    skin_type_zones: { t_zone: "oily", cheeks: "dry" } as unknown as Json,
    concerns: DEMO_FIXTURE_CONCERNS as unknown as Json,
    skin_age: 31,
    fitzpatrick: DEMO_FIXTURE_FITZPATRICK,
    skin_tone_hex: DEMO_FIXTURE_SKIN_TONE_HEX,
    undertone: "warm",
    undertone_source: "detected",
    eye_color_hex: DEMO_FIXTURE_EYE_COLOR_HEX,
    hair_color_hex: DEMO_FIXTURE_HAIR_COLOR_HEX,
    face_shape: "Oval",
    hair_type: null,
    saved_hair_style_id: null,
    saved_hair_color_name: null,
    saved_makeup: null,
    season: "deep_autumn",
    palette: null,
    reading: "An older reading, written before the undertone was confirmed.",
    reading_model: FALLBACK_READING_MODEL,
    version: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env[DEMO_FIXTURE_ENV];
});

/* ------------------------------------------------------------------ */
/* The pure half: the palette a stored row derives                     */
/* ------------------------------------------------------------------ */

describe("paletteForProfile", () => {
  it("derives the season from the stored coloring", () => {
    const palette = paletteForProfile(profileRow());
    expect(palette?.season).toBe("deep_autumn");
    expect(palette?.seasonDisplayName).toBe("Deep Autumn");
  });

  it("gives a different palette for a different undertone", () => {
    const warm = paletteForProfile(profileRow({ undertone: "warm" }));
    const cool = paletteForProfile(profileRow({ undertone: "cool" }));
    const neutral = paletteForProfile(profileRow({ undertone: "neutral" }));

    expect(warm?.season).toBe("deep_autumn");
    expect(cool?.season).toBe("deep_winter");
    // Deep coloring stays deep whichever way the undertone goes, which is the
    // tone first rule eval:palette asserts across the whole grid. Which of the
    // two deep seasons a neutral undertone lands in is the rule table's call,
    // not this test's, so it only asserts that it stays deep.
    expect(DEEP_SEASONS).toContain(neutral?.season);

    const names = (palette: Palette | null): string =>
      (palette?.wear ?? []).map((color) => color.name).join(",");
    expect(names(warm)).not.toBe(names(cool));
    expect(names(warm).length).toBeGreaterThan(0);
  });

  it("has no palette when the photo gave no tone or no undertone", () => {
    expect(paletteForProfile(profileRow({ skin_tone_hex: null }))).toBeNull();
    expect(paletteForProfile(profileRow({ undertone: null }))).toBeNull();
    // A stored value that is not one of the three reads as no undertone.
    expect(paletteForProfile(profileRow({ undertone: "olive" }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The demo profile and the golden it is supposed to be                */
/* ------------------------------------------------------------------ */

describe("the demo fixture palette", () => {
  /**
   * evals/fixtures/profiles/deep-warm.json says its coloring is copied from the
   * analysis set demo-fixture.ts is built from, "so the palette this profile
   * produces is the palette the demo profile shows on /color". That sentence is
   * only true while it is checked, and the demo profile is what the screenshots,
   * the e2e specs, and the judges see.
   */
  it("is the deep warm golden, derived by the same function", () => {
    const golden = loadGoldenPalette(loadProfileFixture("deep-warm"));
    expect(DEMO_FIXTURE_PALETTE).toEqual(golden);
    expect(DEMO_FIXTURE_COLOR_VIEW.palette).toEqual(golden);
    // The screen reads the undertone as detected, not as one the person
    // confirmed, because nobody confirmed it.
    expect(DEMO_FIXTURE_COLOR_VIEW.undertoneSource).toBe("detected");
    expect(DEMO_FIXTURE_COLOR_VIEW.skinToneHex).toBe(DEMO_FIXTURE_SKIN_TONE_HEX);
  });
});

describe("parseUndertoneSource", () => {
  it("reads the two the data model allows and nothing else", () => {
    expect(parseUndertoneSource("detected")).toBe("detected");
    expect(parseUndertoneSource("confirmed_by_user")).toBe("confirmed_by_user");
    expect(parseUndertoneSource("guessed")).toBeNull();
    expect(parseUndertoneSource(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The write: what the adjuster does to the profile                    */
/* ------------------------------------------------------------------ */

describe("confirmUndertone", () => {
  it("stores the confirmed undertone and the palette derived from it", async () => {
    readProfile.mockResolvedValue(profileRow());

    const outcome = await confirmUndertone({
      session: SESSION,
      undertone: "cool",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.season).toBe("deep_winter");
    expect(outcome.paletteChanged).toBe(true);

    expect(writeProfile).toHaveBeenCalledTimes(1);
    const row = writeProfile.mock.calls[0]?.[0];
    expect(row?.undertone).toBe("cool");
    // docs/01-user-flow.md section G item 2: the person's answer is recorded as
    // theirs, so a later rebuild cannot overwrite it with a detected one.
    expect(row?.undertone_source).toBe("confirmed_by_user");
    expect(row?.season).toBe("deep_winter");
    expect(row?.version).toBe(4);

    // The palette column holds the palette the new undertone derives, not the
    // one that was on the row before.
    const stored = row?.palette as unknown as Palette;
    expect(stored.season).toBe("deep_winter");
    expect(stored.wear.length).toBeGreaterThanOrEqual(8);
    expect(stored.avoid.length).toBeGreaterThanOrEqual(4);
    expect(stored.wear.map((color) => color.name)).not.toEqual(
      paletteForProfile(profileRow())?.wear.map((color) => color.name),
    );
  });

  it("writes the reading again, deterministically when there is no key", async () => {
    const before = profileRow();
    readProfile.mockResolvedValue(before);

    const outcome = await confirmUndertone({
      session: SESSION,
      undertone: "neutral",
    });

    expect(outcome.ok && outcome.readingRegenerated).toBe(true);
    const row = writeProfile.mock.calls[0]?.[0];
    expect(typeof row?.reading).toBe("string");
    expect(row?.reading).not.toBe(before.reading);
    // No ANTHROPIC_API_KEY on a clean clone, so the pipeline falls back rather
    // than calling out, and says so in the column that records which wrote it.
    expect(row?.reading_model).toBe(FALLBACK_READING_MODEL);
  });

  it("stores the answer but derives no palette when there is no tone", async () => {
    readProfile.mockResolvedValue(profileRow({ skin_tone_hex: null }));

    const outcome = await confirmUndertone({
      session: SESSION,
      undertone: "warm",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    // An undertone alone cannot produce a season, and reporting one nobody
    // derived would be an invented palette.
    expect(outcome.season).toBeNull();
    expect(outcome.paletteChanged).toBe(false);

    const row = writeProfile.mock.calls[0]?.[0];
    expect(row?.undertone).toBe("warm");
    expect(row?.undertone_source).toBe("confirmed_by_user");
    expect(row?.season).toBeNull();
    expect(row?.palette).toBeNull();
  });

  it("says so rather than writing when there is no profile yet", async () => {
    readProfile.mockResolvedValue(null);

    const outcome = await confirmUndertone({
      session: SESSION,
      undertone: "cool",
    });

    expect(outcome).toEqual({ ok: false, reason: "no_profile" });
    expect(writeProfile).not.toHaveBeenCalled();
  });

  it("refuses to pretend a fixture profile was saved", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";

    const outcome = await confirmUndertone({
      session: SESSION,
      undertone: "cool",
    });

    expect(outcome).toEqual({ ok: false, reason: "fixture_read_only" });
    expect(readProfile).not.toHaveBeenCalled();
    expect(writeProfile).not.toHaveBeenCalled();
  });
});
