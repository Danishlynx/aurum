import { describe, expect, it } from "vitest";

import { checkLexicon, describeViolation } from "./lexicon";
import {
  ADJACENT_SLOT_PAIRS,
  BELOW_WAIST_SLOTS,
  BUSY_PATTERNS,
  composeCandidates,
  dominantColorOf,
  formalityFitsOccasion,
  garmentColorMatch,
  GAP_TYPE_OF_SLOT,
  GARMENT_SLOT_OF_TYPE,
  HERO_SLOT_PREFERENCE,
  isBusyPattern,
  isNearFaceSlot,
  matchToPalette,
  MAX_CANDIDATES,
  MAX_PER_SLOT,
  NEAR_FACE_SLOTS,
  OCCASION_RULES,
  OCCASIONS,
  paletteDistance,
  PALETTE_MATCH_MAX_DISTANCE,
  slotOfType,
  type Candidate,
  type LooksGarment,
  type Occasion,
} from "./looks";
import { paletteForSeason, type Palette } from "./palette";
import {
  FORMALITY,
  GARMENT_TYPES,
  PATTERNS,
  type GarmentFormality,
} from "./wardrobe-view";

/**
 * The looks rules engine, docs/09-build-order-and-demo.md Layer 4 and
 * docs/05-evals.md suite eval:stylist.
 *
 * This file proves the pieces: the slot table, the color match, the occasion
 * table, and the shape of what composeCandidates returns. evals/stylist runs the
 * same engine over the 20 garment fixture set and asserts the rules the eval
 * suite names. The split is the one the repository already uses for the palette:
 * the unit test owns the functions, the eval owns the fixtures.
 *
 * Every garment below is written by hand in this file. The rules engine reads
 * classifications, never pixels, so a wardrobe here is five fields.
 */

/** The demo profile's palette: deep autumn, from the deep warm fixture coloring. */
const DEEP_AUTUMN: Palette = paletteForSeason("deep_autumn");
const DEEP_WINTER: Palette = paletteForSeason("deep_winter");

type GarmentSpec = {
  id: string;
  type: string | null;
  hex?: string;
  colorName?: string;
  pattern?: string | null;
  formality?: GarmentFormality | null;
};

/** A garment in the shape the wardrobe hands over, with sensible defaults. */
function garment(spec: GarmentSpec): LooksGarment {
  return {
    id: spec.id,
    type: spec.type,
    colors:
      spec.hex === undefined
        ? []
        : [{ name: spec.colorName ?? "Test color", hex: spec.hex }],
    pattern: spec.pattern === undefined ? "solid" : spec.pattern,
    formality: spec.formality === undefined ? "smart" : spec.formality,
  };
}

/* Colors used across the tests, all read against the deep autumn palette. */
const CREAM = "#efe3cb"; // wear, exactly
const OLIVE = "#6b6b3a"; // wear, exactly
const RUST = "#9c4a1e"; // wear, exactly
const BROWN = "#5a3a24"; // wear, near chocolate
const COOL_GREY = "#b8bcc4"; // avoid, exactly
const ICY_PINK = "#f6dde8"; // avoid, exactly
const NAVY = "#1f2a44"; // neither: our deep autumn catalog holds nothing close

function expectCleanFragment(note: string): void {
  const violations = checkLexicon(note);
  expect(
    violations.map(describeViolation),
    `"${note}" is not lexicon clean`,
  ).toEqual([]);
  expect(note, `"${note}" has leading or trailing space`).toBe(note.trim());
  expect(note, `"${note}" has a doubled space`).not.toMatch(/ {2}/u);
  expect(note.endsWith("."), `"${note}" ends with a full stop`).toBe(false);
  expect(note[0], `"${note}" does not start in lower case`).toBe(
    note[0]?.toLowerCase(),
  );
  expect(note, `"${note}" still holds a vocabulary underscore`).not.toMatch(
    /_/u,
  );
}

function allNotes(candidates: readonly Candidate[]): string[] {
  return candidates.flatMap((candidate) => candidate.ruleNotes);
}

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

describe("slotOfType", () => {
  it("gives every garment type in the vocabulary a slot", () => {
    for (const type of GARMENT_TYPES) {
      expect(slotOfType(type), `${type} has no slot`).not.toBeNull();
    }
    expect(Object.keys(GARMENT_SLOT_OF_TYPE).sort()).toEqual(
      [...GARMENT_TYPES].sort(),
    );
  });

  it("puts a sweater next to the face and a blazer over the top of it", () => {
    expect(slotOfType("sweater")).toBe("top");
    expect(slotOfType("blazer")).toBe("outerwear");
    expect(slotOfType("jacket")).toBe("outerwear");
    expect(slotOfType("coat")).toBe("outerwear");
  });

  it("reads a skirt, jeans, and shorts as the same slot as trousers", () => {
    for (const type of ["skirt", "trousers", "jeans", "shorts"]) {
      expect(slotOfType(type)).toBe("bottom");
    }
  });

  it("returns null for a type we have no rules for, rather than a guess", () => {
    expect(slotOfType("kimono")).toBeNull();
    expect(slotOfType("")).toBeNull();
    expect(slotOfType(null)).toBeNull();
  });

  it("ignores case and surrounding space, because the column is model text", () => {
    expect(slotOfType("  Shirt ")).toBe("top");
    expect(slotOfType("T_SHIRT")).toBe("top");
  });
});

describe("the slot groups", () => {
  it("keeps the near face slots and the below waist slots apart", () => {
    for (const slot of NEAR_FACE_SLOTS) {
      expect(BELOW_WAIST_SLOTS).not.toContain(slot);
    }
    expect(NEAR_FACE_SLOTS.every(isNearFaceSlot)).toBe(true);
  });

  it("chooses the hero from the near face slots only", () => {
    for (const slot of HERO_SLOT_PREFERENCE) {
      expect(NEAR_FACE_SLOTS).toContain(slot);
    }
    expect(HERO_SLOT_PREFERENCE[0]).toBe("outerwear");
  });

  it("never lists an accessory in an adjacency pair", () => {
    for (const [left, right] of ADJACENT_SLOT_PAIRS) {
      expect(left).not.toBe("accessory");
      expect(right).not.toBe("accessory");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

describe("isBusyPattern", () => {
  it("counts a stripe, a check, a floral, and a print as busy", () => {
    expect(BUSY_PATTERNS).toEqual(["stripe", "check", "floral", "print"]);
    for (const pattern of BUSY_PATTERNS) {
      expect(isBusyPattern(pattern)).toBe(true);
    }
  });

  it("counts solid and texture as quiet, so a knit can sit beside a stripe", () => {
    expect(isBusyPattern("solid")).toBe(false);
    expect(isBusyPattern("texture")).toBe(false);
  });

  it("has an opinion about every pattern in the vocabulary", () => {
    for (const pattern of PATTERNS) {
      expect(typeof isBusyPattern(pattern)).toBe("boolean");
    }
    expect(isBusyPattern(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Color harmony                                                       */
/* ------------------------------------------------------------------ */

describe("paletteDistance", () => {
  it("is zero for a color against itself and never negative", () => {
    expect(paletteDistance(RUST, RUST)).toBe(0);
    expect(paletteDistance(RUST, CREAM)).toBeGreaterThan(0);
  });

  it("is null when a hex does not parse, which is not the same as zero", () => {
    expect(paletteDistance("not a color", RUST)).toBeNull();
    expect(paletteDistance(RUST, "#12345")).toBeNull();
  });

  it("counts a change of hue more heavily than a change of lightness", () => {
    // Two colors the same distance apart in raw CIELAB, one along L* and one
    // across a* and b*. The weighting is the reason a deeper rust is still rust.
    const lighterOlive = paletteDistance("#6b6b3a", "#9d9d68");
    const differentHue = paletteDistance("#6b6b3a", "#3a3a6b");
    expect(lighterOlive).not.toBeNull();
    expect(differentHue).not.toBeNull();
    expect(lighterOlive ?? 0).toBeLessThan(differentHue ?? 0);
  });
});

describe("matchToPalette", () => {
  it("puts a palette color in its own family at distance zero", () => {
    const wear = matchToPalette(RUST, DEEP_AUTUMN);
    expect(wear.family).toBe("wear");
    expect(wear.paletteColorName).toBe("Rust");
    expect(wear.distance).toBe(0);

    const avoid = matchToPalette(COOL_GREY, DEEP_AUTUMN);
    expect(avoid.family).toBe("avoid");
    expect(avoid.paletteColorName).toBe("Cool grey");
  });

  it("matches a near color to the palette color it is nearest to", () => {
    const match = matchToPalette(BROWN, DEEP_AUTUMN);
    expect(match.family).toBe("wear");
    expect(match.paletteColorName).toBe("Chocolate");
    expect(match.distance ?? 0).toBeGreaterThan(0);
    expect(match.distance ?? 0).toBeLessThan(PALETTE_MATCH_MAX_DISTANCE);
  });

  it("says neither when the catalog holds nothing close, rather than reaching", () => {
    const match = matchToPalette(NAVY, DEEP_AUTUMN);
    expect(match.family).toBe("neither");
    expect(match.paletteColorName).toBeNull();
    expect(match.distance).toBeNull();
  });

  it("reads the same color differently for a different season, which is the point", () => {
    expect(matchToPalette(NAVY, DEEP_WINTER).family).toBe("wear");
    expect(matchToPalette(RUST, DEEP_WINTER).family).toBe("avoid");
  });

  it("says neither for every color when there is no palette at all", () => {
    expect(matchToPalette(RUST, null).family).toBe("neither");
    expect(matchToPalette(COOL_GREY, null).family).toBe("neither");
  });

  it("says neither for a hex it cannot read", () => {
    expect(matchToPalette("rgb(1,2,3)", DEEP_AUTUMN).family).toBe("neither");
  });
});

describe("garmentColorMatch", () => {
  it("reads the first color, which the classifier is told is the largest area", () => {
    const twoTone = {
      id: "g",
      type: "shirt",
      colors: [
        { name: "Cream", hex: CREAM },
        { name: "Cool grey", hex: COOL_GREY },
      ],
      pattern: "stripe",
      formality: "smart" as const,
    };
    expect(dominantColorOf(twoTone)?.name).toBe("Cream");
    expect(garmentColorMatch(twoTone, DEEP_AUTUMN).family).toBe("wear");
  });

  it("says neither for a garment with no color recorded", () => {
    const colorless = garment({ id: "g", type: "shirt" });
    expect(dominantColorOf(colorless)).toBeNull();
    expect(garmentColorMatch(colorless, DEEP_AUTUMN).family).toBe("neither");
  });
});

/* ------------------------------------------------------------------ */
/* The occasion table                                                  */
/* ------------------------------------------------------------------ */

describe("the occasion table", () => {
  it("has a rule for every occasion and no rule for anything else", () => {
    expect(Object.keys(OCCASION_RULES).sort()).toEqual([...OCCASIONS].sort());
  });

  it("gives every occasion at least one formality band it accepts", () => {
    for (const occasion of OCCASIONS) {
      const bands = OCCASION_RULES[occasion].formality;
      expect(bands.length, `${occasion} accepts nothing`).toBeGreaterThan(0);
      for (const band of bands) {
        expect(FORMALITY).toContain(band);
      }
    }
  });

  it("keeps casual out of an interview, a wedding, and a formal evening", () => {
    for (const occasion of ["interview", "wedding_guest", "formal_evening"] as const) {
      expect(formalityFitsOccasion("casual", occasion)).toBe(false);
    }
  });

  /*
   * CHANGED IN LAYER 5, with the table it asserts. It used to read "keeps a
   * festival casual and a formal evening formal" and pin both bands to one word.
   *
   * Why the rule moved: a one word band makes a screen depend on the wardrobe
   * holding a garment in exactly that band, and the six garment demo profile
   * does not. Festival with casual alone answered with jeans, shoes, and a
   * missing top; formal evening with formal alone answered a wardrobe holding no
   * formal piece with nothing at all. Both bands gained smart, and the comment
   * over OCCASION_RULES argues it. What did not move is the pair of exclusions
   * that carry the meaning of each occasion, which is what this test now pins:
   * formal never reads as festival wear, and casual never reads as black tie.
   */
  it("keeps formal out of a festival and casual out of a formal evening", () => {
    expect(formalityFitsOccasion("formal", "festival")).toBe(false);
    expect(formalityFitsOccasion("casual", "formal_evening")).toBe(false);
    // Smart is the band both of them now share with everything else, so it is
    // the one that has to be checked in both directions.
    expect(formalityFitsOccasion("smart", "festival")).toBe(true);
    expect(formalityFitsOccasion("smart", "formal_evening")).toBe(true);
  });

  it("accepts every band for everyday and none of them for nothing", () => {
    // Everyday is the one occasion with no exclusion at all: a wardrobe is not a
    // dress code, and somebody who owns only formal clothes still has a Tuesday.
    for (const band of FORMALITY) {
      expect(formalityFitsOccasion(band, "everyday")).toBe(true);
    }
  });

  it("adds a layer only where the build order says to", () => {
    expect(OCCASION_RULES.interview.addsOuterwear).toBe(true);
    expect(OCCASION_RULES.wedding_guest.addsOuterwear).toBe(true);
    expect(OCCASION_RULES.formal_evening.addsOuterwear).toBe(true);
    expect(OCCASION_RULES.date.addsOuterwear).toBe(false);
    expect(OCCASION_RULES.festival.addsOuterwear).toBe(false);
    expect(OCCASION_RULES.everyday.addsOuterwear).toBe(false);
  });

  it("never matches a garment whose formality was not read", () => {
    for (const occasion of OCCASIONS) {
      expect(formalityFitsOccasion(null, occasion)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* composeCandidates                                                   */
/* ------------------------------------------------------------------ */

/** A complete smart wardrobe: a top, a bottom, shoes, and a layer. */
const SMART_WARDROBE: LooksGarment[] = [
  garment({ id: "a-top", type: "shirt", hex: CREAM, colorName: "Cream" }),
  garment({ id: "b-bottom", type: "trousers", hex: OLIVE, colorName: "Olive" }),
  garment({
    id: "c-shoes",
    type: "shoes",
    hex: BROWN,
    colorName: "Brown",
    formality: "formal",
  }),
  garment({ id: "d-layer", type: "blazer", hex: NAVY, colorName: "Navy" }),
];

describe("composeCandidates", () => {
  it("returns nothing when the wardrobe holds nothing this occasion can use", () => {
    expect(
      composeCandidates({ garments: [], palette: DEEP_AUTUMN, occasion: "interview" }),
    ).toEqual([]);

    const casualOnly = [
      garment({ id: "t", type: "t_shirt", hex: RUST, formality: "casual" }),
      garment({ id: "j", type: "jeans", hex: NAVY, formality: "casual" }),
    ];
    expect(
      composeCandidates({
        garments: casualOnly,
        palette: DEEP_AUTUMN,
        occasion: "formal_evening",
      }),
    ).toEqual([]);
  });

  it("returns nothing when no garment has been classified yet", () => {
    const pending = [
      { id: "p1", type: null, colors: [], pattern: null, formality: null },
      { id: "p2", type: null, colors: [], pattern: null, formality: null },
    ];
    expect(
      composeCandidates({
        garments: pending,
        palette: DEEP_AUTUMN,
        occasion: "everyday",
      }),
    ).toEqual([]);
  });

  it("returns at most three candidates, best coverage first", () => {
    const wide: LooksGarment[] = [];
    for (let index = 0; index < 8; index += 1) {
      wide.push(
        garment({ id: `top-${index}`, type: "shirt", hex: CREAM }),
        garment({ id: `bottom-${index}`, type: "trousers", hex: OLIVE }),
        garment({ id: `shoes-${index}`, type: "shoes", hex: BROWN }),
      );
    }
    const candidates = composeCandidates({
      garments: wide,
      palette: DEEP_AUTUMN,
      occasion: "interview",
    });
    expect(candidates.length).toBe(MAX_CANDIDATES);
    for (const candidate of candidates) {
      expect(candidate.gaps).toEqual([]);
    }
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "interview-1",
      "interview-2",
      "interview-3",
    ]);
  });

  it("composes a complete look as top, bottom, and shoes with the layer on top", () => {
    const [first] = composeCandidates({
      garments: SMART_WARDROBE,
      palette: DEEP_AUTUMN,
      occasion: "interview",
    });
    expect(first).toBeDefined();
    expect(first?.gaps).toEqual([]);
    expect(first?.garmentIds).toEqual([
      "d-layer",
      "a-top",
      "b-bottom",
      "c-shoes",
    ]);
    expect(first?.heroGarmentId).toBe("d-layer");
  });

  it("composes a dress and shoes as the other complete shape", () => {
    const wardrobe = [
      garment({ id: "dress", type: "dress", hex: RUST, formality: "formal" }),
      garment({
        id: "heels",
        type: "shoes",
        hex: BROWN,
        formality: "formal",
      }),
    ];
    const [first] = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "formal_evening",
    });
    expect(first?.gaps).toEqual([]);
    expect(first?.garmentIds).toEqual(["dress", "heels"]);
    expect(first?.heroGarmentId).toBe("dress");
  });

  it("does not add a layer to an occasion that does not ask for one", () => {
    const wardrobe = [
      garment({ id: "tee", type: "t_shirt", hex: RUST, formality: "casual" }),
      garment({ id: "jeans", type: "jeans", hex: NAVY, formality: "casual" }),
      garment({ id: "canvas", type: "shoes", hex: CREAM, formality: "casual" }),
      garment({
        id: "denim-jacket",
        type: "jacket",
        hex: NAVY,
        formality: "casual",
      }),
    ];
    const candidates = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "festival",
    });
    for (const candidate of candidates) {
      expect(candidate.garmentIds).not.toContain("denim-jacket");
    }
  });

  it("never composes an accessory into a look and never shops for one", () => {
    const wardrobe = [
      ...SMART_WARDROBE,
      garment({ id: "belt", type: "accessory", hex: BROWN }),
    ];
    const candidates = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "interview",
    });
    for (const candidate of candidates) {
      expect(candidate.garmentIds).not.toContain("belt");
      expect(candidate.gaps).not.toContain("accessory");
    }
  });

  it("records the missing types as gaps, in the words shop the gap searches with", () => {
    const noShoes = SMART_WARDROBE.filter(
      (piece) => piece.id !== "c-shoes",
    );
    const [first] = composeCandidates({
      garments: noShoes,
      palette: DEEP_AUTUMN,
      occasion: "interview",
    });
    expect(first?.gaps).toEqual(["shoes"]);
    expect(first?.garmentIds).toEqual(["d-layer", "a-top", "b-bottom"]);
    expect(GAP_TYPE_OF_SLOT.shoes).toBe("shoes");
  });

  it("keeps an avoid color off the face and out of the hero slot", () => {
    const wardrobe = [
      garment({
        id: "grey-top",
        type: "top",
        hex: COOL_GREY,
        colorName: "Cool grey",
        formality: "casual",
      }),
      garment({
        id: "rust-knit",
        type: "sweater",
        hex: RUST,
        colorName: "Rust",
        formality: "casual",
      }),
      garment({ id: "jeans", type: "jeans", hex: NAVY, formality: "casual" }),
      garment({ id: "canvas", type: "shoes", hex: CREAM, formality: "casual" }),
    ];
    const candidates = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "everyday",
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.garmentIds).not.toContain("grey-top");
      expect(candidate.heroGarmentId).not.toBe("grey-top");
    }
  });

  it("lets an avoid color sit below the waist and says so in the notes", () => {
    const wardrobe = [
      garment({ id: "cream-shirt", type: "shirt", hex: CREAM, colorName: "Cream" }),
      garment({
        id: "pink-skirt",
        type: "skirt",
        hex: ICY_PINK,
        colorName: "Icy pink",
      }),
      garment({ id: "shoes", type: "shoes", hex: BROWN, formality: "smart" }),
    ];
    const candidates = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "wedding_guest",
    });
    const [first] = candidates;
    expect(first?.garmentIds).toContain("pink-skirt");
    expect(first?.heroGarmentId).toBe("cream-shirt");
    expect(allNotes(candidates)).toContain(
      "icy pink stays below the waist, away from your face",
    );
  });

  it("rejects two busy patterns in slots that touch", () => {
    const wardrobe = [
      garment({
        id: "stripe-shirt",
        type: "shirt",
        hex: CREAM,
        pattern: "stripe",
      }),
      garment({
        id: "check-trousers",
        type: "trousers",
        hex: OLIVE,
        pattern: "check",
      }),
      garment({ id: "plain-trousers", type: "trousers", hex: OLIVE }),
      garment({ id: "shoes", type: "shoes", hex: BROWN }),
    ];
    const candidates = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "interview",
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const busyBoth =
        candidate.garmentIds.includes("stripe-shirt") &&
        candidate.garmentIds.includes("check-trousers");
      expect(busyBoth, `${candidate.id} put two busy patterns together`).toBe(
        false,
      );
    }
    // Each of them is still wearable on its own.
    const used = new Set(candidates.flatMap((candidate) => candidate.garmentIds));
    expect(used.has("stripe-shirt") || used.has("check-trousers")).toBe(true);
  });

  it("lets a texture sit next to a busy pattern, because a knit is not a figure", () => {
    const wardrobe = [
      garment({
        id: "knit",
        type: "sweater",
        hex: RUST,
        pattern: "texture",
        formality: "casual",
      }),
      garment({
        id: "print-shorts",
        type: "shorts",
        hex: OLIVE,
        pattern: "print",
        formality: "casual",
      }),
      garment({ id: "canvas", type: "shoes", hex: CREAM, formality: "casual" }),
    ];
    const [first] = composeCandidates({
      garments: wardrobe,
      palette: DEEP_AUTUMN,
      occasion: "festival",
    });
    expect(first?.garmentIds).toEqual(["knit", "print-shorts", "canvas"]);
    expect(first?.gaps).toEqual([]);
  });

  it("is deterministic, whatever order the wardrobe arrives in", () => {
    const input = {
      garments: SMART_WARDROBE,
      palette: DEEP_AUTUMN,
      occasion: "interview" as Occasion,
    };
    const first = composeCandidates(input);
    const again = composeCandidates(input);
    const reversed = composeCandidates({
      ...input,
      garments: [...SMART_WARDROBE].reverse(),
    });
    expect(again).toEqual(first);
    expect(reversed).toEqual(first);
  });

  it("still composes by formality and pattern when there is no palette", () => {
    const candidates = composeCandidates({
      garments: SMART_WARDROBE,
      palette: null,
      occasion: "interview",
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.gaps).toEqual([]);
    // Nothing is claimed about a color nobody derived a palette for.
    for (const note of allNotes(candidates)) {
      expect(note).not.toContain("wear palette");
      expect(note).not.toContain("below the waist, away from your face");
    }
  });

  it("caps how many garments per slot enter the cross product", () => {
    const many: LooksGarment[] = [];
    for (let index = 0; index < MAX_PER_SLOT * 3; index += 1) {
      many.push(garment({ id: `shirt-${index}`, type: "shirt", hex: CREAM }));
    }
    many.push(garment({ id: "trousers", type: "trousers", hex: OLIVE }));
    many.push(garment({ id: "shoes", type: "shoes", hex: BROWN }));
    const candidates = composeCandidates({
      garments: many,
      palette: DEEP_AUTUMN,
      occasion: "interview",
    });
    expect(candidates.length).toBe(MAX_CANDIDATES);
    // The cap is on the enumeration, not on the answer: three looks still come
    // back, and they are the first three shirts by id.
    expect(candidates.map((candidate) => candidate.garmentIds[0])).toEqual([
      "shirt-0",
      "shirt-1",
      "shirt-10",
    ]);
  });

  it("gives every candidate a stable id that names its occasion", () => {
    for (const occasion of OCCASIONS) {
      const candidates = composeCandidates({
        garments: [
          garment({ id: "top", type: "shirt", hex: CREAM, formality: "casual" }),
          garment({ id: "top2", type: "shirt", hex: CREAM, formality: "smart" }),
          garment({ id: "top3", type: "shirt", hex: CREAM, formality: "formal" }),
          garment({ id: "bottom", type: "trousers", hex: OLIVE, formality: "casual" }),
          garment({ id: "bottom2", type: "trousers", hex: OLIVE, formality: "smart" }),
          garment({ id: "bottom3", type: "trousers", hex: OLIVE, formality: "formal" }),
          garment({ id: "shoes", type: "shoes", hex: BROWN, formality: "casual" }),
          garment({ id: "shoes2", type: "shoes", hex: BROWN, formality: "smart" }),
          garment({ id: "shoes3", type: "shoes", hex: BROWN, formality: "formal" }),
        ],
        palette: DEEP_AUTUMN,
        occasion,
      });
      expect(candidates.length, `${occasion} produced no look`).toBeGreaterThan(0);
      for (const [index, candidate] of candidates.entries()) {
        expect(candidate.id).toBe(`${occasion}-${index + 1}`);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Rule notes                                                          */
/* ------------------------------------------------------------------ */

describe("the rule notes", () => {
  it("names a wear color the way the contract writes it", () => {
    const wardrobe = [
      garment({ id: "navy-blazer", type: "blazer", hex: NAVY, colorName: "Navy" }),
      garment({ id: "cream-shirt", type: "shirt", hex: CREAM, colorName: "Cream" }),
      garment({ id: "olive", type: "trousers", hex: OLIVE, colorName: "Olive" }),
      garment({ id: "brown", type: "shoes", hex: BROWN, colorName: "Brown" }),
    ];
    const notes = composeCandidates({
      garments: wardrobe,
      palette: DEEP_WINTER,
      occasion: "interview",
    })[0]?.ruleNotes;
    expect(notes).toContain("navy sits in your wear palette");
  });

  it("names the layer, the formality, and what is missing", () => {
    const noShoes = SMART_WARDROBE.filter((piece) => piece.id !== "c-shoes");
    const notes =
      composeCandidates({
        garments: noShoes,
        palette: DEEP_AUTUMN,
        occasion: "wedding_guest",
      })[0]?.ruleNotes ?? [];
    expect(notes).toContain("every piece here reads smart");
    expect(notes).toContain("the blazer is the layer this occasion asks for");
    expect(notes).toContain("you do not own shoes yet");
  });

  it("says where the one busy pattern sits", () => {
    const wardrobe = [
      garment({ id: "shirt", type: "shirt", hex: CREAM }),
      garment({
        id: "check-trousers",
        type: "trousers",
        hex: OLIVE,
        pattern: "check",
      }),
      garment({ id: "shoes", type: "shoes", hex: BROWN }),
    ];
    const notes =
      composeCandidates({
        garments: wardrobe,
        palette: DEEP_AUTUMN,
        occasion: "interview",
      })[0]?.ruleNotes ?? [];
    expect(notes).toContain("the check stays below the waist");
  });

  it("is a plain lower case fragment, lexicon clean, on every look we can build", () => {
    const wardrobe = [
      garment({ id: "g1", type: "blazer", hex: NAVY, colorName: "Navy" }),
      garment({ id: "g2", type: "shirt", hex: CREAM, colorName: "Cream", pattern: "stripe" }),
      garment({ id: "g3", type: "trousers", hex: OLIVE, colorName: "Olive" }),
      garment({ id: "g4", type: "shoes", hex: BROWN, colorName: "Brown", formality: "casual" }),
      garment({ id: "g5", type: "skirt", hex: ICY_PINK, colorName: "Icy pink" }),
      garment({ id: "g6", type: "dress", hex: RUST, colorName: "Rust", formality: "formal" }),
      garment({ id: "g7", type: "t_shirt", hex: RUST, colorName: "Rust", formality: "casual", pattern: "print" }),
      garment({ id: "g8", type: "shorts", hex: OLIVE, colorName: "Olive", formality: "casual" }),
      garment({ id: "g9", type: "coat", hex: NAVY, colorName: "Navy", formality: "formal" }),
    ];
    let checked = 0;
    for (const occasion of OCCASIONS) {
      for (const palette of [DEEP_AUTUMN, DEEP_WINTER, null]) {
        for (const candidate of composeCandidates({
          garments: wardrobe,
          palette,
          occasion,
        })) {
          for (const note of candidate.ruleNotes) {
            expectCleanFragment(note);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
