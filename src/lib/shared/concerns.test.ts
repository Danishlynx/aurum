import { describe, expect, it } from "vitest";

import { copy } from "./copy";
import {
  CONCERN_KEYS,
  CONCERN_DISPLAY_NAMES,
  TONE_FIRST_COMPARABLE_BAND,
  TONE_FIRST_CONCERNS,
  QUALITY_CONCERN_KEYS,
  TONE_FIRST_DEPRIORITIZED,
  VERIFIED_SD_SKIN_CONCERN_TYPES,
  concernDescription,
  concernDisplayName,
  isConcernKey,
  isFitzpatrickType,
  isNonConcernOutputType,
  mapProviderConcern,
  normalizeProviderConcernName,
  parseProviderConcernName,
  presenceScoreFor,
  rankConcernsToneFirst,
  toneFirstApplies,
  topConcern,
  type ConcernKey,
  type ConcernScore,
  type FitzpatrickType,
} from "./concerns";

describe("concern keys", () => {
  it("has no duplicate keys", () => {
    expect(new Set(CONCERN_KEYS).size).toBe(CONCERN_KEYS.length);
  });

  it("recognizes its own keys and rejects others", () => {
    for (const key of CONCERN_KEYS) {
      expect(isConcernKey(key)).toBe(true);
    }
    expect(isConcernKey("not_a_concern")).toBe(false);
    expect(isConcernKey("")).toBe(false);
  });

  it("takes every display name and description from copy.ts", () => {
    for (const key of CONCERN_KEYS) {
      expect(concernDisplayName(key)).toBe(copy.report.concerns[key].name);
      expect(concernDescription(key)).toBe(
        copy.report.concerns[key].description,
      );
      expect(concernDisplayName(key).length).toBeGreaterThan(0);
      expect(concernDescription(key).length).toBeGreaterThan(0);
    }
  });

  it("exposes the same names as a map", () => {
    expect(Object.keys(CONCERN_DISPLAY_NAMES).sort()).toEqual(
      [...CONCERN_KEYS].sort(),
    );
    for (const key of CONCERN_KEYS) {
      expect(CONCERN_DISPLAY_NAMES[key]).toBe(concernDisplayName(key));
    }
  });

  it("names concerns in sentence case, with no trailing period", () => {
    for (const key of CONCERN_KEYS) {
      const name = concernDisplayName(key);
      expect(name).toBe(name.trim());
      expect(name.endsWith(".")).toBe(false);
      expect(name).not.toBe(name.toUpperCase());
      expect(name[0]).toBe(name[0]?.toUpperCase());
    }
  });

  it("uses the four mask toggle names quoted in docs/01-user-flow.md", () => {
    expect(concernDisplayName("pigmentation")).toBe("Pigmentation");
    expect(concernDisplayName("texture")).toBe("Texture");
    expect(concernDisplayName("pores")).toBe("Pores");
    expect(concernDisplayName("redness")).toBe("Redness");
  });
});

describe("fitzpatrick", () => {
  it("accepts 1 to 6 and nothing else", () => {
    for (const value of [1, 2, 3, 4, 5, 6]) {
      expect(isFitzpatrickType(value)).toBe(true);
    }
    for (const value of [0, 7, -1, 3.5]) {
      expect(isFitzpatrickType(value)).toBe(false);
    }
  });
});

describe("normalizeProviderConcernName", () => {
  it("lowercases and collapses separators", () => {
    expect(normalizeProviderConcernName("Dark Circles")).toBe("dark_circles");
    expect(normalizeProviderConcernName("wrinkle-forehead")).toBe(
      "wrinkle_forehead",
    );
    expect(normalizeProviderConcernName("  Pore   Nose  ")).toBe("pore_nose");
    expect(normalizeProviderConcernName("eyeBag")).toBe("eyebag");
  });

  it("returns an empty string for a name with nothing in it", () => {
    expect(normalizeProviderConcernName("   ")).toBe("");
    expect(normalizeProviderConcernName("---")).toBe("");
  });
});

describe("parseProviderConcernName", () => {
  it("maps a plain name with no region", () => {
    expect(parseProviderConcernName("Redness")).toEqual({
      normalized: "redness",
      key: "redness",
      region: null,
    });
  });

  it("splits a region off a per region concern", () => {
    expect(parseProviderConcernName("wrinkle_forehead")).toEqual({
      normalized: "wrinkle_forehead",
      key: "wrinkles",
      region: "forehead",
    });
    expect(parseProviderConcernName("pore_nose")).toEqual({
      normalized: "pore_nose",
      key: "pores",
      region: "nose",
    });
    expect(parseProviderConcernName("Pore T Zone")).toEqual({
      normalized: "pore_t_zone",
      key: "pores",
      region: "t_zone",
    });
  });

  it("maps the provider names docs/04-integrations.md lists", () => {
    expect(mapProviderConcern("age_spot")).toBe("dark_spots");
    expect(mapProviderConcern("oiliness")).toBe("oiliness");
    expect(mapProviderConcern("moisture")).toBe("moisture");
    expect(mapProviderConcern("dark_circle")).toBe("dark_circles");
    expect(mapProviderConcern("eye_bag")).toBe("eye_bags");
    expect(mapProviderConcern("droopy_upper_eyelid")).toBe("eyelid_droop");
    expect(mapProviderConcern("firmness")).toBe("firmness");
    expect(mapProviderConcern("texture")).toBe("texture");
    expect(mapProviderConcern("acne")).toBe("acne");
    expect(mapProviderConcern("radiance")).toBe("radiance");
    expect(mapProviderConcern("tear_trough")).toBe("tear_trough");
  });

  it("maps every scored name the live API returned on 2026-09-02", () => {
    /*
     * The list is the provider's own, recorded in
     * evals/fixtures/perfectcorp/skin-analysis-status.json. Two of these used to
     * fall through and their readings were dropped from the report:
     * dark_circle_v2 (the v2 is a model version, not a different concern) and
     * droopy_lower_eyelid (only the upper lid had a row).
     */
    const unmapped = VERIFIED_SD_SKIN_CONCERN_TYPES.filter(
      (type) => mapProviderConcern(type) === null,
    );
    expect(unmapped).toEqual([]);
    expect(mapProviderConcern("dark_circle_v2")).toBe("dark_circles");
    expect(mapProviderConcern("droopy_lower_eyelid")).toBe("eyelid_droop");
  });

  it("keeps the non concern outputs out of the concern list", () => {
    for (const type of ["all", "skin_age", "skin_type", "resize_image"]) {
      expect(mapProviderConcern(type)).toBeNull();
      expect(isNonConcernOutputType(type)).toBe(true);
    }
    // An unknown concern name is a warning, not a known non concern.
    expect(isNonConcernOutputType("hydration_index_v2")).toBe(false);
  });

  it("returns null for a name it does not know, rather than guessing", () => {
    expect(mapProviderConcern("hydration_index_v2")).toBeNull();
    expect(mapProviderConcern("")).toBeNull();
    expect(parseProviderConcernName("unknown_forehead").key).toBeNull();
  });
});

describe("presenceScoreFor", () => {
  const presence = (key: ConcernKey | null, providerUiScore: number): number =>
    presenceScoreFor({ key, providerUiScore });

  it("inverts a condition score into a presence score", () => {
    /*
     * The numbers are the ones measured on 2026-09-02. redness came back at 99,
     * which on the provider's scale means almost none of it, and dark_circle_v2
     * at 70, the lowest score on that face and therefore its worst concern.
     */
    expect(presence("redness", 99)).toBe(1);
    expect(presence("dark_circles", 70)).toBe(30);
    expect(presence("eye_bags", 80)).toBe(20);
    expect(presence("firmness", 75)).toBe(25);
  });

  it("orders the measured face the way the report has to show it", () => {
    expect(presence("dark_circles", 70)).toBeGreaterThan(presence("redness", 99));
    expect(presence("dark_circles", 70)).toBeGreaterThan(presence("acne", 99));
  });

  it("leaves the quality concerns alone, so hydration still reads as hydration", () => {
    for (const key of QUALITY_CONCERN_KEYS) {
      expect(presence(key, 77)).toBe(77);
      expect(presence(key, 12)).toBe(12);
    }
  });

  it("inverts an unmapped concern too, rather than passing it through", () => {
    expect(presence(null, 90)).toBe(10);
  });

  it("rounds to a whole number and clamps into 1 to 100", () => {
    expect(presence("pores", 96.31306433677672)).toBe(4);
    expect(presence("acne", 100)).toBe(1);
    expect(presence("acne", 0)).toBe(100);
    expect(presence("acne", 140)).toBe(1);
    expect(presence("acne", Number.NaN)).toBe(100);
  });
});

describe("rankConcernsToneFirst", () => {
  const rank = (
    concerns: readonly ConcernScore[],
    fitzpatrick: FitzpatrickType | null,
  ): ConcernKey[] =>
    rankConcernsToneFirst(concerns, fitzpatrick).map((entry) => entry.key);

  it("returns contiguous ranks starting at 1", () => {
    const ranked = rankConcernsToneFirst(
      [
        { key: "texture", score: 40 },
        { key: "pores", score: 30 },
        { key: "redness", score: 20 },
      ],
      3,
    );
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it("handles an empty list", () => {
    expect(rankConcernsToneFirst([], 5)).toEqual([]);
    expect(topConcern([])).toBeNull();
  });

  it("does not mutate its input", () => {
    const input: ConcernScore[] = [
      { key: "wrinkles", score: 70 },
      { key: "pigmentation", score: 62 },
    ];
    const snapshot = JSON.stringify(input);
    rankConcernsToneFirst(input, 5);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is deterministic", () => {
    const input: ConcernScore[] = [
      { key: "wrinkles", score: 70 },
      { key: "pigmentation", score: 62 },
      { key: "texture", score: 62 },
      { key: "redness", score: 55 },
      { key: "dark_spots", score: 51 },
    ];
    const first = rankConcernsToneFirst(input, 5);
    const second = rankConcernsToneFirst([...input].reverse(), 5);
    expect(second).toEqual(first);
  });

  it("ranks by score alone when the fitzpatrick type is I to III", () => {
    expect(
      rank(
        [
          { key: "wrinkles", score: 70 },
          { key: "pigmentation", score: 62 },
        ],
        2,
      ),
    ).toEqual(["wrinkles", "pigmentation"]);
  });

  it("ranks by score alone when the fitzpatrick type is unknown", () => {
    expect(
      rank(
        [
          { key: "wrinkles", score: 70 },
          { key: "pigmentation", score: 62 },
        ],
        null,
      ),
    ).toEqual(["wrinkles", "pigmentation"]);
  });

  it("puts a tone concern above wrinkles for fitzpatrick IV to VI when the scores are comparable", () => {
    for (const type of [4, 5, 6] as const) {
      expect(
        rank(
          [
            { key: "wrinkles", score: 70 },
            { key: "pigmentation", score: 62 },
          ],
          type,
        ),
      ).toEqual(["pigmentation", "wrinkles"]);
    }
  });

  it("puts a tone concern above redness on the same rule", () => {
    expect(
      rank(
        [
          { key: "redness", score: 48 },
          { key: "uneven_tone", score: 40 },
        ],
        6,
      ),
    ).toEqual(["uneven_tone", "redness"]);
  });

  it("marks the promoted concern and leaves the others unmarked", () => {
    const ranked = rankConcernsToneFirst(
      [
        { key: "wrinkles", score: 70 },
        { key: "pigmentation", score: 62 },
      ],
      5,
    );
    expect(ranked[0]?.key).toBe("pigmentation");
    expect(ranked[0]?.promotedByToneFirst).toBe(true);
    expect(ranked[1]?.promotedByToneFirst).toBe(false);
  });

  it("promotes exactly at the edge of the band and not past it", () => {
    const atTheEdge = rank(
      [
        { key: "wrinkles", score: 70 },
        { key: "pigmentation", score: 70 - TONE_FIRST_COMPARABLE_BAND },
      ],
      5,
    );
    expect(atTheEdge).toEqual(["pigmentation", "wrinkles"]);

    const pastTheEdge = rank(
      [
        { key: "wrinkles", score: 70 },
        { key: "pigmentation", score: 70 - TONE_FIRST_COMPARABLE_BAND - 1 },
      ],
      5,
    );
    expect(pastTheEdge).toEqual(["wrinkles", "pigmentation"]);
  });

  it("leaves concerns outside both groups where their score puts them", () => {
    expect(
      rank(
        [
          { key: "texture", score: 80 },
          { key: "wrinkles", score: 70 },
          { key: "pigmentation", score: 62 },
          { key: "pores", score: 20 },
        ],
        5,
      ),
    ).toEqual(["texture", "pigmentation", "wrinkles", "pores"]);
  });

  it("keeps the relative order of tone concerns when it promotes several", () => {
    expect(
      rank(
        [
          { key: "wrinkles", score: 70 },
          { key: "pigmentation", score: 65 },
          { key: "dark_spots", score: 60 },
        ],
        5,
      ),
    ).toEqual(["pigmentation", "dark_spots", "wrinkles"]);
  });

  it("promotes above the highest deprioritized concern it outranks", () => {
    expect(
      rank(
        [
          { key: "redness", score: 66 },
          { key: "wrinkles", score: 64 },
          { key: "pigmentation", score: 58 },
        ],
        5,
      ),
    ).toEqual(["pigmentation", "redness", "wrinkles"]);
  });

  it("breaks ties on the concern key, alphabetically", () => {
    expect(
      rank(
        [
          { key: "texture", score: 50 },
          { key: "moisture", score: 50 },
          { key: "pores", score: 50 },
        ],
        1,
      ),
    ).toEqual(["moisture", "pores", "texture"]);
  });

  it("keeps the highest score when a key appears twice", () => {
    const ranked = rankConcernsToneFirst(
      [
        { key: "pores", score: 30 },
        { key: "pores", score: 70 },
      ],
      3,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.score).toBe(70);
  });

  it("reports toneFirstApplies for the right types", () => {
    expect(toneFirstApplies(3)).toBe(false);
    expect(toneFirstApplies(4)).toBe(true);
    expect(toneFirstApplies(6)).toBe(true);
    expect(toneFirstApplies(null)).toBe(false);
  });

  /**
   * The rule as an invariant, over a fixed set of generated cases. The
   * generator is a seeded linear congruential sequence, so the cases are the
   * same on every machine and on every run.
   */
  it("never leaves a deprioritized concern above a comparable tone concern for fitzpatrick IV to VI", () => {
    // MINSTD. Every product stays inside the exact integer range of a double,
    // so the sequence is identical on every machine.
    let seed = 20260901;
    const next = (bound: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % bound;
    };

    for (let round = 0; round < 400; round += 1) {
      const concerns: ConcernScore[] = CONCERN_KEYS.filter(
        () => next(3) > 0,
      ).map((key) => ({ key, score: next(100) + 1 }));
      if (concerns.length === 0) {
        continue;
      }
      const type = ((next(3) + 4) as 4 | 5 | 6);
      const ranked = rankConcernsToneFirst(concerns, type);

      for (let i = 0; i < ranked.length; i += 1) {
        for (let j = i + 1; j < ranked.length; j += 1) {
          const above = ranked[i];
          const below = ranked[j];
          if (above === undefined || below === undefined) {
            continue;
          }
          if (
            TONE_FIRST_DEPRIORITIZED.includes(above.key) &&
            TONE_FIRST_CONCERNS.includes(below.key)
          ) {
            expect(below.score).toBeLessThan(
              above.score - TONE_FIRST_COMPARABLE_BAND,
            );
          }
        }
      }
    }
  });
});
