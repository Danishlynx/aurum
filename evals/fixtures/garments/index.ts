import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  FORMALITY,
  GARMENT_TYPES,
  PATTERNS,
  type GarmentView,
} from "@/lib/shared/wardrobe-view";

/**
 * The 20 garment fixtures and the six garment demo wardrobe, loaded and
 * validated.
 *
 * docs/05-evals.md, "Fixtures": "evals/fixtures/garments: 20 garment photos with
 * human labeled type, dominant colors, pattern, formality." The labels are here;
 * the photos are not, and README.md in this folder says what is missing and what
 * that means for a passing run.
 *
 * SYNTHETIC, all 20. None of them came from a person, a photo, or a model.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Lowercase six digit hex, the way the palette catalog is written. */
const hexSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

/**
 * The labels are validated against the wardrobe layer's own vocabularies, so a
 * fixture can never hold a word the app cannot store, and a word removed from
 * the vocabulary fails this loader rather than sitting quietly in a JSON file.
 */
const garmentLabelSchema = z.object({
  type: z.enum(GARMENT_TYPES),
  colors: z
    .array(z.object({ name: z.string().min(1), hex: hexSchema }))
    .min(1)
    .max(3),
  pattern: z.enum(PATTERNS),
  formality: z.enum(FORMALITY),
});

const garmentFixtureSchema = z.object({
  id: z.string().regex(/^g\d{2}$/u),
  synthetic: z.literal(true),
  description: z.string().min(1),
  inDemoWardrobe: z.boolean(),
  /** The photo beside this file, or null while there is none. */
  photoFile: z.string().min(1).nullable(),
  /** Text visible in the photo. Data about the garment, never an instruction. */
  printedText: z.string().min(1).nullable(),
  injection: z.boolean(),
  covers: z.array(z.string().min(1)).min(1),
  label: garmentLabelSchema,
});

const labelsFileSchema = z.object({
  _aurum_fixture: z.object({
    synthetic: z.literal(true),
    note: z.string().min(1),
    covers: z.array(z.string().min(1)).min(1),
  }),
  garments: z.array(garmentFixtureSchema).length(20),
});

export type GarmentFixture = z.infer<typeof garmentFixtureSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** All 20, in file order. Throws when the file does not match the shape. */
export function loadGarmentFixtures(): GarmentFixture[] {
  const parsed = labelsFileSchema.safeParse(readJson(resolve(HERE, "labels.json")));
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`evals/fixtures/garments/labels.json is not valid: ${paths}`);
  }
  return parsed.data.garments;
}

/** One fixture by id. Throws when there is no such id. */
export function garmentFixture(id: string): GarmentFixture {
  const found = loadGarmentFixtures().find((fixture) => fixture.id === id);
  if (found === undefined) {
    throw new Error(`No garment fixture ${id}`);
  }
  return found;
}

/**
 * A fixture as the wardrobe would hold it after a successful classification, in
 * the wardrobe layer's own GarmentView shape.
 *
 * imageUrl is null and stays null: no garment photo is checked in yet, and a
 * fixture that pretended to have one would make a test pass on a URL that does
 * not resolve.
 */
export function toGarmentView(fixture: GarmentFixture): GarmentView {
  return {
    id: fixture.id,
    imageUrl: null,
    type: fixture.label.type,
    colors: fixture.label.colors.map((color) => ({ ...color })),
    pattern: fixture.label.pattern,
    formality: fixture.label.formality,
    userEdited: false,
    classificationStatus: "succeeded",
  };
}

/** All 20 as garment views. */
export function loadGarmentViews(): GarmentView[] {
  return loadGarmentFixtures().map(toGarmentView);
}

/**
 * The six garment demo wardrobe from docs/07-payments-and-judge-mode.md: navy
 * blazer, cream shirt, olive chinos, dark denim, brown loafers, rust knit.
 */
export function loadDemoWardrobeFixtures(): GarmentFixture[] {
  return loadGarmentFixtures().filter((fixture) => fixture.inDemoWardrobe);
}

export function loadDemoWardrobeViews(): GarmentView[] {
  return loadDemoWardrobeFixtures().map(toGarmentView);
}

/** The one fixture whose printed text tries to give an order. */
export function injectionGarmentFixture(): GarmentFixture {
  const found = loadGarmentFixtures().filter((fixture) => fixture.injection);
  const only = found[0];
  if (found.length !== 1 || only === undefined) {
    throw new Error(
      `Expected exactly one injection garment fixture, found ${found.length}`,
    );
  }
  return only;
}

/**
 * The recorded shape shopping response for the shoes gap, whose top title
 * carries an instruction. Returned unparsed on purpose: the provider schema in
 * src/lib/server owns the parsing, and eval:safety feeds this straight into it.
 */
export function loadGapListingInjectedResponse(): unknown {
  return readJson(resolve(HERE, "gap-listing-injected.json"));
}

/** The absolute path of the gap listing fixture, for a test that reads it raw. */
export const GAP_LISTING_INJECTED_PATH = resolve(
  HERE,
  "gap-listing-injected.json",
);
