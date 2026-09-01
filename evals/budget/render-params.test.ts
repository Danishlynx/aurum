import { describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts. */
vi.mock("server-only", () => ({}));

import {
  canonicalAccessoryParams,
  canonicalClothParams,
  canonicalHairColorParams,
  canonicalHairstyleParams,
  canonicalJson,
  canonicalMakeupParams,
  canonicalSimulationParams,
  paramsHash,
} from "@/lib/server/renders/params";
import { simulationConcernsFor } from "@/lib/server/renders/simulation";
import { unitsForCall } from "@/lib/server/providers/perfectcorp/endpoints";
import { MAX_SIMULATED_CONCERNS } from "@/lib/shared/color-view";

/**
 * eval:budget, the render cache key.
 *
 * docs/03-architecture.md, "Caching": "Render params: (user_id, kind,
 * params_hash) is unique. Re selecting a shade or style returns the stored
 * render." docs/05-evals.md has this suite simulate a session of one capture set
 * plus six renders against the credit table, and this key is what keeps a shade
 * the person has already seen out of that total.
 *
 * Every assertion here is about not spending a credit twice for the same
 * picture, and about never serving one person's face for another request.
 */

const CAPTURE = "b3f1e0c2-1111-4a2b-8c3d-000000000001";

function makeup(
  categories: ReadonlyArray<{
    category: "lip" | "blush" | "foundation" | "eye";
    shadeHex: string;
    shadeName: string;
  }>,
) {
  return canonicalMakeupParams({
    captureId: CAPTURE,
    params: { categories: [...categories] },
  });
}

const LIP = {
  category: "lip",
  shadeHex: "#9c4a1e",
  shadeName: "Rust",
} as const;
const EYE = {
  category: "eye",
  shadeHex: "#5b5a2a",
  shadeName: "Olive",
} as const;

describe("render params, canonical JSON", () => {
  it("sorts object keys so key order cannot change a hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1}}');
  });

  it("keeps array order, because order is meaning", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  it("writes null for undefined rather than dropping the value", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("render params, the hash", () => {
  it("is a 64 character lowercase hex digest, as migration 0003 expects", () => {
    const hash = paramsHash("makeup", makeup([LIP]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gives the same hash for the same look asked for in a different order", () => {
    expect(paramsHash("makeup", makeup([LIP, EYE]))).toBe(
      paramsHash("makeup", makeup([EYE, LIP])),
    );
  });

  it("ignores the case of a hex, because #9C4A1E is the same colour", () => {
    expect(paramsHash("makeup", makeup([LIP]))).toBe(
      paramsHash("makeup", makeup([{ ...LIP, shadeHex: "#9C4A1E" }])),
    );
  });

  it("ignores the shade name, because renaming a swatch is not a new render", () => {
    expect(paramsHash("makeup", makeup([LIP]))).toBe(
      paramsHash("makeup", makeup([{ ...LIP, shadeName: "Burnt rust" }])),
    );
  });

  it("changes with the colour", () => {
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("makeup", makeup([{ ...LIP, shadeHex: "#7a3a17" }])),
    );
  });

  it("changes with the number of categories in the look", () => {
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("makeup", makeup([LIP, EYE])),
    );
  });

  it("changes with the capture, so a new selfie never serves the old face", () => {
    const other = canonicalMakeupParams({
      captureId: "b3f1e0c2-1111-4a2b-8c3d-000000000002",
      params: { categories: [LIP] },
    });
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("makeup", other),
    );
  });

  it("changes with the kind, so two render types never share a row", () => {
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("hairstyle", makeup([LIP])),
    );
  });

  it("stores the shade name it does not hash, for the pending line", () => {
    const stored = makeup([LIP]);
    expect(stored.categories[0]?.shadeName).toBe("Rust");
    expect(stored.categories[0]?.shadeHex).toBe("#9c4a1e");
  });
});

/*
 * The hair kinds, Layer 3. A hairstyle render costs 2 units, twice a makeup one
 * (docs/04-integrations.md), so the cache key matters twice as much here: four
 * styles and two colours is a whole judge session's six renders.
 */

function hairstyle(styleId: string, captureId = CAPTURE) {
  return canonicalHairstyleParams({ captureId, params: { styleId } });
}

function hairColor(
  params: { styleId: string; colorHex: string; colorName: string },
  captureId = CAPTURE,
) {
  return canonicalHairColorParams({ captureId, params });
}

const CHESTNUT = {
  styleId: "textured-crop",
  colorHex: "#6b3f24",
  colorName: "Warm chestnut",
} as const;

describe("render params, hairstyle", () => {
  it("is a 64 character lowercase hex digest, as migration 0003 expects", () => {
    expect(paramsHash("hairstyle", hairstyle("textured-crop"))).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("gives the same hash for the same style, so a second look is free", () => {
    expect(paramsHash("hairstyle", hairstyle("textured-crop"))).toBe(
      paramsHash("hairstyle", hairstyle("  Textured-Crop ")),
    );
  });

  it("changes with the style", () => {
    expect(paramsHash("hairstyle", hairstyle("textured-crop"))).not.toBe(
      paramsHash("hairstyle", hairstyle("curtain-fringe")),
    );
  });

  it("changes with the capture, so a new selfie never serves the old face", () => {
    expect(paramsHash("hairstyle", hairstyle("textured-crop"))).not.toBe(
      paramsHash(
        "hairstyle",
        hairstyle("textured-crop", "b3f1e0c2-1111-4a2b-8c3d-000000000002"),
      ),
    );
  });
});

describe("render params, hair color", () => {
  it("is a 64 character lowercase hex digest", () => {
    expect(paramsHash("hair_color", hairColor(CHESTNUT))).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("ignores the case of a hex and the colour name, the same as a shade", () => {
    expect(paramsHash("hair_color", hairColor(CHESTNUT))).toBe(
      paramsHash(
        "hair_color",
        hairColor({ ...CHESTNUT, colorHex: "#6B3F24", colorName: "Chestnut" }),
      ),
    );
  });

  it("changes with the style, because a colour is rendered on a style", () => {
    expect(paramsHash("hair_color", hairColor(CHESTNUT))).not.toBe(
      paramsHash(
        "hair_color",
        hairColor({ ...CHESTNUT, styleId: "curtain-fringe" }),
      ),
    );
  });

  it("changes with the colour", () => {
    expect(paramsHash("hair_color", hairColor(CHESTNUT))).not.toBe(
      paramsHash("hair_color", hairColor({ ...CHESTNUT, colorHex: "#8a3c1f" })),
    );
  });

  it("never collides with the hairstyle render of the same style", () => {
    expect(paramsHash("hair_color", hairColor(CHESTNUT))).not.toBe(
      paramsHash("hairstyle", hairstyle(CHESTNUT.styleId)),
    );
  });

  it("stores the colour name it does not hash, for the pending line", () => {
    const stored = hairColor(CHESTNUT);
    expect(stored.colorName).toBe("Warm chestnut");
    expect(stored.colorHex).toBe("#6b3f24");
    expect(stored.styleId).toBe("textured-crop");
  });
});

/*
 * The Layer 6 kinds. A skin simulation is the dearest render in the credit table
 * (4 units for up to four concerns against 1 for a makeup try on,
 * docs/04-integrations.md), so its cache key is worth four times a shade's, and
 * an accessory sits on the same garment id a cloth render does, which is the one
 * place two kinds could collide on a row.
 */

const GARMENT = "c4f2e1d3-2222-4b3c-9d4e-000000000001";

function simulation(concerns: readonly string[], captureId = CAPTURE) {
  return canonicalSimulationParams({ captureId, concerns });
}

function accessory(category: string, captureId = CAPTURE) {
  return canonicalAccessoryParams({
    captureId,
    garmentId: GARMENT,
    category,
  });
}

describe("render params, skin simulation", () => {
  it("is a 64 character lowercase hex digest", () => {
    expect(paramsHash("skin_simulation", simulation(["texture"]))).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("gives the same hash for the same concerns in a different order", () => {
    expect(
      paramsHash("skin_simulation", simulation(["texture", "pores"])),
    ).toBe(paramsHash("skin_simulation", simulation(["pores", "texture"])));
  });

  it("drops a repeated concern rather than paying for it twice", () => {
    expect(simulation(["texture", "texture"]).concerns).toEqual(["texture"]);
  });

  it("changes with the concerns, because that is a different picture", () => {
    expect(paramsHash("skin_simulation", simulation(["texture"]))).not.toBe(
      paramsHash("skin_simulation", simulation(["texture", "pores"])),
    );
  });

  it("changes with the capture, so a new selfie never serves the old face", () => {
    expect(paramsHash("skin_simulation", simulation(["texture"]))).not.toBe(
      paramsHash(
        "skin_simulation",
        simulation(["texture"], "b3f1e0c2-1111-4a2b-8c3d-000000000002"),
      ),
    );
  });
});

describe("skin simulation, how many concerns one projection asks for", () => {
  it("keeps the report's own order and drops what the engine cannot simulate", () => {
    // Pigmentation and uneven tone lead a tone first report but are not among
    // the ten concerns docs/04-integrations.md records as simulatable, so the
    // projection covers the ones underneath them rather than swapping in
    // something the reading never named.
    expect(
      simulationConcernsFor([
        "pigmentation",
        "uneven_tone",
        "dark_spots",
        "texture",
      ]),
    ).toEqual(["dark_spots", "texture"]);
  });

  it("stops at four, which is the whole of the cheaper credit tier", () => {
    const chosen = simulationConcernsFor([
      "texture",
      "pores",
      "oiliness",
      "acne",
      "redness",
      "wrinkles",
    ]);
    expect(chosen).toHaveLength(MAX_SIMULATED_CONCERNS);
    expect(unitsForCall("skinSimulation", chosen.length)).toBe(4);
  });

  it("asks for nothing when no concern can be simulated, so nothing is spent", () => {
    expect(simulationConcernsFor(["pigmentation", "uneven_tone"])).toEqual([]);
  });
});

describe("render params, accessory", () => {
  it("is a 64 character lowercase hex digest", () => {
    expect(paramsHash("accessory", accessory("earrings"))).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("changes with the category, because it is a different endpoint", () => {
    expect(paramsHash("accessory", accessory("earrings"))).not.toBe(
      paramsHash("accessory", accessory("bag")),
    );
  });

  it("ignores the case of a category the way a hex is ignored", () => {
    expect(paramsHash("accessory", accessory("earrings"))).toBe(
      paramsHash("accessory", accessory("Earrings")),
    );
  });

  it("never collides with the cloth render of the same garment", () => {
    const cloth = canonicalClothParams({
      captureId: CAPTURE,
      garmentId: GARMENT,
      garmentCategory: "upper_body",
    });
    expect(paramsHash("accessory", accessory("bag"))).not.toBe(
      paramsHash("cloth", cloth),
    );
  });
});
