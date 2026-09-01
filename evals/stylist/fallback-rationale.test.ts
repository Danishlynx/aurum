import { describe, expect, it, vi } from "vitest";

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React Server Component. The same replacement the eval suites use.
 */
vi.mock("server-only", () => ({}));

import { DEMO_FIXTURE_PALETTE } from "@/lib/server/profile/demo-fixture";
import { DEMO_FIXTURE_WARDROBE } from "@/lib/server/profile/demo-fixture-wardrobe";
import {
  buildListingLookRationale,
  buildRulesRationale,
  coloringSentence,
  occasionSentence,
} from "@/lib/server/looks/rationale";
import { checkLexicon, describeViolation } from "@/lib/shared/lexicon";
import {
  composeCandidates,
  OCCASIONS,
  type LooksGarment,
  type Occasion,
} from "@/lib/shared/looks";
import { derivePalette, type Palette } from "@/lib/shared/palette";

import { checkRationale, countSentences } from "./rationale";

/**
 * eval:stylist, the fallback half.
 *
 * evals/stylist/stylist.test.ts proves the rules engine and the hard checks a
 * model rationale has to pass. This file proves the sentence the app writes when
 * there is no model at all, which is the state this build actually ships in:
 * there is no ANTHROPIC_API_KEY, so every rationale on every screen today comes
 * from src/lib/server/looks/rationale.ts.
 *
 * It lives here rather than beside that module because the lint rule requires
 * every file under src/lib/server to open with the server-only import, which a
 * test cannot do, and because this is the suite whose subject it is.
 *
 * The deterministic rationale, docs/03-architecture.md: "the stylist ranks looks
 * by the rules alone with a one line rule based rationale".
 *
 * What is asserted here, and why each one matters:
 *
 * 1. It is one or two sentences, never three and never zero.
 * 2. It is lexicon clean, including when a garment colour name is not (a colour
 *    name is data from the classifier or typed by a person, so it is the one
 *    part of the sentence nobody wrote as copy).
 * 3. It names the occasion, and it names the person's colouring when there is a
 *    palette to name it from. That is the standard docs/04-integrations.md sets
 *    for the model, and the fallback is held to it by running the same checker
 *    the eval suite runs.
 * 4. It says less when it knows less: no palette means no colour sentence, never
 *    an invented season.
 */

const WARDROBE = DEMO_FIXTURE_WARDROBE.garments;

function candidatesFor(occasion: Occasion) {
  return composeCandidates({
    garments: WARDROBE,
    palette: DEMO_FIXTURE_PALETTE,
    occasion,
  });
}

function rationaleFor(occasion: Occasion, index = 0): string {
  const candidate = candidatesFor(occasion)[index];
  expect(candidate, `no candidate ${index} for ${occasion}`).toBeDefined();
  if (candidate === undefined) {
    throw new Error("unreachable");
  }
  const garments = candidate.garmentIds
    .map((id) => WARDROBE.find((garment) => garment.id === id))
    .filter((garment): garment is (typeof WARDROBE)[number] => garment !== undefined);

  return buildRulesRationale({
    occasion,
    palette: DEMO_FIXTURE_PALETTE,
    garments,
    ruleNotes: candidate.ruleNotes,
    gaps: candidate.gaps,
  });
}

function violationsOf(text: string): string[] {
  return checkLexicon(text).map(describeViolation);
}

describe("the rules rationale over the demo wardrobe", () => {
  it("writes one for every occasion the fixture wardrobe can dress", () => {
    let written = 0;
    for (const occasion of OCCASIONS) {
      for (const [index] of candidatesFor(occasion).entries()) {
        const rationale = rationaleFor(occasion, index);
        expect(rationale.length, `${occasion} look ${index + 1}`).toBeGreaterThan(0);
        expect(violationsOf(rationale), `${occasion} look ${index + 1}`).toEqual([]);
        const sentences = countSentences(rationale);
        expect(sentences).toBeGreaterThanOrEqual(1);
        expect(sentences).toBeLessThanOrEqual(2);
        expect(rationale.endsWith(".")).toBe(true);
        written += 1;
      }
    }
    expect(written).toBeGreaterThan(5);
  });

  it("passes the same hard checks the model output is held to", () => {
    // Two sentences, names the occasion, references the coloring, no numbers,
    // no superlatives (docs/05-evals.md, suite eval:stylist).
    for (const occasion of OCCASIONS) {
      for (const [index] of candidatesFor(occasion).entries()) {
        const rationale = rationaleFor(occasion, index);
        expect(
          checkRationale(rationale, {
            occasion,
            palette: DEMO_FIXTURE_PALETTE,
          }),
          `${occasion} look ${index + 1}: "${rationale}"`,
        ).toEqual([]);
      }
    }
  });

  it("names the wear colour and the layer for the wedding guest look", () => {
    const rationale = rationaleFor("wedding_guest");
    expect(rationale).toContain("Cream");
    expect(rationale).toContain("Deep Autumn");
    expect(rationale).toContain("a wedding");
  });

  it("names the interview by name, on the same wardrobe", () => {
    expect(rationaleFor("interview")).toContain("an interview");
  });
});

describe("the rules rationale when there is less to say", () => {
  const shirt: LooksGarment = {
    id: "g-shirt",
    type: "shirt",
    colors: [{ name: "Cream", hex: "#efe3cb" }],
    pattern: "solid",
    formality: "smart",
  };

  it("drops the colour sentence when there is no palette", () => {
    const input = {
      occasion: "interview" as const,
      palette: null,
      garments: [shirt],
      ruleNotes: ["every piece here reads smart"],
      gaps: [],
    };
    expect(coloringSentence(input)).toBeNull();
    const rationale = buildRulesRationale(input);
    expect(countSentences(rationale)).toBe(1);
    expect(rationale).toBe("For an interview, every piece here reads smart.");
  });

  it("still names the occasion when the rules established nothing", () => {
    const rationale = buildRulesRationale({
      occasion: "festival",
      palette: null,
      garments: [],
      ruleNotes: [],
      gaps: [],
    });
    expect(rationale).toBe(
      "For a festival, these are the pieces you own that fit.",
    );
  });

  it("never ends on a gap, because the shop the gap card says that itself", () => {
    const sentence = occasionSentence({
      occasion: "wedding_guest",
      palette: DEMO_FIXTURE_PALETTE,
      garments: [shirt],
      ruleNotes: ["every piece here reads smart", "you do not own shoes yet"],
      gaps: ["shoes"],
    });
    expect(sentence).toBe("For a wedding, every piece here reads smart.");
  });

  it("says the palette claims nothing rather than claiming it does", () => {
    const sentence = coloringSentence({
      occasion: "date",
      palette: DEMO_FIXTURE_PALETTE,
      garments: [
        {
          id: "g-neither",
          type: "shirt",
          // A colour no season in the catalog is near, so the honest answer is
          // that the palette has nothing to say about it.
          colors: [{ name: "Neon lime", hex: "#c8ff00" }],
          pattern: "solid",
          formality: "smart",
        },
      ],
      ruleNotes: [],
      gaps: [],
    });
    expect(sentence).toBe(
      "None of these colors sit in your Deep Autumn palette, so this look is put together on formality rather than color.",
    );
  });

  it("keeps a banned word in a garment colour name off the screen", () => {
    // A colour name is data from the classifier or typed by a person. This one
    // carries a hype word from the banned lexicon, so the sentence built around
    // it is dropped and the occasion sentence stands alone.
    const rationale = buildRulesRationale({
      occasion: "date",
      palette: DEMO_FIXTURE_PALETTE,
      garments: [
        {
          id: "g-hype",
          type: "shirt",
          colors: [{ name: "Magic cream", hex: "#efe3cb" }],
          pattern: "solid",
          formality: "smart",
        },
      ],
      ruleNotes: ["every piece here reads smart"],
      gaps: [],
    });
    expect(violationsOf(rationale)).toEqual([]);
    expect(rationale).toBe("For a date, every piece here reads smart.");
  });

  it("says an avoid colour is below the waist when that is the only colour fact", () => {
    const paletteWithAvoid: Palette = DEMO_FIXTURE_PALETTE;
    const avoidColor = paletteWithAvoid.avoid[0];
    expect(avoidColor).toBeDefined();
    if (avoidColor === undefined) {
      throw new Error("unreachable");
    }

    const sentence = coloringSentence({
      occasion: "everyday",
      palette: paletteWithAvoid,
      garments: [
        {
          id: "g-trousers",
          type: "trousers",
          colors: [{ name: avoidColor.name, hex: avoidColor.hex }],
          pattern: "solid",
          formality: "casual",
        },
      ],
      ruleNotes: [],
      gaps: [],
    });
    expect(sentence).toBe(
      `${avoidColor.name} stays below the waist, away from your face.`,
    );
  });
});

describe("the listing only look rationale", () => {
  it("says plainly that nothing here is the person's yet", () => {
    const rationale = buildListingLookRationale({
      occasion: "wedding_guest",
      palette: DEMO_FIXTURE_PALETTE,
      colorName: "Rust",
    });
    expect(violationsOf(rationale)).toEqual([]);
    expect(countSentences(rationale)).toBe(2);
    expect(rationale).toContain("Rust");
    expect(rationale).toContain(
      "every piece here is a live listing rather than something you own",
    );
    expect(
      checkRationale(rationale, {
        occasion: "wedding_guest",
        palette: DEMO_FIXTURE_PALETTE,
      }),
    ).toEqual([]);
  });

  it("drops the colour sentence when there is no palette to name one from", () => {
    const rationale = buildListingLookRationale({
      occasion: "festival",
      palette: null,
      colorName: null,
    });
    expect(countSentences(rationale)).toBe(1);
    expect(rationale).toContain("a festival");
  });

  it("works for a palette that is not the fixture's", () => {
    const lightCool = derivePalette({
      skinToneHex: "#f1d9c8",
      undertone: "cool",
      eyeColorHex: "#6b8fa3",
      hairColorHex: "#8a7358",
      fitzpatrick: 2,
    });
    const rationale = buildListingLookRationale({
      occasion: "date",
      palette: lightCool,
      colorName: lightCool.wear[0]?.name ?? "Cream",
    });
    expect(violationsOf(rationale)).toEqual([]);
    expect(rationale).toContain(lightCool.seasonDisplayName);
  });
});
