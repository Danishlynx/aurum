import "server-only";

import type { ColorView, MakeupView } from "@/lib/shared/color-view";
import {
  concernDescription,
  concernDisplayName,
  CONCERNS_REQUIRING_ESCALATION_LINE,
  isConcernKey,
  type ConcernKey,
} from "@/lib/shared/concerns";
import { derivePalette, type Palette, type Undertone } from "@/lib/shared/palette";
import type { ConcernView, ReportView } from "@/lib/shared/report-view";

import type { StoredConcern } from "./db";
import { buildDeterministicRoutine, buildGoingWell } from "./fallback";
import { factsFromStoredProfile } from "./facts";
import { buildMakeupCategoryViews } from "./shades";

/**
 * The report the app serves when AURUM_DEMO_FIXTURE is "true".
 *
 * Why it exists: there is no Supabase project and no provider key yet, so the
 * report screen has to be buildable, viewable, and screenshotable from checked
 * in data alone. With the switch on, buildReportView returns this and touches
 * neither the database nor a provider.
 *
 * SYNTHETIC. This is not a person. The scores below are hand written to the
 * shape one analysis set produces, and they match the deep warm, pigmentation
 * led fixture in evals/fixtures/analyses (a09), which the eval suite asserts.
 *
 * Two things are deliberately absent, and both are honesty rather than
 * omission:
 *
 * 1. Every product is null. A product is only ever shown with a real listing
 *    that came back with a URL and a price (docs/06-safety-privacy.md,
 *    "Grounding and honesty"), and with no SerpApi key nothing real has been
 *    fetched. The report renders the "No listing found near you yet" state,
 *    which is the true state. Open item: once a key exists, record real
 *    listings for these seven queries and put them here.
 * 2. captureImageUrl is null. No fixture face is checked in: every face in this
 *    repository needs a written consent record (evals/fixtures/README.md).
 *
 * The reading is the example docs/01-user-flow.md section F item 2 gives as the
 * standard, quoted word for word. readingSource is "fallback" because no model
 * wrote it, and calling it "model" would be a small lie in the one place the app
 * promises not to tell one.
 */

/** docs/01-user-flow.md section F item 2, "Example of the standard". */
export const DEMO_FIXTURE_READING =
  "Your skin is combination: oilier through the T zone, drier on the cheeks. " +
  "The main thing worth attention is pigmentation on the cheekbones and around the mouth, " +
  "common on deeper skin and very responsive to consistent care. " +
  "Your texture and pores are in good shape.";

/** The capture id the fixture pretends to have come from. */
export const DEMO_FIXTURE_CAPTURE_ID = "fixture-a09";

export const DEMO_FIXTURE_FITZPATRICK = 5;
export const DEMO_FIXTURE_SKIN_TONE_HEX = "#6b4a2f";
export const DEMO_FIXTURE_SKIN_AGE = 31;
export const DEMO_FIXTURE_EYE_COLOR_HEX = "#3b2b22";
export const DEMO_FIXTURE_HAIR_COLOR_HEX = "#1e1613";
export const DEMO_FIXTURE_UNDERTONE: Undertone = "warm";

/**
 * Ranked tone first for Fitzpatrick V, which is why dark spots at 62 sit above
 * wrinkles at 66: the two are within the comparable band, so the tone concern
 * takes the higher rank (src/lib/shared/concerns.ts).
 */
export const DEMO_FIXTURE_CONCERNS: readonly StoredConcern[] = [
  { key: "pigmentation", score: 71, rank: 1, mask_path: null },
  { key: "dark_spots", score: 62, rank: 2, mask_path: null },
  { key: "wrinkles", score: 66, rank: 3, mask_path: null },
  { key: "oiliness", score: 58, rank: 4, mask_path: null },
  { key: "dark_circles", score: 47, rank: 5, mask_path: null },
  { key: "redness", score: 41, rank: 6, mask_path: null },
  { key: "acne", score: 38, rank: 7, mask_path: null },
  { key: "firmness", score: 36, rank: 8, mask_path: null },
  { key: "eye_bags", score: 33, rank: 9, mask_path: null },
  { key: "pores", score: 24, rank: 10, mask_path: null },
  { key: "texture", score: 20, rank: 11, mask_path: null },
];

const DEMO_FIXTURE_ZONES = { tZone: "oily", cheeks: "dry" } as const;

const facts = factsFromStoredProfile({
  captureId: DEMO_FIXTURE_CAPTURE_ID,
  concerns: DEMO_FIXTURE_CONCERNS,
  zones: DEMO_FIXTURE_ZONES,
  skinAge: DEMO_FIXTURE_SKIN_AGE,
  fitzpatrick: DEMO_FIXTURE_FITZPATRICK,
  skinToneHex: DEMO_FIXTURE_SKIN_TONE_HEX,
  eyeColorHex: DEMO_FIXTURE_EYE_COLOR_HEX,
  hairColorHex: DEMO_FIXTURE_HAIR_COLOR_HEX,
  undertone: DEMO_FIXTURE_UNDERTONE,
  faceShape: "Oval",
});

function concernViews(): ConcernView[] {
  const views: ConcernView[] = [];
  for (const concern of DEMO_FIXTURE_CONCERNS) {
    if (!isConcernKey(concern.key)) {
      continue;
    }
    const key: ConcernKey = concern.key;
    views.push({
      key,
      label: concernDisplayName(key),
      description: concernDescription(key),
      score: concern.score,
      rank: views.length + 1,
      maskUrl: null,
    });
  }
  return views;
}

const routine = buildDeterministicRoutine(facts);

/**
 * The fixture report. Frozen, because it is module level state that several
 * requests read and nothing is allowed to mutate it.
 */
export const DEMO_FIXTURE_REPORT_VIEW: ReportView = Object.freeze({
  captureImageUrl: null,
  concerns: concernViews(),
  reading: DEMO_FIXTURE_READING,
  readingSource: "fallback",
  goingWell: buildGoingWell(facts),
  toneReadingAvailable: true,
  skinTypeZones: { tZone: DEMO_FIXTURE_ZONES.tZone, cheeks: DEMO_FIXTURE_ZONES.cheeks },
  skinAge: DEMO_FIXTURE_SKIN_AGE,
  showDermatologistLine: DEMO_FIXTURE_CONCERNS.some(
    (concern) =>
      isConcernKey(concern.key) &&
      CONCERNS_REQUIRING_ESCALATION_LINE.includes(concern.key),
  ),
  routine: {
    morning: routine.morning.map((step) => ({
      stepName: step.stepName,
      concernKey: step.concernKey,
      concernLabel: step.concernLabel,
      why: step.why,
      productQuery: step.productQuery,
      product: null,
    })),
    night: routine.night.map((step) => ({
      stepName: step.stepName,
      concernKey: step.concernKey,
      concernLabel: step.concernLabel,
      why: step.why,
      productQuery: step.productQuery,
      product: null,
    })),
  },
});

/**
 * The fixture palette.
 *
 * Derived by the real derivePalette from the fixture's own tone, undertone, eye
 * colour, hair colour, and Fitzpatrick type, never written out by hand. The
 * fixture and the mapping therefore cannot drift: a change to the palette rules
 * changes this too, and eval:palette sees the same numbers the demo screen does.
 */
export const DEMO_FIXTURE_PALETTE: Palette = derivePalette({
  skinToneHex: DEMO_FIXTURE_SKIN_TONE_HEX,
  undertone: DEMO_FIXTURE_UNDERTONE,
  eyeColorHex: DEMO_FIXTURE_EYE_COLOR_HEX,
  hairColorHex: DEMO_FIXTURE_HAIR_COLOR_HEX,
  fitzpatrick: DEMO_FIXTURE_FITZPATRICK,
});

/** The fixture /color screen. undertoneSource is "detected" because it was. */
export const DEMO_FIXTURE_COLOR_VIEW: ColorView = Object.freeze({
  skinToneHex: DEMO_FIXTURE_SKIN_TONE_HEX,
  undertone: DEMO_FIXTURE_UNDERTONE,
  undertoneSource: "detected",
  palette: DEMO_FIXTURE_PALETTE,
});

/**
 * The fixture /makeup screen.
 *
 * Two absences, both honest rather than unfinished, and both the same ones the
 * fixture report carries:
 *
 * 1. captureImageUrl is null. No fixture face is checked in, so there is no
 *    selfie to put a try on on. The screen shows its "Preview unavailable for
 *    this shade." state (docs/01-user-flow.md section H), which is the true
 *    state: with no Perfect Corp key nothing has been rendered, and a stand in
 *    image would be a made up try on.
 * 2. product is null. Nothing has been fetched from SerpApi, so every row shows
 *    "No listing found near you yet" rather than an invented product.
 *
 * The shade rows themselves are real: they come from the same
 * buildMakeupCategoryViews the live screen uses, over the fixture palette.
 */
export const DEMO_FIXTURE_MAKEUP_VIEW: MakeupView = Object.freeze({
  captureImageUrl: null,
  categories: buildMakeupCategoryViews({
    palette: DEMO_FIXTURE_PALETTE,
    skinToneHex: DEMO_FIXTURE_SKIN_TONE_HEX,
  }),
  product: null,
});
