/*
 * The fixtures below carry hex colors because a garment color is handed to this
 * screen as a hex color: it is data from the classifier or from the person, not
 * a design color (see the note at the top of src/components/ui/Swatch.tsx). The
 * rule that keeps design colors out of components cannot tell the two apart, so
 * it is turned off for this file and nothing else.
 */
/* eslint-disable aurum/no-hex-colors */

import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";
import { isLexiconClean } from "@/lib/shared/lexicon";
import {
  FORMALITY,
  GARMENT_TYPES,
  PATTERNS,
  type GarmentView,
} from "@/lib/shared/wardrobe-view";

import {
  ALL_TYPES,
  cardState,
  filterByType,
  FORMALITY_OPTIONS,
  garmentChips,
  hasAnyChip,
  PATTERN_OPTIONS,
  showsCorrectHint,
  showsTypeFilter,
  TYPE_OPTIONS,
  typeFilterLabel,
  typeFilterOptions,
} from "./wardrobe-content";

function garment(overrides: Partial<GarmentView> = {}): GarmentView {
  return {
    id: "g1",
    imageUrl: "/api/wardrobe/images/g1",
    type: "blazer",
    colors: [{ name: "Navy", hex: "#1f2a44" }],
    pattern: "solid",
    formality: "formal",
    userEdited: false,
    classificationStatus: "succeeded",
    ...overrides,
  };
}

describe("typeFilterOptions", () => {
  it("offers only the types the wardrobe actually holds", () => {
    const options = typeFilterOptions([
      garment({ id: "a", type: "shoes" }),
      garment({ id: "b", type: "blazer" }),
      garment({ id: "c", type: "shoes" }),
    ]);
    expect(options).toEqual(["blazer", "shoes"]);
  });

  it("orders them the way the vocabulary does, not the way photos arrived", () => {
    const options = typeFilterOptions([
      garment({ id: "a", type: "shoes" }),
      garment({ id: "b", type: "shirt" }),
      garment({ id: "c", type: "trousers" }),
    ]);
    const expected = GARMENT_TYPES.filter((type) =>
      ["shirt", "trousers", "shoes"].includes(type),
    );
    expect(options).toEqual(expected);
  });

  it("leaves out a garment nobody has classified", () => {
    expect(
      typeFilterOptions([
        garment({ id: "a", type: null, classificationStatus: "pending" }),
      ]),
    ).toEqual([]);
  });
});

describe("showsTypeFilter", () => {
  it("hides the row until there are two types to choose between", () => {
    expect(showsTypeFilter([])).toBe(false);
    expect(showsTypeFilter([garment()])).toBe(false);
    expect(
      showsTypeFilter([garment(), garment({ id: "b", type: "shoes" })]),
    ).toBe(true);
  });
});

describe("filterByType", () => {
  const wardrobe = [
    garment({ id: "a", type: "blazer" }),
    garment({ id: "b", type: "shoes" }),
  ];

  it("shows everything under the clearing chip", () => {
    expect(filterByType(wardrobe, ALL_TYPES)).toHaveLength(2);
  });

  it("shows one type under its own chip", () => {
    expect(filterByType(wardrobe, "shoes").map((one) => one.id)).toEqual(["b"]);
  });

  it("never hands back the array it was given", () => {
    const all = filterByType(wardrobe, ALL_TYPES);
    expect(all).not.toBe(wardrobe);
  });
});

describe("typeFilterLabel", () => {
  it("labels the clearing chip from copy.ts", () => {
    expect(typeFilterLabel(ALL_TYPES)).toBe(copy.wardrobe.filterAll);
  });

  it("labels a type from the vocabulary", () => {
    expect(typeFilterLabel("t_shirt")).toBe("T shirt");
  });
});

describe("garmentChips", () => {
  it("turns stored words into the chips the card draws", () => {
    expect(garmentChips(garment())).toEqual({
      type: "Blazer",
      colors: [{ name: "Navy", hex: "#1f2a44" }],
      pattern: "Solid",
      formality: "Formal",
    });
  });

  it("leaves a chip out rather than guessing at a missing attribute", () => {
    const chips = garmentChips(
      garment({ pattern: null, formality: null, colors: [] }),
    );
    expect(chips.pattern).toBeNull();
    expect(chips.formality).toBeNull();
    expect(chips.colors).toEqual([]);
  });

  it("leaves a chip out for a word the app has no label for", () => {
    const chips = garmentChips(garment({ type: "kimono", pattern: "paisley" }));
    expect(chips.type).toBeNull();
    expect(chips.pattern).toBeNull();
  });
});

describe("hasAnyChip", () => {
  it("is false only when the row carries nothing at all", () => {
    expect(hasAnyChip(garmentChips(garment()))).toBe(true);
    expect(
      hasAnyChip(
        garmentChips(
          garment({ type: null, colors: [], pattern: null, formality: null }),
        ),
      ),
    ).toBe(false);
  });
});

describe("cardState", () => {
  it("shows skeleton pills while a classification is open", () => {
    expect(cardState(garment({ classificationStatus: "pending" }))).toBe(
      "pending",
    );
  });

  it("shows the chips once the row carries something to draw", () => {
    expect(cardState(garment())).toBe("chips");
  });

  it("shows the failed card when the classifier could not read it", () => {
    expect(
      cardState(
        garment({
          type: null,
          colors: [],
          pattern: null,
          formality: null,
          classificationStatus: "failed",
        }),
      ),
    ).toBe("failed");
  });

  it("shows the failed card for a succeeded row with nothing on it, because an empty chip row says nothing", () => {
    expect(
      cardState(
        garment({
          type: null,
          colors: [],
          pattern: null,
          formality: null,
          classificationStatus: "succeeded",
        }),
      ),
    ).toBe("failed");
  });
});

describe("showsCorrectHint", () => {
  it("waits until there is a chip on the screen to tap", () => {
    expect(showsCorrectHint([])).toBe(false);
    expect(
      showsCorrectHint([garment({ classificationStatus: "pending" })]),
    ).toBe(false);
    expect(showsCorrectHint([garment()])).toBe(true);
  });
});

describe("the picker options", () => {
  it("offers every word in each vocabulary, in the vocabulary's order", () => {
    expect(TYPE_OPTIONS.map((option) => option.value)).toEqual([
      ...GARMENT_TYPES,
    ]);
    expect(PATTERN_OPTIONS.map((option) => option.value)).toEqual([...PATTERNS]);
    expect(FORMALITY_OPTIONS.map((option) => option.value)).toEqual([
      ...FORMALITY,
    ]);
  });

  it("labels every option with a word a person can read", () => {
    for (const option of [
      ...TYPE_OPTIONS,
      ...PATTERN_OPTIONS,
      ...FORMALITY_OPTIONS,
    ]) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(isLexiconClean(option.label)).toBe(true);
    }
  });
});
