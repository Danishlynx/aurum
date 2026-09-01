/**
 * The deterministic decisions the makeup screen makes about its own content.
 *
 * Pure functions only. No React, no I/O, no server import, so the screen's rules
 * are unit tested without a renderer and without a provider key (the pattern set
 * by src/components/report/report-content.ts).
 *
 * Spec: docs/01-user-flow.md section H.
 */

import type {
  MakeupCategoryView,
  MakeupView,
  ShadeOption,
} from "@/lib/shared/color-view";
import { copy, fill } from "@/lib/shared/copy";
import type { ReportListing } from "@/lib/shared/report-view";

export type MakeupCategory = MakeupCategoryView["category"];

/**
 * The four row names, docs/01-user-flow.md section H item 2: "Lip", "Blush",
 * "Foundation", "Eye". Indexing by the union makes a new category a compile
 * error rather than an unnamed row, and keeps every word on the screen inside
 * copy.ts.
 */
const CATEGORY_LABELS: Record<MakeupCategory, string> = {
  lip: copy.makeup.rowLip,
  blush: copy.makeup.rowBlush,
  foundation: copy.makeup.rowFoundation,
  eye: copy.makeup.rowEye,
};

export function categoryLabel(category: MakeupCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * The shade selected when the screen opens. docs/01 section H item 2: "Each row
 * shows three swatches inside the palette, the middle one selected."
 *
 * The view carries recommendedIndex, which is the shade the palette recommends
 * and the one the middle position is meant to hold. It is used when it points at
 * a real shade; anything else falls back to the middle of the row, so a row can
 * never open with nothing selected.
 */
export function selectedShadeIndex(category: MakeupCategoryView): number {
  const count = category.shades.length;
  if (count === 0) {
    return 0;
  }
  const recommended = category.recommendedIndex;
  if (Number.isInteger(recommended) && recommended >= 0 && recommended < count) {
    return recommended;
  }
  return Math.floor((count - 1) / 2);
}

/** The starting selection, one index per category row. */
export function initialSelection(
  categories: readonly MakeupCategoryView[],
): number[] {
  return categories.map((category) => selectedShadeIndex(category));
}

/** The shade a row currently shows, or null for a row with no shades. */
export function shadeAt(
  category: MakeupCategoryView | undefined,
  index: number,
): ShadeOption | null {
  return category?.shades[index] ?? null;
}

/** One category of the try on request, in the shape POST /api/renders takes. */
export type RenderCategoryParam = {
  readonly category: MakeupCategory;
  readonly shadeHex: string;
  readonly shadeName: string;
};

/**
 * The whole look as the render route wants it: every row's current shade, not
 * only the one just tapped, because the hero shows the full look
 * (docs/01 section H item 1). Rows with no shades are left out.
 */
export function renderParams(
  categories: readonly MakeupCategoryView[],
  selection: readonly number[],
): RenderCategoryParam[] {
  const params: RenderCategoryParam[] = [];
  categories.forEach((category, index) => {
    const shade = shadeAt(category, selection[index] ?? 0);
    if (shade === null) {
      return;
    }
    params.push({
      category: category.category,
      shadeHex: shade.hex,
      shadeName: shade.name,
    });
  });
  return params;
}

/**
 * The pending line, docs/01 section H states: "Applying rust lip". The shade
 * name and the row name are both lower cased because they sit inside a sentence.
 */
export function applyingLine(
  category: MakeupCategoryView,
  shade: ShadeOption,
): string {
  return fill(copy.makeup.applyingTemplate, {
    shade: shade.name.toLowerCase(),
    category: categoryLabel(category.category).toLowerCase(),
  });
}

/**
 * What the product card names when no listing came back, for example
 * "Rust lip". The shade name keeps its own capitalization because it is data.
 */
export function shadeProductType(
  category: MakeupCategoryView,
  shade: ShadeOption,
): string {
  return fill(copy.makeup.shadeProductTypeTemplate, {
    shade: shade.name,
    category: categoryLabel(category.category).toLowerCase(),
  });
}

/**
 * The listing to show under a row.
 *
 * MakeupView.product carries one listing per category, grounded for the shade
 * that was selected when the view was built. While a newly chosen shade is
 * still being grounded, the listing on hand belongs to the previous shade, and
 * showing it under the new one would be a product we did not find for what is on
 * the screen (docs/06-safety-privacy.md, "Grounding and honesty"). Until the new
 * listing arrives the row shows the shade name and "No listing found near you
 * yet", which is the true state.
 */
export function listingForRow(
  products: Pick<MakeupView, "product">["product"],
  categoryIndex: number,
  selectedIndex: number,
  /** The shade index the listings on hand were fetched for. */
  groundedIndex: number,
): ReportListing | null {
  if (products === null || selectedIndex !== groundedIndex) {
    return null;
  }
  return products[categoryIndex] ?? null;
}

/** What the hero is showing right now. */
export type HeroPresentation = {
  /** The image to draw, or null when there is nothing to draw. */
  readonly imageUrl: string | null;
  /** True while a new render is on its way and an older one is on screen. */
  readonly dimmed: boolean;
  /** "Applying rust lip", or null. */
  readonly statusLine: string | null;
  /** "Preview unavailable for this shade.", or null. */
  readonly unavailableLine: string | null;
  /** True when there is a render to compare against the original photo. */
  readonly beforeAfterAvailable: boolean;
};

export type HeroInput = {
  readonly captureImageUrl: string | null;
  /** The last render that arrived, or null. */
  readonly renderUrl: string | null;
  /** The status line for a render in flight, or null when nothing is pending. */
  readonly pendingLine: string | null;
  readonly pending: boolean;
  /** True when the try on failed or could not be asked for. */
  readonly unavailable: boolean;
  /** True while the person holds the hero or has tapped "Before". */
  readonly showBefore: boolean;
};

/**
 * The hero, docs/01 section H item 1 and its two states:
 *
 * - Render pending: "previous render stays visible, dimmed to 70 percent, with
 *   the status line". No spinner over the face.
 * - Try on failed: "the hero shows the unedited selfie with 'Preview
 *   unavailable for this shade.'"
 *
 * A failed render never leaves the last successful render on screen, because the
 * shades on the screen would then belong to a face showing different ones.
 */
export function heroPresentation(input: HeroInput): HeroPresentation {
  const showsRender =
    input.renderUrl !== null && !input.unavailable && !input.showBefore;

  return {
    imageUrl: showsRender ? input.renderUrl : input.captureImageUrl,
    dimmed: input.pending && showsRender,
    statusLine: input.pending ? input.pendingLine : null,
    unavailableLine: input.unavailable ? copy.makeup.previewUnavailable : null,
    beforeAfterAvailable: input.renderUrl !== null && !input.unavailable,
  };
}
