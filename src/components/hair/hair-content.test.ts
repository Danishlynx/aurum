/*
 * The fixtures below carry hex colors because a hair color is handed to this
 * screen as a hex color: it is palette data derived from the person's own tone,
 * not a design color (see the note at the top of src/components/ui/Swatch.tsx).
 * The rule that keeps design colors out of components cannot tell the two apart,
 * so it is turned off for this file and nothing else.
 */
/* eslint-disable aurum/no-hex-colors */

import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";
import type { HairColorOption, HairStyleOption } from "@/lib/shared/hair-view";

import {
  applyingColorLine,
  applyingStyleLine,
  colorByName,
  heroPresentation,
  initialColorName,
  initialStyleId,
  openingRenderUrl,
  styleById,
  styleRenderSeed,
} from "./hair-content";

function style(
  id: string,
  name: string,
  renderStatus: HairStyleOption["renderStatus"] = "none",
  renderUrl: string | null = null,
): HairStyleOption {
  return { id, name, why: `${name} suits an oval face.`, renderUrl, renderStatus };
}

const STYLES: readonly HairStyleOption[] = [
  style("textured-crop", "Textured crop", "succeeded", "https://example.com/a.jpg"),
  style("soft-layers", "Soft layers past the collarbone"),
  style("blunt-bob", "Blunt bob", "failed"),
  style("tapered-fade", "Tapered fade", "succeeded"),
];

const COLORS: readonly HairColorOption[] = [
  {
    name: "Warm chestnut",
    hex: "#5b3a24",
    why: "Warm chestnut brings out the warmth in your skin.",
    renderUrl: null,
    renderStatus: "none",
  },
  {
    name: "Espresso",
    hex: "#2b1d16",
    why: "Espresso keeps the contrast your coloring already has.",
    renderUrl: null,
    renderStatus: "none",
  },
];

describe("initialStyleId", () => {
  it("opens on the saved style", () => {
    expect(initialStyleId({ styles: STYLES, savedStyleId: "blunt-bob" })).toBe(
      "blunt-bob",
    );
  });

  it("opens on the first style when nothing is saved", () => {
    expect(initialStyleId({ styles: STYLES, savedStyleId: null })).toBe(
      "textured-crop",
    );
  });

  it("ignores a saved style that is no longer recommended", () => {
    expect(initialStyleId({ styles: STYLES, savedStyleId: "gone" })).toBe(
      "textured-crop",
    );
  });

  it("selects nothing when there are no styles", () => {
    expect(initialStyleId({ styles: [], savedStyleId: "blunt-bob" })).toBeNull();
  });
});

describe("initialColorName", () => {
  it("opens on the saved color", () => {
    expect(
      initialColorName({ colors: COLORS, savedColorName: "Espresso" }),
    ).toBe("Espresso");
  });

  it("opens with no color chosen, so no color render is spent unasked", () => {
    expect(initialColorName({ colors: COLORS, savedColorName: null })).toBeNull();
  });

  it("ignores a saved color that is no longer in the palette", () => {
    expect(
      initialColorName({ colors: COLORS, savedColorName: "Ash blonde" }),
    ).toBeNull();
  });
});

describe("styleById and colorByName", () => {
  it("finds what is there", () => {
    expect(styleById(STYLES, "soft-layers")?.name).toBe(
      "Soft layers past the collarbone",
    );
    expect(colorByName(COLORS, "Warm chestnut")?.hex).toBe("#5b3a24");
  });

  it("finds nothing for an unknown or absent choice", () => {
    expect(styleById(STYLES, "gone")).toBeNull();
    expect(styleById(STYLES, null)).toBeNull();
    expect(colorByName(COLORS, null)).toBeNull();
  });
});

describe("styleRenderSeed", () => {
  it("keeps only the renders that succeeded and have an image", () => {
    expect(styleRenderSeed(STYLES)).toEqual({
      "textured-crop": "https://example.com/a.jpg",
    });
  });
});

describe("openingRenderUrl", () => {
  const args = { styles: STYLES, colors: COLORS };

  it("opens on the render the view already had for the style", () => {
    expect(
      openingRenderUrl({ ...args, styleId: "textured-crop", colorName: null }),
    ).toBe("https://example.com/a.jpg");
  });

  it("has nothing for a style whose render never succeeded", () => {
    expect(
      openingRenderUrl({ ...args, styleId: "blunt-bob", colorName: null }),
    ).toBeNull();
    expect(
      openingRenderUrl({ ...args, styleId: "tapered-fade", colorName: null }),
    ).toBeNull();
  });

  it("opens on the color's own render when a color is saved", () => {
    const colors: HairColorOption[] = [
      {
        ...COLORS[0],
        renderStatus: "succeeded",
        renderUrl: "https://example.com/color.jpg",
      },
    ];
    expect(
      openingRenderUrl({
        styles: STYLES,
        colors,
        styleId: "textured-crop",
        colorName: "Warm chestnut",
      }),
    ).toBe("https://example.com/color.jpg");
  });

  it("never falls back to the style render when a color is chosen", () => {
    expect(
      openingRenderUrl({
        ...args,
        styleId: "textured-crop",
        colorName: "Warm chestnut",
      }),
    ).toBeNull();
  });

  it("has nothing when no style is selected", () => {
    expect(
      openingRenderUrl({ ...args, styleId: null, colorName: null }),
    ).toBeNull();
  });
});

describe("applying lines", () => {
  it("names the style the person just chose", () => {
    expect(applyingStyleLine(STYLES[0])).toBe("Applying textured crop");
  });

  it("names the color the person just chose", () => {
    expect(applyingColorLine(COLORS[0])).toBe("Applying warm chestnut");
  });
});

describe("heroPresentation", () => {
  const base = {
    captureImageUrl: "https://example.com/selfie.jpg",
    renderUrl: null,
    pendingLine: null,
    pending: false,
    unavailable: false,
    subject: "style" as const,
  };

  it("shows the selfie until a render arrives", () => {
    const hero = heroPresentation(base);
    expect(hero.imageUrl).toBe(base.captureImageUrl);
    expect(hero.dimmed).toBe(false);
    expect(hero.unavailableLine).toBeNull();
  });

  it("shows the render once it arrives", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
    });
    expect(hero.imageUrl).toBe("https://example.com/render.jpg");
    expect(hero.dimmed).toBe(false);
  });

  it("keeps the previous render dimmed with a status line while the next one loads", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
      pending: true,
      pendingLine: "Applying warm chestnut",
    });
    expect(hero.imageUrl).toBe("https://example.com/render.jpg");
    expect(hero.dimmed).toBe(true);
    expect(hero.statusLine).toBe("Applying warm chestnut");
  });

  it("falls back to the unedited selfie and names the style that failed", () => {
    const hero = heroPresentation({
      ...base,
      renderUrl: "https://example.com/render.jpg",
      unavailable: true,
    });
    expect(hero.imageUrl).toBe(base.captureImageUrl);
    expect(hero.unavailableLine).toBe(copy.hair.previewUnavailableStyle);
  });

  it("names the color instead when a color try on is the one that failed", () => {
    const hero = heroPresentation({
      ...base,
      unavailable: true,
      subject: "color",
    });
    expect(hero.unavailableLine).toBe(copy.hair.previewUnavailableColor);
  });

  it("draws nothing rather than a stand in when there is no photo", () => {
    const hero = heroPresentation({
      ...base,
      captureImageUrl: null,
      unavailable: true,
    });
    expect(hero.imageUrl).toBeNull();
    expect(hero.unavailableLine).toBe(copy.hair.previewUnavailableStyle);
  });
});
