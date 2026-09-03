import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";
import type {
  LookGap,
  LookItem,
  LooksView,
  LookView,
} from "@/lib/shared/looks-view";
import type { ReportListing } from "@/lib/shared/report-view";

import {
  applyingLine,
  flatLayColumns,
  gapLine,
  gapProductType,
  garmentItems,
  heroGarmentWord,
  heroPresentation,
  itemKey,
  listingItems,
  showsNothingFitsLine,
  typeLabel,
} from "./looks-content";

function listing(overrides: Partial<ReportListing> = {}): ReportListing {
  return {
    title: "Navy wool blazer",
    priceText: "4,200 rupees",
    priceValue: 4200,
    currency: "INR",
    url: "https://example.com/blazer",
    imageUrl: null,
    store: "A store",
    distanceText: null,
    ...overrides,
  };
}

function garmentItem(
  garmentId: string,
  type: string,
  imageUrl: string | null = "/api/wardrobe/images/g1",
): LookItem {
  return { source: "garment", garmentId, imageUrl, type };
}

function look(overrides: Partial<LookView> = {}): LookView {
  return {
    id: "wedding_guest-1",
    occasion: "wedding_guest",
    rationale: "Cream sits in your Deep Autumn palette.",
    rationaleSource: "rules",
    items: [garmentItem("g1", "blazer"), garmentItem("g2", "trousers")],
    heroGarmentId: "g1",
    renderUrl: null,
    renderStatus: "none",
    gaps: [],
    ...overrides,
  };
}

describe("garmentItems and listingItems", () => {
  it("splits a look into the pieces the person owns and the pieces that are listings", () => {
    const mixed = look({
      items: [
        garmentItem("g1", "blazer"),
        { source: "listing", listing: listing(), type: "shoes" },
      ],
    });
    expect(garmentItems(mixed).map((item) => item.garmentId)).toEqual(["g1"]);
    expect(listingItems(mixed).map((item) => item.type)).toEqual(["shoes"]);
  });

  it("returns an empty flat lay for a look composed entirely from listings", () => {
    const fromListings = look({
      items: [{ source: "listing", listing: listing(), type: "shirt" }],
    });
    expect(garmentItems(fromListings)).toEqual([]);
    expect(listingItems(fromListings)).toHaveLength(1);
  });
});

describe("showsNothingFitsLine", () => {
  function view(overrides: Partial<LooksView> = {}): LooksView {
    return {
      occasion: "wedding_guest",
      wardrobeEmpty: false,
      looks: [look()],
      ...overrides,
    };
  }

  const listingsOnly = look({
    items: [{ source: "listing", listing: listing(), type: "shirt" }],
    heroGarmentId: null,
  });

  it("says nothing when the looks are made of the person's own clothes", () => {
    expect(showsNothingFitsLine(view())).toBe(false);
  });

  it("speaks up when a wardrobe is there and none of it is being worn", () => {
    expect(showsNothingFitsLine(view({ looks: [listingsOnly] }))).toBe(true);
  });

  it("stays quiet while any look still holds a garment", () => {
    expect(
      showsNothingFitsLine(view({ looks: [listingsOnly, look()] })),
    ).toBe(false);
  });

  it("leaves the no wardrobe state to its own line and its own control", () => {
    expect(
      showsNothingFitsLine(
        view({ wardrobeEmpty: true, looks: [listingsOnly] }),
      ),
    ).toBe(false);
  });

  it("leaves an occasion with no look at all to the same line, once", () => {
    // The screen draws copy.looks.noLooksForOccasion for an empty list already,
    // so this returns false and the sentence is never on the screen twice.
    expect(showsNothingFitsLine(view({ looks: [] }))).toBe(false);
  });
});

describe("flatLayColumns", () => {
  it("lays four pieces out as a square and three as one row", () => {
    expect(flatLayColumns(4)).toBe(2);
    expect(flatLayColumns(3)).toBe(3);
  });

  it("never gives one garment the whole width", () => {
    expect(flatLayColumns(1)).toBe(2);
    expect(flatLayColumns(2)).toBe(2);
  });

  it("stays at two columns for anything larger", () => {
    expect(flatLayColumns(6)).toBe(2);
  });
});

describe("gapLine", () => {
  const nearby: LookGap = {
    type: "shoes",
    listings: [listing({ distanceText: "2 km away" })],
  };
  const online: LookGap = { type: "shoes", listings: [listing()] };

  it("says near you only when a listing actually carries a distance", () => {
    expect(gapLine(nearby)).toContain("near you");
    expect(gapLine(online)).not.toContain("near you");
  });

  it("names the piece in the words the chips use", () => {
    expect(gapLine(online)).toContain("shoes");
    expect(gapLine({ type: "t_shirt", listings: [] })).toContain("t shirt");
  });
});

describe("gapProductType", () => {
  it("names the piece for the empty product state", () => {
    expect(gapProductType({ type: "shoes", listings: [] })).toBe("Shoes");
  });

  it("falls back to the stored word for a type with no label", () => {
    expect(gapProductType({ type: "kimono", listings: [] })).toBe("kimono");
  });
});

describe("typeLabel", () => {
  it("uses the chip word", () => {
    expect(typeLabel("t_shirt")).toBe("T shirt");
    expect(typeLabel("kimono")).toBe("kimono");
  });
});

describe("heroGarmentWord and applyingLine", () => {
  it("names the hero garment inside the pending line", () => {
    expect(heroGarmentWord(look())).toBe("blazer");
    expect(applyingLine(look())).toBe("Applying the blazer");
  });

  it("says nothing when the look names no hero", () => {
    const noHero = look({ heroGarmentId: null });
    expect(heroGarmentWord(noHero)).toBeNull();
    expect(applyingLine(noHero)).toBeNull();
  });

  it("says nothing when the hero is not among the pieces on screen", () => {
    expect(heroGarmentWord(look({ heroGarmentId: "missing" }))).toBeNull();
  });
});

describe("heroPresentation", () => {
  const idle = {
    renderUrl: null,
    pending: false,
    pendingLine: null,
    unavailable: false,
  };

  it("draws nothing at all when there is no render and none is on its way, because the flat lay is the content", () => {
    expect(heroPresentation(idle).visible).toBe(false);
  });

  it("shows a render once one exists", () => {
    const hero = heroPresentation({ ...idle, renderUrl: "https://x/y.jpg" });
    expect(hero.imageUrl).toBe("https://x/y.jpg");
    expect(hero.dimmed).toBe(false);
    expect(hero.visible).toBe(true);
  });

  it("holds the previous render at 70 percent with the status line under it", () => {
    const hero = heroPresentation({
      renderUrl: "https://x/y.jpg",
      pending: true,
      pendingLine: "Applying the blazer",
      unavailable: false,
    });
    expect(hero.dimmed).toBe(true);
    expect(hero.statusLine).toBe("Applying the blazer");
    expect(hero.unavailableLine).toBeNull();
  });

  it("shows the documented line and no image when the try on could not be produced", () => {
    const hero = heroPresentation({
      renderUrl: "https://x/y.jpg",
      pending: false,
      pendingLine: null,
      unavailable: true,
    });
    expect(hero.imageUrl).toBeNull();
    expect(hero.unavailableLine).toBe(copy.looks.previewUnavailable);
    expect(hero.visible).toBe(true);
  });

  it("never dims an image that is not there", () => {
    const hero = heroPresentation({
      renderUrl: null,
      pending: true,
      pendingLine: "Applying the blazer",
      unavailable: false,
    });
    expect(hero.dimmed).toBe(false);
    expect(hero.visible).toBe(true);
  });
});

describe("itemKey", () => {
  it("keys a garment by its id and a listing by its position and url", () => {
    expect(itemKey(garmentItem("g1", "blazer"), 0)).toBe("garment-g1");
    expect(
      itemKey({ source: "listing", listing: listing(), type: "shoes" }, 2),
    ).toBe("listing-2-https://example.com/blazer");
  });
});
