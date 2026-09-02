/*
 * The fixtures below carry hex colors because a shade is handed to this screen
 * as a hex color: it is palette data derived from the person's own tone, not a
 * design color (see the note at the top of src/components/ui/Swatch.tsx). The
 * rule that keeps design colors out of components cannot tell the two apart, so
 * it is turned off for this file and nothing else.
 */
/* eslint-disable aurum/no-hex-colors */

import { describe, expect, it } from "vitest";

import type { MakeupCategoryView } from "@/lib/shared/color-view";
import { copy } from "@/lib/shared/copy";
import type { ReportListing } from "@/lib/shared/report-view";

import {
  applyingLine,
  categoryLabel,
  heroPresentation,
  initialSelection,
  listingForRow,
  renderParams,
  selectedShadeIndex,
  shadeProductType,
} from "./makeup-content";

function shade(name: string, hex: string) {
  return { name, hex, productQuery: `${name} lipstick` };
}

const LIP: MakeupCategoryView = {
  category: "lip",
  label: "Lip",
  shades: [shade("Brick", "#8d3b28"), shade("Rust", "#a4482a"), shade("Clay", "#b56b4a")],
  recommendedIndex: 1,
};

const BLUSH: MakeupCategoryView = {
  category: "blush",
  label: "Blush",
  shades: [shade("Terracotta", "#b06a4a"), shade("Apricot", "#c98159")],
  recommendedIndex: 7,
};

const LISTING: ReportListing = {
  title: "A real listing",
  priceText: "1,299",
  priceValue: 1299,
  currency: "INR",
  url: "https://example.com/listing",
  imageUrl: null,
  store: "A store",
  distanceText: null,
};

describe("categoryLabel", () => {
  it("names the four rows docs/01 section H item 2 names", () => {
    expect(categoryLabel("lip")).toBe(copy.makeup.rowLip);
    expect(categoryLabel("blush")).toBe(copy.makeup.rowBlush);
    expect(categoryLabel("foundation")).toBe(copy.makeup.rowFoundation);
    expect(categoryLabel("eye")).toBe(copy.makeup.rowEye);
  });
});

describe("selectedShadeIndex", () => {
  it("opens on the recommended shade, which is the middle one", () => {
    expect(selectedShadeIndex(LIP)).toBe(1);
  });

  it("falls back to the middle when the recommendation is out of range", () => {
    expect(selectedShadeIndex(BLUSH)).toBe(0);
  });

  it("never returns a negative index for a row with no shades", () => {
    expect(
      selectedShadeIndex({ ...LIP, shades: [], recommendedIndex: 1 }),
    ).toBe(0);
  });

  /*
   * docs/01 section H item 4: "Save this look" saves the selected shades, so the
   * next visit opens on them rather than on the recommendation. It is also what
   * makes the saved look find its own render instead of asking for a new one
   * (src/lib/server/profile/makeup.ts).
   */
  it("opens on the saved shade when the row carries one", () => {
    expect(selectedShadeIndex({ ...LIP, savedIndex: 2 })).toBe(2);
    expect(selectedShadeIndex({ ...LIP, savedIndex: 0 })).toBe(0);
  });

  it("ignores a saved index that points at no shade", () => {
    expect(selectedShadeIndex({ ...LIP, savedIndex: 9 })).toBe(1);
    expect(selectedShadeIndex({ ...LIP, savedIndex: -1 })).toBe(1);
  });
});

describe("initialSelection", () => {
  it("gives one index per row", () => {
    expect(initialSelection([LIP, BLUSH])).toEqual([1, 0]);
  });

  it("opens each row on its saved shade when there is one", () => {
    expect(
      initialSelection([{ ...LIP, savedIndex: 2 }, BLUSH]),
    ).toEqual([2, 0]);
  });
});

describe("renderParams", () => {
  it("sends the whole look, not only the row that changed", () => {
    expect(renderParams([LIP, BLUSH], [2, 1])).toEqual([
      { category: "lip", shadeHex: "#b56b4a", shadeName: "Clay" },
      { category: "blush", shadeHex: "#c98159", shadeName: "Apricot" },
    ]);
  });

  it("leaves out a row with no shades", () => {
    expect(renderParams([{ ...LIP, shades: [] }], [0])).toEqual([]);
  });
});

describe("applyingLine", () => {
  it("reads as the doc writes it, 'Applying rust lip'", () => {
    expect(applyingLine(LIP, LIP.shades[1])).toBe("Applying rust lip");
  });
});

describe("shadeProductType", () => {
  it("names the shade the card is about", () => {
    expect(shadeProductType(LIP, LIP.shades[1])).toBe("Rust lip");
  });
});

describe("listingForRow", () => {
  it("shows the listing that was grounded for the selected shade", () => {
    expect(listingForRow([LISTING, null], 0, 1, 1)).toBe(LISTING);
  });

  it("shows no listing for a shade nothing was searched for yet", () => {
    expect(listingForRow([LISTING, null], 0, 2, 1)).toBeNull();
  });

  it("shows no listing when grounding returned nothing at all", () => {
    expect(listingForRow(null, 0, 1, 1)).toBeNull();
  });
});

describe("heroPresentation", () => {
  const base = {
    captureImageUrl: "https://example.com/selfie.jpg",
    renderUrl: null,
    pendingLine: null,
    pending: false,
    unavailable: false,
    showBefore: false,
  };

  it("shows the selfie until a render arrives", () => {
    const hero = heroPresentation(base);
    expect(hero.imageUrl).toBe(base.captureImageUrl);
    expect(hero.beforeAfterAvailable).toBe(false);
    expect(hero.unavailableLine).toBeNull();
  });

  it("shows the render once it arrives, with Before and After available", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
    });
    expect(hero.imageUrl).toBe("https://example.com/render.jpg");
    expect(hero.beforeAfterAvailable).toBe(true);
    expect(hero.dimmed).toBe(false);
  });

  it("keeps the previous render dimmed with a status line while the next one loads", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
      pending: true,
      pendingLine: "Applying rust lip",
    });
    expect(hero.imageUrl).toBe("https://example.com/render.jpg");
    expect(hero.dimmed).toBe(true);
    expect(hero.statusLine).toBe("Applying rust lip");
  });

  it("falls back to the unedited selfie and says so when the try on failed", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
      unavailable: true,
    });
    expect(hero.imageUrl).toBe(base.captureImageUrl);
    expect(hero.unavailableLine).toBe(copy.makeup.previewUnavailable);
    expect(hero.beforeAfterAvailable).toBe(false);
  });

  it("shows the original photo while Before is held", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
      showBefore: true,
    });
    expect(hero.imageUrl).toBe(base.captureImageUrl);
    expect(hero.beforeAfterAvailable).toBe(true);
  });

  it("draws nothing rather than a stand in when there is no photo", () => {
    const hero = heroPresentation({ ...base, captureImageUrl: null, unavailable: true });
    expect(hero.imageUrl).toBeNull();
    expect(hero.unavailableLine).toBe(copy.makeup.previewUnavailable);
  });
});
