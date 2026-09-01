import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * The demo fixture wardrobe is a module under src/lib/server, which imports
 * "server-only" and throws outside a React server environment. The mock replaces
 * that marker package and nothing else, so the fixture the wardrobe actually
 * serves is the one checked here. Same approach as evals/safety/safety.test.ts.
 */
vi.mock("server-only", () => ({}));

import {
  DEMO_FIXTURE_GARMENT_IMAGES,
  DEMO_FIXTURE_WARDROBE,
  fixtureGarmentImagePath,
  fixtureGarmentSvg,
} from "@/lib/server/profile/demo-fixture-wardrobe";

import { checkLexicon, describeViolation } from "./lexicon";
import {
  FORMALITY,
  GARMENT_TYPES,
  garmentClassificationStatus,
  garmentFormalityLabel,
  garmentPatchRequestSchema,
  garmentPatternLabel,
  garmentTypeLabel,
  isGarmentFormality,
  isGarmentPattern,
  isGarmentType,
  MAX_GARMENT_COLORS,
  MAX_GARMENTS_PER_REQUEST,
  PATTERNS,
  garmentCreateRequestSchema,
} from "./wardrobe-view";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGES_DIR = resolve(REPO_ROOT, "evals", "fixtures", "garments", "images");

describe("garment vocabularies", () => {
  it("holds the words the shared contract names", () => {
    expect([...GARMENT_TYPES]).toEqual([
      "shirt",
      "t_shirt",
      "blouse",
      "top",
      "sweater",
      "jacket",
      "blazer",
      "coat",
      "dress",
      "skirt",
      "trousers",
      "jeans",
      "shorts",
      "shoes",
      "accessory",
    ]);
    expect([...PATTERNS]).toEqual([
      "solid",
      "stripe",
      "check",
      "floral",
      "print",
      "texture",
    ]);
    expect([...FORMALITY]).toEqual(["casual", "smart", "formal"]);
  });

  it("recognizes only its own words", () => {
    expect(isGarmentType("blazer")).toBe(true);
    expect(isGarmentType("cardigan")).toBe(false);
    expect(isGarmentPattern("texture")).toBe(true);
    expect(isGarmentPattern("paisley")).toBe(false);
    expect(isGarmentFormality("smart")).toBe(true);
    expect(isGarmentFormality("black tie")).toBe(false);
  });

  it("labels every word, and nothing else", () => {
    for (const type of GARMENT_TYPES) {
      expect(garmentTypeLabel(type)).not.toBeNull();
    }
    for (const pattern of PATTERNS) {
      expect(garmentPatternLabel(pattern)).not.toBeNull();
    }
    for (const formality of FORMALITY) {
      expect(garmentFormalityLabel(formality)).not.toBeNull();
    }
    expect(garmentTypeLabel("cardigan")).toBeNull();
    expect(garmentTypeLabel(null)).toBeNull();
  });

  it("writes the labels in the same voice as copy.ts", () => {
    const labels = [
      ...GARMENT_TYPES.map((type) => garmentTypeLabel(type)),
      ...PATTERNS.map((pattern) => garmentPatternLabel(pattern)),
      ...FORMALITY.map((formality) => garmentFormalityLabel(formality)),
    ];
    for (const label of labels) {
      expect(label).not.toBeNull();
      const value = label ?? "";
      for (const violation of checkLexicon(value)) {
        throw new Error(`${value}: ${describeViolation(violation)}`);
      }
      // Sentence case: one leading capital, no shouting.
      expect(value).not.toBe(value.toUpperCase());
    }
  });
});

describe("garmentClassificationStatus", () => {
  it("shows the skeleton chips while a job is open", () => {
    expect(
      garmentClassificationStatus({ hasType: false, jobStatus: "pending" }),
    ).toBe("pending");
    expect(
      garmentClassificationStatus({ hasType: true, jobStatus: "running" }),
    ).toBe("pending");
  });

  it("shows the failed card only when nothing was read", () => {
    expect(
      garmentClassificationStatus({ hasType: false, jobStatus: "failed" }),
    ).toBe("failed");
    // The person filled the chips in after the failure, so the card is done.
    expect(
      garmentClassificationStatus({ hasType: true, jobStatus: "failed" }),
    ).toBe("succeeded");
  });

  it("treats an uploaded but never classified garment as pending", () => {
    expect(
      garmentClassificationStatus({ hasType: false, jobStatus: null }),
    ).toBe("pending");
  });

  it("treats attributes with no job as done, which is the fixture case", () => {
    expect(garmentClassificationStatus({ hasType: true, jobStatus: null })).toBe(
      "succeeded",
    );
  });
});

describe("request schemas", () => {
  it("bounds how many garments one add flow may claim", () => {
    expect(garmentCreateRequestSchema.safeParse({ count: 1 }).success).toBe(true);
    expect(
      garmentCreateRequestSchema.safeParse({ count: MAX_GARMENTS_PER_REQUEST })
        .success,
    ).toBe(true);
    expect(
      garmentCreateRequestSchema.safeParse({
        count: MAX_GARMENTS_PER_REQUEST + 1,
      }).success,
    ).toBe(false);
    expect(garmentCreateRequestSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(garmentCreateRequestSchema.safeParse({ count: 2.5 }).success).toBe(false);
  });

  it("refuses a correction that changes no chip", () => {
    expect(garmentPatchRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts one chip at a time", () => {
    expect(garmentPatchRequestSchema.safeParse({ type: "blazer" }).success).toBe(
      true,
    );
    expect(
      garmentPatchRequestSchema.safeParse({ formality: "smart" }).success,
    ).toBe(true);
  });

  it("refuses a word outside the vocabulary", () => {
    expect(
      garmentPatchRequestSchema.safeParse({ type: "cardigan" }).success,
    ).toBe(false);
    expect(
      garmentPatchRequestSchema.safeParse({ pattern: "paisley" }).success,
    ).toBe(false);
    expect(
      garmentPatchRequestSchema.safeParse({ formality: "black tie" }).success,
    ).toBe(false);
  });

  it("bounds the colour list and checks the hex", () => {
    const colors = Array.from({ length: MAX_GARMENT_COLORS }, () => ({
      name: "Navy",
      hex: "#1f2a44",
    }));
    expect(garmentPatchRequestSchema.safeParse({ colors }).success).toBe(true);
    expect(
      garmentPatchRequestSchema.safeParse({ colors: [...colors, colors[0]] })
        .success,
    ).toBe(false);
    expect(garmentPatchRequestSchema.safeParse({ colors: [] }).success).toBe(false);
    expect(
      garmentPatchRequestSchema.safeParse({
        colors: [{ name: "Navy", hex: "navy" }],
      }).success,
    ).toBe(false);
  });
});

describe("the demo fixture wardrobe", () => {
  it("holds the six garments docs/07 promises", () => {
    expect(DEMO_FIXTURE_WARDROBE.garments).toHaveLength(6);
  });

  it("uses only vocabulary the screen can draw", () => {
    for (const garment of DEMO_FIXTURE_WARDROBE.garments) {
      expect(garment.type).not.toBeNull();
      expect(isGarmentType(garment.type ?? "")).toBe(true);
      expect(isGarmentPattern(garment.pattern ?? "")).toBe(true);
      expect(isGarmentFormality(garment.formality ?? "")).toBe(true);
      expect(garment.colors.length).toBeGreaterThan(0);
      expect(garment.colors.length).toBeLessThanOrEqual(MAX_GARMENT_COLORS);
      for (const color of garment.colors) {
        expect(color.hex).toMatch(/^#[0-9a-f]{6}$/u);
      }
    }
  });

  it("declares every card as read, because every attribute is written down", () => {
    for (const garment of DEMO_FIXTURE_WARDROBE.garments) {
      expect(garment.classificationStatus).toBe("succeeded");
      // Nobody corrected a chip: the values were written by hand, not fixed up.
      expect(garment.userEdited).toBe(false);
    }
  });

  it("points every card at a same origin image path", () => {
    for (const garment of DEMO_FIXTURE_WARDROBE.garments) {
      expect(garment.imageUrl).toBe(fixtureGarmentImagePath(garment.id));
      expect(garment.imageUrl?.startsWith("/api/wardrobe/images/")).toBe(true);
    }
  });

  it("has a silhouette for every card and nothing for anything else", () => {
    for (const garment of DEMO_FIXTURE_WARDROBE.garments) {
      expect(fixtureGarmentSvg(garment.id)).not.toBeNull();
    }
    expect(fixtureGarmentSvg("fixture-g99")).toBeNull();
    expect(fixtureGarmentSvg("../../etc/passwd")).toBeNull();
  });

  it("writes colour names in the same voice as copy.ts", () => {
    for (const garment of DEMO_FIXTURE_WARDROBE.garments) {
      for (const color of garment.colors) {
        for (const violation of checkLexicon(color.name)) {
          throw new Error(`${color.name}: ${describeViolation(violation)}`);
        }
      }
    }
  });

  it("matches the checked in copies under evals/fixtures byte for byte", () => {
    // The module is the source of truth; the files are readable copies. If this
    // fails, update the files from the module, not the other way round.
    expect(DEMO_FIXTURE_GARMENT_IMAGES).toHaveLength(6);
    for (const image of DEMO_FIXTURE_GARMENT_IMAGES) {
      const onDisk = readFileSync(resolve(IMAGES_DIR, image.fileName), "utf8");
      expect(onDisk, `${image.fileName} has drifted from the module`).toBe(
        image.svg,
      );
    }
  });

  it("draws shapes, never a photograph or a script", () => {
    for (const image of DEMO_FIXTURE_GARMENT_IMAGES) {
      expect(image.svg).toContain("Synthetic placeholder");
      expect(image.svg).not.toContain("<script");
      expect(image.svg).not.toContain("<image");
      expect(image.svg).not.toContain("href");
    }
  });
});
