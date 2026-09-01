import { describe, expect, it } from "vitest";

import {
  DEEP_BELOW_LIGHTNESS,
  DEEP_SEASONS,
  EYE_CHROMA_WEIGHT,
  FITZPATRICK_LIGHTNESS_BIAS,
  HIGH_CONTRAST_AT_OR_ABOVE,
  LIGHT_AT_OR_ABOVE_LIGHTNESS,
  LOW_CONTRAST_BELOW,
  SEASONS,
  SEASON_PALETTES,
  SEASON_RULE_TABLE,
  SEASON_TEMPERATURE,
  chromaOf,
  classifyContrast,
  classifyDepth,
  contrastScore,
  derivePalette,
  deriveSeason,
  deriveSeasonDetail,
  hexToLab,
  hexToRgb,
  isSeason,
  lightnessOf,
  paletteForSeason,
  seasonDisplayName,
  seasonLine,
  type PaletteInput,
} from "./palette";

/**
 * Unit tests for the color math and the classification steps. The suite that
 * gates a merge is evals/palette (docs/05-evals.md), which owns the golden files
 * and the property tests over the whole grid. This file covers the pieces those
 * properties are built on, so a failure points at the step that broke rather
 * than at "the palette".
 */

const DEEP_WARM: PaletteInput = {
  skinToneHex: "#6b4a2f",
  undertone: "warm",
  eyeColorHex: "#3b2b22",
  hairColorHex: "#1e1613",
  fitzpatrick: 5,
};

describe("hex parsing", () => {
  it("reads six digit hex with or without the hash, in any case", () => {
    expect(hexToRgb("#6b4a2f")).toEqual({ r: 107, g: 74, b: 47 });
    expect(hexToRgb("6B4A2F")).toEqual({ r: 107, g: 74, b: 47 });
    expect(hexToRgb("  #6b4a2f  ")).toEqual({ r: 107, g: 74, b: 47 });
  });

  it("returns null for anything that is not a six digit hex", () => {
    for (const value of ["", "#fff", "#12345", "#1234567", "rgb(1,2,3)", "zzz"]) {
      expect(hexToRgb(value), value).toBeNull();
      expect(hexToLab(value), value).toBeNull();
      expect(lightnessOf(value), value).toBeNull();
      expect(chromaOf(value), value).toBeNull();
    }
  });
});

describe("lightness and chroma", () => {
  it("puts black at 0 and white at 100", () => {
    expect(lightnessOf("#000000")).toBeCloseTo(0, 4);
    // The sRGB to XYZ matrix is written to seven places, so white lands a few
    // millionths past 100. That is the matrix, not a rounding choice of ours.
    expect(lightnessOf("#ffffff")).toBeCloseTo(100, 4);
  });

  it("rises with the grey it is given", () => {
    const greys = ["#111111", "#444444", "#808080", "#bbbbbb", "#eeeeee"];
    const values = greys.map((hex) => lightnessOf(hex) ?? -1);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!).toBeGreaterThan(values[index - 1]!);
    }
  });

  it("reads a grey as no color and a saturated hue as a lot of it", () => {
    expect(chromaOf("#808080") ?? -1).toBeLessThan(1);
    expect(chromaOf("#ffffff") ?? -1).toBeLessThan(1);
    expect(chromaOf("#e22b26") ?? 0).toBeGreaterThan(40);
    expect(chromaOf("#5b7fa6") ?? 0).toBeGreaterThan(10);
  });

  it("keeps a mid grey near the middle of the scale", () => {
    // L* is perceptual, so 50 percent grey lands near 53, not near 21 the way
    // relative luminance would put it. This is the property depth reading needs.
    expect(lightnessOf("#808080") ?? 0).toBeGreaterThan(50);
    expect(lightnessOf("#808080") ?? 0).toBeLessThan(57);
  });
});

describe("depth", () => {
  it("splits deep, medium, and light at the documented boundaries", () => {
    expect(classifyDepth("#3a2418", null)).toBe("deep");
    expect(classifyDepth("#8d5524", null)).toBe("deep");
    expect(classifyDepth("#a67b5b", null)).toBe("medium");
    expect(classifyDepth("#c68642", null)).toBe("medium");
    expect(classifyDepth("#f0d5cf", null)).toBe("light");
  });

  it("keeps the boundaries in the order the bands need", () => {
    expect(DEEP_BELOW_LIGHTNESS).toBeLessThan(LIGHT_AT_OR_ABOVE_LIGHTNESS);
  });

  it("lets Fitzpatrick move a borderline reading by one band, no further", () => {
    // #916647 reads L* 46.9, just inside the medium band.
    expect(classifyDepth("#916647", null)).toBe("medium");
    expect(classifyDepth("#916647", 5)).toBe("deep");
    expect(classifyDepth("#916647", 1)).toBe("medium");
    // A tone in the middle of the medium band does not move at all.
    expect(classifyDepth("#a67b5b", 6)).toBe("medium");
    expect(classifyDepth("#a67b5b", 1)).toBe("medium");
  });

  it("keeps every Fitzpatrick nudge smaller than the medium band", () => {
    const band = LIGHT_AT_OR_ABOVE_LIGHTNESS - DEEP_BELOW_LIGHTNESS;
    for (const bias of Object.values(FITZPATRICK_LIGHTNESS_BIAS)) {
      expect(Math.abs(bias)).toBeLessThan(band);
    }
  });

  it("falls back to Fitzpatrick when the tone hex is unreadable", () => {
    expect(classifyDepth("not a hex", 6)).toBe("deep");
    expect(classifyDepth("not a hex", 5)).toBe("deep");
    expect(classifyDepth("not a hex", 3)).toBe("medium");
    expect(classifyDepth("not a hex", 1)).toBe("light");
  });

  it("falls back to medium when neither the tone nor Fitzpatrick can be read", () => {
    expect(classifyDepth("", null)).toBe("medium");
    // A Fitzpatrick outside I to VI is not a reading, so it is ignored rather
    // than pinned to the nearest type.
    expect(classifyDepth("#zzzzzz", 0)).toBe("medium");
    expect(classifyDepth("#zzzzzz", 7)).toBe("medium");
    expect(classifyDepth("#zzzzzz", 4.5)).toBe("medium");
  });
});

describe("contrast", () => {
  it("reads near black hair on fair skin as high", () => {
    expect(
      classifyContrast({
        skinToneHex: "#f0d5cf",
        eyeColorHex: "#5b7fa6",
        hairColorHex: "#141014",
      }),
    ).toBe("high");
  });

  it("reads coloring that sits close together as low", () => {
    expect(
      classifyContrast({
        skinToneHex: "#6b4a2f",
        eyeColorHex: "#6b4a2f",
        hairColorHex: "#6b4a2f",
      }),
    ).toBe("low");
  });

  it("calls unknown contrast medium rather than low", () => {
    // No hair and no eye reading is not a low contrast face, it is a face we
    // have not read. Medium is the band that assumes least.
    expect(contrastScore({
      skinToneHex: "#6b4a2f",
      eyeColorHex: null,
      hairColorHex: null,
    })).toBeNull();
    expect(
      classifyContrast({
        skinToneHex: "#6b4a2f",
        eyeColorHex: null,
        hairColorHex: null,
      }),
    ).toBe("medium");
    expect(
      classifyContrast({
        skinToneHex: "not a hex",
        eyeColorHex: "#1e1613",
        hairColorHex: "#1e1613",
      }),
    ).toBe("medium");
  });

  it("counts a vivid eye color toward the score", () => {
    const grey = {
      skinToneHex: "#f0d5cf",
      eyeColorHex: "#6a6a6a",
      hairColorHex: "#9a7350",
    };
    const blue = { ...grey, eyeColorHex: "#2f6fd0" };
    const greyScore = contrastScore(grey) ?? 0;
    const blueScore = contrastScore(blue) ?? 0;
    expect(blueScore).toBeGreaterThan(greyScore);
    expect(EYE_CHROMA_WEIGHT).toBeGreaterThan(0);
    expect(EYE_CHROMA_WEIGHT).toBeLessThan(1);
  });

  it("keeps the boundaries in the order the bands need", () => {
    expect(LOW_CONTRAST_BELOW).toBeLessThan(HIGH_CONTRAST_AT_OR_ABOVE);
  });
});

describe("season derivation", () => {
  it("returns what the rule table holds for the readings it made", () => {
    const detail = deriveSeasonDetail(DEEP_WARM);
    expect(detail.depth).toBe("deep");
    expect(detail.season).toBe(
      SEASON_RULE_TABLE.warm[detail.depth][detail.contrast],
    );
    expect(detail.season).toBe("deep_autumn");
    expect(detail.contrastScore).not.toBeNull();
  });

  it("sends deep coloring to a deep season under every undertone", () => {
    for (const undertone of ["warm", "cool", "neutral"] as const) {
      const season = deriveSeason({ ...DEEP_WARM, undertone });
      expect(DEEP_SEASONS).toContain(season);
    }
  });

  it("agrees with deriveSeasonDetail", () => {
    expect(deriveSeason(DEEP_WARM)).toBe(deriveSeasonDetail(DEEP_WARM).season);
  });
});

describe("the catalog", () => {
  it("has an entry for every season and nothing else", () => {
    expect(Object.keys(SEASON_PALETTES).sort()).toEqual([...SEASONS].sort());
    expect(new Set(SEASONS).size).toBe(SEASONS.length);
  });

  it("recognizes its own seasons and rejects others", () => {
    for (const season of SEASONS) {
      expect(isSeason(season)).toBe(true);
    }
    expect(isSeason("autumn")).toBe(false);
    expect(isSeason("")).toBe(false);
  });

  it("gives every season a temperature", () => {
    for (const season of SEASONS) {
      expect(["warm", "cool"]).toContain(SEASON_TEMPERATURE[season]);
    }
    expect(SEASON_TEMPERATURE.deep_autumn).toBe("warm");
    expect(SEASON_TEMPERATURE.deep_winter).toBe("cool");
  });

  it("names seasons in title case for the season line", () => {
    expect(seasonDisplayName("deep_autumn")).toBe("Deep Autumn");
    expect(seasonLine("deep_autumn")).toBe(
      "Rich, warm, and grounded colors sit closest to your skin.",
    );
    for (const season of SEASONS) {
      expect(seasonDisplayName(season)).toBe(
        SEASON_PALETTES[season].displayName,
      );
      expect(seasonLine(season)).toBe(SEASON_PALETTES[season].line);
    }
  });
});

describe("derivePalette", () => {
  it("returns the catalog palette for the derived season", () => {
    expect(derivePalette(DEEP_WARM)).toEqual(paletteForSeason("deep_autumn"));
  });

  it("carries the season, its name, and its line", () => {
    const palette = derivePalette(DEEP_WARM);
    expect(palette.season).toBe("deep_autumn");
    expect(palette.seasonDisplayName).toBe("Deep Autumn");
    expect(palette.seasonLine).toBe(seasonLine("deep_autumn"));
  });

  it("returns fresh arrays, so the catalog cannot be edited through one", () => {
    const first = derivePalette(DEEP_WARM);
    first.wear.push({ name: "Nothing", hex: "#000000", why: "Not real." });
    const second = derivePalette(DEEP_WARM);
    expect(second.wear).toHaveLength(first.wear.length - 1);
    expect(second.wear.map((color) => color.name)).not.toContain("Nothing");
  });

  it("never throws, whatever it is handed", () => {
    const inputs: PaletteInput[] = [
      { skinToneHex: "", undertone: "warm", eyeColorHex: null, hairColorHex: null, fitzpatrick: null },
      { skinToneHex: "#zzzzzz", undertone: "cool", eyeColorHex: "", hairColorHex: "", fitzpatrick: 9 },
      { skinToneHex: "#ffffff", undertone: "neutral", eyeColorHex: "#ffffff", hairColorHex: "#ffffff", fitzpatrick: -3 },
      { skinToneHex: "#000000", undertone: "warm", eyeColorHex: "#000000", hairColorHex: "#000000", fitzpatrick: 4.5 },
    ];
    for (const input of inputs) {
      const palette = derivePalette(input);
      expect(SEASONS).toContain(palette.season);
      expect(palette.wear.length).toBeGreaterThanOrEqual(8);
      expect(palette.avoid.length).toBeGreaterThanOrEqual(4);
    }
  });
});
