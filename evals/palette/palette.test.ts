import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { checkLexicon, describeViolation } from "@/lib/shared/lexicon";
import {
  DEEP_SEASONS,
  SEASONS,
  SEASON_PALETTES,
  SEASON_RULE_TABLE,
  SEASON_TEMPERATURE,
  derivePalette,
  deriveSeason,
  deriveSeasonDetail,
  paletteForSeason,
  type Contrast,
  type Depth,
  type Palette,
  type PaletteColor,
  type PaletteInput,
  type Season,
  type Undertone,
} from "@/lib/shared/palette";

import {
  loadGoldenPalette,
  loadProfileFixtures,
  paletteInputOf,
} from "../fixtures/profiles";

/**
 * eval:palette, deterministic, runs on every PR and in eval:smoke.
 *
 * Spec: docs/05-evals.md, suite eval:palette:
 * "Unit tests over src/lib/shared/palette.ts: season mapping from tone,
 * undertone, eye and hair color; wear and avoid lists. Golden files for the three
 * fixture profiles. Any change to the mapping updates the goldens deliberately in
 * the same PR with a note on why. Property tests: every palette has 8 to 12 wear
 * colors and 4 to 6 avoid colors; no color appears in both; undertone flips move
 * the palette to the corresponding season family."
 *
 * The counts come from docs/01-user-flow.md section G items 4 and 5. The word
 * checks come from docs/02-design-system.md, "Writing inside the design", and
 * docs/06-safety-privacy.md through src/lib/shared/lexicon.ts.
 *
 * Everything here is pure. No key, no network, no database, nothing to record.
 * What passes here is evidence about the mapping and the words, which is all
 * this layer is: the palette is a rule table plus a catalog, and both are ours.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(HERE, "..", "results");

/* ------------------------------------------------------------------ */
/* The grid                                                            */
/* ------------------------------------------------------------------ */

/**
 * Skin tones spanning Fitzpatrick VI to I. The middle eight are the hexes the
 * analysis fixtures use, so the grid covers the coloring the rest of the
 * repository already talks about, and the two darkest are added because deep
 * skin is the case this product is built to get right.
 */
const SKIN_TONES: readonly string[] = [
  "#2e1c12",
  "#3a2418",
  "#4b3a35",
  "#573a22",
  "#6b4a2f",
  "#8d5524",
  "#a67b5b",
  "#b3877f",
  "#c68642",
  "#d7a86e",
  "#e0bcb0",
  "#f0d5cf",
  "#f6dcb4",
];

/** Dark brown, blue, green, grey, and no reading at all. */
const EYE_COLORS: readonly (string | null)[] = [
  null,
  "#3b2b22",
  "#5b7fa6",
  "#6b8f5e",
  "#4a4a55",
];

/** Near black, dark brown, light brown, blonde, and no reading at all. */
const HAIR_COLORS: readonly (string | null)[] = [
  null,
  "#1e1613",
  "#5c3d2e",
  "#9a7350",
  "#b3803c",
];

const FITZPATRICKS: readonly (number | null)[] = [null, 1, 2, 3, 4, 5, 6];

const UNDERTONES: readonly Undertone[] = ["warm", "cool", "neutral"];

type GridPoint = {
  readonly skinToneHex: string;
  readonly eyeColorHex: string | null;
  readonly hairColorHex: string | null;
  readonly fitzpatrick: number | null;
};

function gridPoints(): GridPoint[] {
  const points: GridPoint[] = [];
  for (const skinToneHex of SKIN_TONES) {
    for (const eyeColorHex of EYE_COLORS) {
      for (const hairColorHex of HAIR_COLORS) {
        for (const fitzpatrick of FITZPATRICKS) {
          points.push({ skinToneHex, eyeColorHex, hairColorHex, fitzpatrick });
        }
      }
    }
  }
  return points;
}

const GRID = gridPoints();

function inputsFrom(point: GridPoint): PaletteInput[] {
  return UNDERTONES.map((undertone) => ({ ...point, undertone }));
}

function describeInput(input: PaletteInput): string {
  return [
    `skin ${input.skinToneHex}`,
    `undertone ${input.undertone}`,
    `eye ${input.eyeColorHex ?? "none"}`,
    `hair ${input.hairColorHex ?? "none"}`,
    `fitzpatrick ${input.fitzpatrick ?? "none"}`,
  ].join(", ");
}

/* ------------------------------------------------------------------ */
/* The summary a PR pastes                                             */
/* ------------------------------------------------------------------ */

const summary: {
  gridPoints: number;
  palettesDerived: number;
  seasonsReached: string[];
  profiles: { id: string; season: string; matchedGolden: boolean }[];
  wearPerSeason: number;
  avoidPerSeason: number;
  wordsChecked: number;
} = {
  gridPoints: GRID.length,
  palettesDerived: GRID.length * UNDERTONES.length,
  seasonsReached: [],
  profiles: [],
  wearPerSeason: 0,
  avoidPerSeason: 0,
  wordsChecked: 0,
};

afterAll(() => {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const sha = process.env.GITHUB_SHA ?? process.env.AURUM_BUILD_SHA ?? "local";
    writeFileSync(
      resolve(RESULTS_DIR, `palette-${sha}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // docs/05-evals.md asks for a results file. Not being able to write one is
    // not a reason to fail the suite that produced the numbers.
  }
});

/* ------------------------------------------------------------------ */
/* Golden files                                                        */
/* ------------------------------------------------------------------ */

describe("eval:palette golden profiles", () => {
  const fixtures = loadProfileFixtures();

  it("loads the three profiles docs/05-evals.md names", () => {
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "deep-warm",
      "medium-neutral",
      "light-cool",
    ]);
    for (const fixture of fixtures) {
      expect(fixture.synthetic).toBe(true);
    }
  });

  for (const fixture of fixtures) {
    it(`derives the recorded season and depth for ${fixture.id}`, () => {
      const detail = deriveSeasonDetail(paletteInputOf(fixture));
      expect(detail.season).toBe(fixture.expected.season);
      expect(detail.depth).toBe(fixture.expected.depth);
      expect(detail.contrast).toBe(fixture.expected.contrast);
    });

    it(`matches the golden palette for ${fixture.id}`, () => {
      const derived = derivePalette(paletteInputOf(fixture));
      const golden = loadGoldenPalette(fixture);
      const matched =
        JSON.stringify(derived) === JSON.stringify(golden);
      summary.profiles.push({
        id: fixture.id,
        season: derived.season,
        matchedGolden: matched,
      });
      // The whole palette, not only the season: the names, the hexes, and the
      // why lines are the product, so a change to any of them has to be a
      // deliberate golden update (evals/fixtures/profiles/README.md).
      expect(derived).toEqual(golden);
    });
  }

  it("gives the deep profile a list as long as the light profile's", () => {
    const deep = derivePalette(paletteInputOf(fixtures[0]!));
    const light = derivePalette(paletteInputOf(fixtures[2]!));
    expect(deep.wear.length).toBe(light.wear.length);
    expect(deep.avoid.length).toBe(light.avoid.length);
  });
});

/* ------------------------------------------------------------------ */
/* The rule table                                                      */
/* ------------------------------------------------------------------ */

describe("eval:palette season mapping", () => {
  it("has a season for all 27 cells and reaches all 12 seasons", () => {
    const cells: Season[] = [];
    for (const undertone of UNDERTONES) {
      for (const depth of ["deep", "medium", "light"] as Depth[]) {
        for (const contrast of ["low", "medium", "high"] as Contrast[]) {
          const season = SEASON_RULE_TABLE[undertone][depth][contrast];
          expect(SEASONS).toContain(season);
          cells.push(season);
        }
      }
    }
    expect(cells).toHaveLength(27);
    expect(new Set(cells).size).toBe(SEASONS.length);
  });

  it("derives the season the table says, for every point on the grid", () => {
    const problems: string[] = [];
    for (const point of GRID) {
      for (const input of inputsFrom(point)) {
        const detail = deriveSeasonDetail(input);
        const fromTable =
          SEASON_RULE_TABLE[input.undertone][detail.depth][detail.contrast];
        if (fromTable !== detail.season) {
          problems.push(
            `${describeInput(input)}: derived ${detail.season}, table says ${fromTable}`,
          );
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("keeps warm coloring in a warm season and cool coloring in a cool one", () => {
    const problems: string[] = [];
    for (const point of GRID) {
      const warm = deriveSeason({ ...point, undertone: "warm" });
      const cool = deriveSeason({ ...point, undertone: "cool" });
      if (SEASON_TEMPERATURE[warm] !== "warm") {
        problems.push(
          `${describeInput({ ...point, undertone: "warm" })}: warm undertone landed in ${warm}`,
        );
      }
      if (SEASON_TEMPERATURE[cool] !== "cool") {
        problems.push(
          `${describeInput({ ...point, undertone: "cool" })}: cool undertone landed in ${cool}`,
        );
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("moves a flipped undertone across families without changing the depth", () => {
    const problems: string[] = [];
    for (const point of GRID) {
      const warm = deriveSeasonDetail({ ...point, undertone: "warm" });
      const cool = deriveSeasonDetail({ ...point, undertone: "cool" });
      const neutral = deriveSeasonDetail({ ...point, undertone: "neutral" });
      const details = [warm, cool, neutral];
      const label = describeInput({ ...point, undertone: "warm" });

      // Depth is read from the skin tone and Fitzpatrick, so the undertone
      // cannot change it.
      for (const detail of details) {
        if (detail.depth !== warm.depth) {
          problems.push(`${label}: the undertone changed the depth`);
        }
      }

      if (warm.depth === "deep") {
        // The tone first duty: deep coloring stays in a deep season whatever
        // the undertone says, so a flip can never hand a deep skinned person a
        // light season (docs/00-product.md, the wedge).
        for (const detail of details) {
          if (!DEEP_SEASONS.includes(detail.season)) {
            problems.push(`${label}: deep coloring landed in ${detail.season}`);
          }
        }
        if (warm.season !== "deep_autumn") {
          problems.push(`${label}: warm and deep landed in ${warm.season}`);
        }
        if (cool.season !== "deep_winter") {
          problems.push(`${label}: cool and deep landed in ${cool.season}`);
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("never puts deep coloring in a light or soft season", () => {
    const lightOrSoft: readonly Season[] = [
      "light_spring",
      "light_summer",
      "soft_summer",
      "soft_autumn",
    ];
    const problems: string[] = [];
    for (const point of GRID) {
      for (const input of inputsFrom(point)) {
        const detail = deriveSeasonDetail(input);
        if (detail.depth === "deep" && lightOrSoft.includes(detail.season)) {
          problems.push(`${describeInput(input)}: landed in ${detail.season}`);
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("still returns a palette when the tone hex is unreadable", () => {
    const palette = derivePalette({
      skinToneHex: "not a hex",
      undertone: "neutral",
      eyeColorHex: null,
      hairColorHex: null,
      fitzpatrick: null,
    });
    expect(SEASONS).toContain(palette.season);
    expect(palette.wear.length).toBeGreaterThanOrEqual(8);
  });

  it("reads depth from Fitzpatrick alone when there is no tone hex", () => {
    const deep = deriveSeasonDetail({
      skinToneHex: "",
      undertone: "warm",
      eyeColorHex: null,
      hairColorHex: null,
      fitzpatrick: 6,
    });
    expect(deep.depth).toBe("deep");
    expect(deep.season).toBe("deep_autumn");
  });
});

/* ------------------------------------------------------------------ */
/* Every palette                                                       */
/* ------------------------------------------------------------------ */

const HEX = /^#[0-9a-f]{6}$/u;

/**
 * Every way a palette can be wrong, as a list of sentences. The grid runs this
 * roughly nineteen thousand times, so it collects problems and the test asserts
 * once, rather than making thirty assertions per palette.
 */
function paletteProblems(palette: Palette, label: string): string[] {
  const problems: string[] = [];
  const say = (message: string): void => {
    problems.push(`${label}: ${message}`);
  };

  // docs/01-user-flow.md section G items 4 and 5.
  if (palette.wear.length < 8 || palette.wear.length > 12) {
    say(`has ${palette.wear.length} colors to wear, not 8 to 12`);
  }
  if (palette.avoid.length < 4 || palette.avoid.length > 6) {
    say(`has ${palette.avoid.length} colors to avoid, not 4 to 6`);
  }

  const all: PaletteColor[] = [...palette.wear, ...palette.avoid];
  for (const color of all) {
    if (color.name.length === 0) {
      say(`has a color with no name (${color.hex})`);
    }
    if (!HEX.test(color.hex)) {
      say(`${color.name} has the hex ${color.hex}, not a lowercase six digit hex`);
    }
    if (color.why.length === 0) {
      say(`${color.name} has no why line`);
    }
  }

  const wearNames = palette.wear.map((color) => color.name);
  const avoidNames = palette.avoid.map((color) => color.name);
  const wearHexes = palette.wear.map((color) => color.hex);
  const avoidHexes = palette.avoid.map((color) => color.hex);

  // No color in both lists, by name and by hex.
  for (const name of avoidNames) {
    if (wearNames.includes(name)) {
      say(`${name} is in both lists`);
    }
  }
  for (const hex of avoidHexes) {
    if (wearHexes.includes(hex)) {
      say(`${hex} is in both lists`);
    }
  }

  // And no color twice inside one list.
  if (new Set(wearNames).size !== wearNames.length) {
    say("repeats a name in the colors to wear");
  }
  if (new Set(wearHexes).size !== wearHexes.length) {
    say("repeats a hex in the colors to wear");
  }
  if (new Set(avoidNames).size !== avoidNames.length) {
    say("repeats a name in the colors to avoid");
  }
  if (new Set(avoidHexes).size !== avoidHexes.length) {
    say("repeats a hex in the colors to avoid");
  }

  if (palette.seasonDisplayName.length === 0) {
    say("has no season display name");
  }
  if (palette.seasonLine.length === 0) {
    say("has no season line");
  }

  return problems;
}

describe("eval:palette every palette", () => {
  it("holds 8 to 12 colors to wear and 4 to 6 to keep away, with no overlap", () => {
    const problems = SEASONS.flatMap((season) =>
      paletteProblems(paletteForSeason(season), season),
    );
    expect(problems).toEqual([]);
  });

  it("holds for every point on the grid, under every undertone", () => {
    const reached = new Set<Season>();
    const problems: string[] = [];
    for (const point of GRID) {
      for (const input of inputsFrom(point)) {
        const palette = derivePalette(input);
        reached.add(palette.season);
        problems.push(...paletteProblems(palette, describeInput(input)));
      }
    }
    summary.seasonsReached = [...reached].sort();
    expect(problems.slice(0, 5)).toEqual([]);
    // Every season in the catalog is reachable from a real coloring, so no
    // season is decoration.
    expect(reached.size).toBe(SEASONS.length);
  });

  it("gives every season the same number of colors, deep seasons included", () => {
    const wearCounts = SEASONS.map(
      (season) => SEASON_PALETTES[season].wear.length,
    );
    const avoidCounts = SEASONS.map(
      (season) => SEASON_PALETTES[season].avoid.length,
    );
    summary.wearPerSeason = wearCounts[0] ?? 0;
    summary.avoidPerSeason = avoidCounts[0] ?? 0;

    // The tone first duty in a number: a deep season is never the thin list.
    expect(new Set(wearCounts).size).toBe(1);
    expect(new Set(avoidCounts).size).toBe(1);
    for (const season of DEEP_SEASONS) {
      expect(SEASON_PALETTES[season].wear.length).toBe(summary.wearPerSeason);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The words                                                           */
/* ------------------------------------------------------------------ */

/**
 * Plain names: one or two words, sentence case. "Olive", "Rust", "Cream",
 * "Deep teal". docs/01-user-flow.md section G item 4 and docs/02-design-system.md,
 * "Sentence case everywhere".
 */
const PLAIN_NAME = /^[A-Z][a-z]+(?: [a-z]+)?$/u;

function checkSentence(text: string, label: string): void {
  const violations = checkLexicon(text);
  expect(
    violations.map(describeViolation),
    `${label}: ${text}`,
  ).toEqual([]);
  expect(text.trim(), label).toBe(text);
  expect(text.endsWith("."), `${label} ends with a period: ${text}`).toBe(true);
  // One sentence, so one period and it is the last character.
  expect(text.split(".").length, `${label} is one sentence: ${text}`).toBe(2);
  expect(text.includes("  "), `${label} has a double space: ${text}`).toBe(
    false,
  );
  expect(text[0], `${label} starts sentence case: ${text}`).toBe(
    text[0]?.toUpperCase(),
  );
  expect(text.length, `${label} stays one line: ${text}`).toBeLessThanOrEqual(
    100,
  );
}

describe("eval:palette words", () => {
  it("names every season in plain words with a one sentence line", () => {
    for (const season of SEASONS) {
      const entry = SEASON_PALETTES[season];
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(checkLexicon(entry.displayName).map(describeViolation)).toEqual([]);
      checkSentence(entry.line, `${season} season line`);
      summary.wordsChecked += 2;
    }
  });

  it("keeps the deep autumn line the one docs/01-user-flow.md words", () => {
    // Section G item 3: "rich, warm, and grounded colors sit closest to your
    // skin", written as the sentence it renders as.
    expect(SEASON_PALETTES.deep_autumn.line).toBe(
      "Rich, warm, and grounded colors sit closest to your skin.",
    );
    // Section G item 5 gives this line as the example of an avoid reason.
    const icy = SEASON_PALETTES.deep_autumn.avoid.find(
      (color) => color.name === "Icy pink",
    );
    expect(icy?.why).toBe("Icy pastels wash you out.");
  });

  it("gives every color a plain name and one clean sentence of why", () => {
    for (const season of SEASONS) {
      const entry = SEASON_PALETTES[season];
      for (const color of [...entry.wear, ...entry.avoid]) {
        expect(color.name, `${season} name`).toMatch(PLAIN_NAME);
        checkSentence(color.why, `${season} ${color.name} why`);
        summary.wordsChecked += 1;
      }
    }
  });

  it("says why in words about the person, not about the color alone", () => {
    // docs/01-user-flow.md section G item 4 asks for "one line of why", and the
    // why is about this person: a line that names neither them nor their
    // coloring is a swatch caption, which is not what the screen is for. This is
    // a floor, not proof that a line reads well; the screenshot review is where
    // the writing itself gets judged.
    const coloringWords = ["you", "your", "skin", "coloring", "face", "hair"];
    for (const season of SEASONS) {
      const entry = SEASON_PALETTES[season];
      for (const color of [...entry.wear, ...entry.avoid]) {
        const why = color.why.toLowerCase();
        const namesTheColoring = coloringWords.some((word) =>
          new RegExp(`\\b${word}\\b`, "u").test(why),
        );
        expect(namesTheColoring, `${season} ${color.name}: ${color.why}`).toBe(
          true,
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

describe("eval:palette determinism", () => {
  it("returns the same palette for the same input, every time", () => {
    const problems: string[] = [];
    for (const point of GRID) {
      for (const input of inputsFrom(point)) {
        const first = JSON.stringify(derivePalette(input));
        const second = JSON.stringify(derivePalette({ ...input }));
        if (first !== second) {
          problems.push(`${describeInput(input)}: two calls, two palettes`);
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("does not hand out an array a caller can mutate into the next palette", () => {
    const input: PaletteInput = {
      skinToneHex: "#6b4a2f",
      undertone: "warm",
      eyeColorHex: "#3b2b22",
      hairColorHex: "#1e1613",
      fitzpatrick: 5,
    };
    const first = derivePalette(input);
    const before = first.wear.length;
    first.wear.pop();
    first.avoid.pop();
    const second = derivePalette(input);
    expect(second.wear).toHaveLength(before);
    expect(second.avoid.length).toBeGreaterThanOrEqual(4);
  });
});
