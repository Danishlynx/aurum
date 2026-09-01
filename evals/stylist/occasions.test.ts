import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React Server Component. The same replacement the other eval suites use.
 */
vi.mock("server-only", () => ({}));

import { buildLooksView } from "@/lib/server/looks/compose";
import { DEMO_FIXTURE_PALETTE } from "@/lib/server/profile/demo-fixture";
import { DEMO_FIXTURE_WARDROBE } from "@/lib/server/profile/demo-fixture-wardrobe";
import { DEMO_FIXTURE_ENV } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import {
  composeCandidates,
  OCCASIONS,
  type Candidate,
  type Occasion,
} from "@/lib/shared/looks";
import { derivePalette, type Palette } from "@/lib/shared/palette";
import type { GarmentView } from "@/lib/shared/wardrobe-view";

import { loadDemoWardrobeViews } from "../fixtures/garments";
import { loadProfileFixtures, paletteInputOf } from "../fixtures/profiles";

/**
 * eval:stylist, the occasion coverage half.
 *
 * Spec: docs/09-build-order-and-demo.md Layer 5, definition of done: "Every
 * occasion produces at least one look on the demo profile."
 *
 * That sentence is about the demo profile, not about the twenty garment fixture
 * set, so it is checked three ways, on the three things that are actually the
 * demo profile in this repository:
 *
 *   1. the six garment demo wardrobe in evals/fixtures/garments (labels.json,
 *      inDemoWardrobe), against the deep warm profile fixture's palette,
 *   2. DEMO_FIXTURE_WARDROBE, which is what the app serves for /wardrobe with
 *      AURUM_DEMO_FIXTURE=true, against DEMO_FIXTURE_PALETTE,
 *   3. buildLooksView itself, in fixture mode, which is the path the /looks
 *      screen and GET /api/looks take for a judge.
 *
 * The two wardrobes carry the same six garments and disagree about two of their
 * formality labels (the navy blazer and the rust knit), which is exactly why
 * both are checked rather than one standing in for the other. Recorded as an
 * open item for the human in the results file below.
 *
 * Nothing here spends anything: the rules engine is pure, the fixture path
 * touches neither the database nor a provider, and no model is called.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(HERE, "..", "results");

const EVAL_DEMO_WARDROBE: GarmentView[] = loadDemoWardrobeViews();
const APP_DEMO_WARDROBE: readonly GarmentView[] = DEMO_FIXTURE_WARDROBE.garments;

/** The demo profile's coloring: deep warm, the palette /looks reads in the demo. */
const DEMO_PALETTE: Palette = (() => {
  const found = loadProfileFixtures().find((profile) => profile.id === "deep-warm");
  if (found === undefined) {
    throw new Error("The deep warm profile fixture is missing");
  }
  return derivePalette(paletteInputOf(found));
})();

/**
 * The fixture path answers before it reads a session, so this is only a shape
 * the signature asks for. Same stand in as src/app/api/profile/color/route.ts.
 */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

function candidatesFor(
  garments: readonly GarmentView[],
  occasion: Occasion,
  palette: Palette,
): Candidate[] {
  return composeCandidates({ garments, palette, occasion });
}

/* ------------------------------------------------------------------ */
/* The results file                                                     */
/* ------------------------------------------------------------------ */

type OccasionRow = {
  occasion: Occasion;
  evalWardrobeLooks: number;
  appWardrobeLooks: number;
  fixturePathLooks: number;
  gaps: string[];
};

const summary: {
  suite: string;
  synthetic: boolean;
  note: string;
  openItem: string;
  occasions: OccasionRow[];
} = {
  suite: "stylist-occasions",
  synthetic: true,
  note: "Rules only. No model was called, no provider was reached, and no credit was spent. docs/09 Layer 5 definition of done: every occasion produces at least one look on the demo profile.",
  openItem:
    "evals/fixtures/garments/labels.json and src/lib/server/profile/demo-fixture-wardrobe.ts describe the same six garments with two different formality labels (g01 blazer: smart against formal, g06 rust knit: casual against smart). Both are covered here. The human decides which label is right and the two files are then written to agree.",
  occasions: [],
};

afterAll(() => {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const sha = process.env.GITHUB_SHA ?? process.env.AURUM_BUILD_SHA ?? "local";
    writeFileSync(
      resolve(RESULTS_DIR, `stylist-occasions-${sha}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // docs/05-evals.md asks for a results file. Not being able to write one is
    // not a reason to fail the suite that produced the numbers.
  }
});

/* ------------------------------------------------------------------ */
/* Layer 5 definition of done                                          */
/* ------------------------------------------------------------------ */

describe("every occasion dresses the demo profile", () => {
  it("composes a look for all six occasions from the eval demo wardrobe", () => {
    expect(EVAL_DEMO_WARDROBE).toHaveLength(6);
    for (const occasion of OCCASIONS) {
      const candidates = candidatesFor(
        EVAL_DEMO_WARDROBE,
        occasion,
        DEMO_PALETTE,
      );
      expect(
        candidates.length,
        `the eval demo wardrobe has no ${occasion} look`,
      ).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(
          candidate.garmentIds.length,
          `${candidate.id} holds no garment`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("composes a look for all six occasions from the wardrobe the app serves", () => {
    expect(APP_DEMO_WARDROBE).toHaveLength(6);
    for (const occasion of OCCASIONS) {
      const candidates = candidatesFor(
        APP_DEMO_WARDROBE,
        occasion,
        DEMO_FIXTURE_PALETTE,
      );
      expect(
        candidates.length,
        `the app demo wardrobe has no ${occasion} look`,
      ).toBeGreaterThan(0);
    }
  });

  it("never answers an occasion with a look that has no piece in it", () => {
    for (const occasion of OCCASIONS) {
      for (const wardrobe of [EVAL_DEMO_WARDROBE, APP_DEMO_WARDROBE]) {
        const palette =
          wardrobe === EVAL_DEMO_WARDROBE ? DEMO_PALETTE : DEMO_FIXTURE_PALETTE;
        for (const candidate of candidatesFor(wardrobe, occasion, palette)) {
          expect(candidate.garmentIds.length).toBeGreaterThan(0);
          // A look is only ever built from garments the person owns, so every id
          // in it has to be one of theirs.
          for (const id of candidate.garmentIds) {
            expect(wardrobe.map((garment) => garment.id)).toContain(id);
          }
        }
      }
    }
  });
});

describe("the fixture looks path, which is what a judge sees", () => {
  /**
   * The switch is set here and put back afterwards. A worker runs several suites
   * in one process, so a file that turns fixture mode on and walks away turns it
   * on for whatever runs next.
   */
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env[DEMO_FIXTURE_ENV];
    process.env[DEMO_FIXTURE_ENV] = "true";
  });

  afterAll(() => {
    if (previous === undefined) {
      delete process.env[DEMO_FIXTURE_ENV];
    } else {
      process.env[DEMO_FIXTURE_ENV] = previous;
    }
  });

  it("serves at least one look for every occasion, with a rationale each", async () => {
    for (const occasion of OCCASIONS) {
      const view = await buildLooksView(FIXTURE_SESSION, occasion);
      expect(view.occasion).toBe(occasion);
      expect(
        view.looks.length,
        `the fixture serves no ${occasion} look`,
      ).toBeGreaterThan(0);
      // The demo profile owns six garments, so the "No wardrobe" line never
      // shows on it.
      expect(view.wardrobeEmpty).toBe(false);
      for (const look of view.looks) {
        expect(look.items.length).toBeGreaterThan(0);
        expect(look.rationale.length).toBeGreaterThan(0);
        // Nothing has been rendered and no listing has been recorded, which is
        // the honest state and must stay honest.
        expect(look.renderUrl).toBeNull();
        expect(look.rationaleSource).toBe("rules");
      }
    }
  });

  it("records what each occasion produced, for the PR description", async () => {
    for (const occasion of OCCASIONS) {
      const view = await buildLooksView(FIXTURE_SESSION, occasion);
      const evalCandidates = candidatesFor(
        EVAL_DEMO_WARDROBE,
        occasion,
        DEMO_PALETTE,
      );
      const appCandidates = candidatesFor(
        APP_DEMO_WARDROBE,
        occasion,
        DEMO_FIXTURE_PALETTE,
      );
      summary.occasions.push({
        occasion,
        evalWardrobeLooks: evalCandidates.length,
        appWardrobeLooks: appCandidates.length,
        fixturePathLooks: view.looks.length,
        gaps: [
          ...new Set(appCandidates.flatMap((candidate) => candidate.gaps)),
        ],
      });
    }
    expect(summary.occasions).toHaveLength(OCCASIONS.length);
  });
});

/* ------------------------------------------------------------------ */
/* Why a gap beats an empty screen                                     */
/* ------------------------------------------------------------------ */

describe("a wardrobe that is short of the occasion", () => {
  /**
   * The rule Layer 5 writes down: an occasion the wardrobe cannot dress
   * completely answers with a look that names what is missing, rather than with
   * nothing. A gap list is shoppable (docs/01-user-flow.md section K item 3);
   * an empty screen is not.
   */
  it("answers a formal evening with a gap when nothing formal is owned", () => {
    const nothingFormal = EVAL_DEMO_WARDROBE.filter(
      (garment) => garment.formality !== "formal",
    );
    const candidates = candidatesFor(
      nothingFormal,
      "formal_evening",
      DEMO_PALETTE,
    );
    expect(candidates.length).toBeGreaterThan(0);
    const first = candidates[0];
    expect(first).toBeDefined();
    expect(first?.garmentIds.length).toBeGreaterThan(0);
    // The missing piece is named in the words "Shop the gap" searches with.
    expect(first?.gaps).toContain("shoes");
  });

  it("still returns nothing when there is nothing at all to compose from", () => {
    // An empty wardrobe is a different state with its own screen: /looks builds
    // from live listings instead (docs/01 section K, "No wardrobe"). The rules
    // must keep saying nothing here rather than inventing a piece.
    for (const occasion of OCCASIONS) {
      expect(
        composeCandidates({ garments: [], palette: DEMO_PALETTE, occasion }),
      ).toEqual([]);
    }
  });
});
