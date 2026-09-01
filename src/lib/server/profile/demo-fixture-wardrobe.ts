import "server-only";

import type {
  GarmentColor,
  GarmentView,
  WardrobeView,
} from "@/lib/shared/wardrobe-view";

/**
 * The wardrobe the app serves when AURUM_DEMO_FIXTURE is "true".
 *
 * Why it exists: there is no Supabase project and no provider key yet, so
 * /wardrobe and /looks have to be buildable, viewable, and screenshotable from
 * checked in data alone. With the switch on, buildWardrobeView returns this and
 * touches neither the database nor a provider.
 *
 * SYNTHETIC. These are not a person's clothes and the pictures are not
 * photographs. docs/07-payments-and-judge-mode.md says the demo profile
 * includes "a six garment wardrobe"; this is that wardrobe, hand written to the
 * shape the classifier produces, with six flat silhouettes drawn in code
 * standing in for the photos. Every one of them is a plain shape filled with
 * the garment's own colour, which nobody could mistake for a photograph, and
 * the README beside the checked in copies says so in writing.
 *
 * Why drawn shapes are allowed here when a stand in render never is: these are
 * the person's own wardrobe, not product data and not a try on. A made up
 * listing would claim a product exists, and a made up render would claim a
 * photo of a face; a placeholder for "the navy blazer you own" claims nothing
 * about the world. Every attribute below is still declared, not inferred: no
 * classifier has ever run on the fixture, so the chips are written by hand and
 * classificationStatus says "succeeded" because the values are known, not
 * because a model answered.
 *
 * Open item for the human: replace the silhouettes with real photographs of six
 * garments once there are consented ones to use, keeping the same ids so the
 * looks fixtures do not move.
 *
 * The colours are deliberately inside the fixture profile's own Deep Autumn
 * palette where a real garment would be (cream, olive, rust are palette wear
 * colours), so the rules engine has something true to work with rather than a
 * set of clothes nobody with this coloring would own.
 */

/** The route that serves a fixture silhouette. Local, so next/image accepts it. */
export const DEMO_FIXTURE_GARMENT_IMAGE_ROUTE = "/api/wardrobe/images";

export function fixtureGarmentImagePath(garmentId: string): string {
  return `${DEMO_FIXTURE_GARMENT_IMAGE_ROUTE}/${garmentId}`;
}

// ---------------------------------------------------------------------------
// The silhouettes
// ---------------------------------------------------------------------------

/**
 * Flat garment outlines on a 200 by 260 canvas, one path list per shape. No
 * shading, no gradient, no texture: a shape and a fill, so it reads as a
 * placeholder at any size.
 */
const SHAPES = {
  shirt: [
    "M60 50 L78 38 L100 48 L122 38 L140 50 L140 220 L60 220 Z",
    "M60 50 L30 70 L24 140 L48 146 L60 96 Z",
    "M140 50 L170 70 L176 140 L152 146 L140 96 Z",
    "M78 38 L100 62 L122 38 L100 30 Z",
  ],
  blazer: [
    "M62 48 L84 38 L100 74 L92 220 L62 220 Z",
    "M138 48 L116 38 L100 74 L108 220 L138 220 Z",
    "M62 48 L32 72 L28 150 L54 156 L62 100 Z",
    "M138 48 L168 72 L172 150 L146 156 L138 100 Z",
  ],
  sweater: [
    "M58 54 L82 40 L100 52 L118 40 L142 54 L142 212 L58 212 Z",
    "M58 212 L142 212 L142 228 L58 228 Z",
    "M58 54 L24 78 L20 152 L46 160 L58 108 Z",
    "M142 54 L176 78 L180 152 L154 160 L142 108 Z",
  ],
  trousers: [
    "M64 32 L136 32 L136 50 L64 50 Z",
    "M64 50 L98 50 L96 236 L68 236 Z",
    "M102 50 L136 50 L132 236 L104 236 Z",
  ],
  shoes: [
    "M26 176 L46 150 L74 148 L96 168 L96 186 L26 186 Z",
    "M26 186 L96 186 L96 194 L26 194 Z",
    "M104 176 L124 150 L152 148 L174 168 L174 186 L104 186 Z",
    "M104 186 L174 186 L174 194 L104 194 Z",
  ],
} as const;

type ShapeName = keyof typeof SHAPES;

/**
 * One silhouette, as an SVG document.
 *
 * Deterministic: the same garment always produces the same bytes, which is what
 * lets the checked in copies under evals/fixtures/garments/images be compared
 * against this function in a test instead of drifting quietly.
 */
export function buildGarmentSilhouette(args: {
  readonly shape: ShapeName;
  readonly hex: string;
  readonly title: string;
}): string {
  const paths = SHAPES[args.shape]
    .map((d) => `  <path d="${d}" fill="${args.hex}" />`)
    .join("\n");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 260" width="200" height="260" role="img" aria-labelledby="title">',
    `  <title id="title">${args.title}</title>`,
    "  <desc>Synthetic placeholder. A flat silhouette drawn in code, not a photograph.</desc>",
    paths,
    "</svg>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The six garments
// ---------------------------------------------------------------------------

interface FixtureGarment {
  readonly id: string;
  /** The file name the checked in copy carries under evals/fixtures. */
  readonly fileName: string;
  readonly shape: ShapeName;
  readonly type: string;
  readonly colors: readonly GarmentColor[];
  readonly pattern: string;
  readonly formality: "casual" | "smart" | "formal";
}

/**
 * The six pieces.
 *
 * Formality is assigned the way a person would wear them, and the rust knit is
 * "smart" rather than "casual" on purpose: a fine gauge knit is worn to a
 * wedding, and it gives the rules engine a second smart top so an occasion can
 * produce more than one look from six garments.
 */
const FIXTURE_GARMENTS: readonly FixtureGarment[] = [
  {
    id: "fixture-g01",
    fileName: "g01-navy-blazer.svg",
    shape: "blazer",
    type: "blazer",
    colors: [{ name: "Navy", hex: "#1f2a44" }],
    pattern: "solid",
    formality: "formal",
  },
  {
    id: "fixture-g02",
    fileName: "g02-cream-shirt.svg",
    shape: "shirt",
    type: "shirt",
    colors: [{ name: "Cream", hex: "#efe3cb" }],
    pattern: "solid",
    formality: "smart",
  },
  {
    id: "fixture-g03",
    fileName: "g03-olive-chinos.svg",
    shape: "trousers",
    type: "trousers",
    colors: [{ name: "Olive", hex: "#6b6b3a" }],
    pattern: "solid",
    formality: "smart",
  },
  {
    id: "fixture-g04",
    fileName: "g04-dark-denim.svg",
    shape: "trousers",
    type: "jeans",
    colors: [{ name: "Dark denim", hex: "#2f3b4c" }],
    pattern: "solid",
    formality: "casual",
  },
  {
    id: "fixture-g05",
    fileName: "g05-brown-loafers.svg",
    shape: "shoes",
    type: "shoes",
    colors: [{ name: "Brown", hex: "#5c3a24" }],
    pattern: "solid",
    /*
     * Casual, because a loafer is not a dress shoe. This is the one formality
     * here that is load bearing rather than descriptive, and it is the same
     * value the eval fixture for the same garment carries
     * (evals/fixtures/garments/labels.json, g05, which says so with the same
     * reason). Both had to agree: the wedding guest and interview bands are
     * smart and formal (OCCASION_RULES), so casual loafers are the reason those
     * occasions come back with a shoes gap, and the shoes gap is the demo beat
     * docs/09-build-order-and-demo.md Layer 4 asks for: "the shoes gap shows a
     * listing near them". With this set to smart the demo wardrobe dressed every
     * occasion completely and "Shop the gap" never appeared on the screen.
     */
    formality: "casual",
  },
  {
    id: "fixture-g06",
    fileName: "g06-rust-knit.svg",
    shape: "sweater",
    type: "sweater",
    colors: [{ name: "Rust", hex: "#9c4a1e" }],
    pattern: "texture",
    formality: "smart",
  },
];

/** The name shown in the silhouette's title, built from what it is. */
function titleOf(garment: FixtureGarment): string {
  const color = garment.colors[0]?.name ?? "";
  return `${color} ${garment.type.replace(/_/gu, " ")}`.trim();
}

/** id, file name, and markup for each silhouette. Read by the image route. */
export const DEMO_FIXTURE_GARMENT_IMAGES: readonly {
  readonly id: string;
  readonly fileName: string;
  readonly svg: string;
}[] = FIXTURE_GARMENTS.map((garment) => ({
  id: garment.id,
  fileName: garment.fileName,
  svg: buildGarmentSilhouette({
    shape: garment.shape,
    hex: garment.colors[0]?.hex ?? "#000000",
    title: titleOf(garment),
  }),
}));

const SVG_BY_ID: ReadonlyMap<string, string> = new Map(
  DEMO_FIXTURE_GARMENT_IMAGES.map((entry) => [entry.id, entry.svg]),
);

/** The silhouette for a fixture garment id, or null for anything else. */
export function fixtureGarmentSvg(garmentId: string): string | null {
  return SVG_BY_ID.get(garmentId) ?? null;
}

/**
 * The fixture /wardrobe screen.
 *
 * classificationStatus is "succeeded" on every card because every attribute is
 * known, not because a model was called: no ANTHROPIC_API_KEY exists, so
 * nothing has been classified. userEdited is false because nobody corrected a
 * chip either; the values were written here by hand.
 *
 * Frozen, because it is module level state that several requests read and
 * nothing is allowed to mutate it.
 */
export const DEMO_FIXTURE_WARDROBE: WardrobeView = Object.freeze({
  garments: FIXTURE_GARMENTS.map(
    (garment): GarmentView => ({
      id: garment.id,
      imageUrl: fixtureGarmentImagePath(garment.id),
      type: garment.type,
      colors: garment.colors.map((color) => ({ ...color })),
      pattern: garment.pattern,
      formality: garment.formality,
      userEdited: false,
      classificationStatus: "succeeded",
    }),
  ),
});
