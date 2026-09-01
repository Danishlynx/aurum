/**
 * The deterministic decisions the hair screen makes about its own content.
 *
 * Pure functions only. No React, no I/O, no server import, so the screen's rules
 * are unit tested without a renderer and without a provider key (the pattern set
 * by src/components/report/report-content.ts and
 * src/components/makeup/makeup-content.ts).
 *
 * Spec: docs/01-user-flow.md section I.
 */

import { copy, fill } from "@/lib/shared/copy";
import type { HairColorOption, HairStyleOption } from "@/lib/shared/hair-view";

/**
 * The style the screen opens on.
 *
 * A saved style wins, because it is the choice the person already made
 * (docs/01 section I item 4). Otherwise the row opens on its first style, which
 * the rules put first. With no styles there is nothing to select, and that stays
 * null rather than becoming an index into an empty row.
 */
export function initialStyleId(view: {
  readonly styles: readonly HairStyleOption[];
  readonly savedStyleId: string | null;
}): string | null {
  const saved = view.savedStyleId;
  if (saved !== null && view.styles.some((style) => style.id === saved)) {
    return saved;
  }
  return view.styles[0]?.id ?? null;
}

/**
 * The color the screen opens on: the saved one, or none.
 *
 * Unlike a shade row on /makeup, no color is selected by default. A hair color
 * is a change to the person's own hair, so the screen shows the style as it is
 * until they ask for a color, and no color render is spent before they do.
 */
export function initialColorName(view: {
  readonly colors: readonly HairColorOption[];
  readonly savedColorName: string | null;
}): string | null {
  const saved = view.savedColorName;
  if (saved !== null && view.colors.some((color) => color.name === saved)) {
    return saved;
  }
  return null;
}

export function styleById(
  styles: readonly HairStyleOption[],
  id: string | null,
): HairStyleOption | null {
  if (id === null) {
    return null;
  }
  return styles.find((style) => style.id === id) ?? null;
}

export function colorByName(
  colors: readonly HairColorOption[],
  name: string | null,
): HairColorOption | null {
  if (name === null) {
    return null;
  }
  return colors.find((color) => color.name === name) ?? null;
}

/**
 * The renders the view already carries, keyed by style id.
 *
 * Only a succeeded render with a URL counts. A pending, failed, or absent one
 * leaves the card as the empty Basalt frame with its name, which is the true
 * state: nothing has been rendered for that style yet, and a stand in image
 * would be a try on we never did.
 */
export function styleRenderSeed(
  styles: readonly HairStyleOption[],
): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const style of styles) {
    if (style.renderStatus === "succeeded" && style.renderUrl !== null) {
      seed[style.id] = style.renderUrl;
    }
  }
  return seed;
}

/**
 * The render the view already holds for the choice the screen opens on, if any.
 *
 * A saved color opens on its own render (the color on that style); otherwise the
 * opening render is the style's. Anything not succeeded, or without a URL, is
 * nothing: the screen then asks for the render itself, and the same params hash
 * answers from the cache when one was made before (docs/03-architecture.md,
 * "Caching").
 */
export function openingRenderUrl(args: {
  readonly styles: readonly HairStyleOption[];
  readonly colors: readonly HairColorOption[];
  readonly styleId: string | null;
  readonly colorName: string | null;
}): string | null {
  if (args.styleId === null) {
    return null;
  }
  if (args.colorName !== null) {
    const color = colorByName(args.colors, args.colorName);
    return color !== null && color.renderStatus === "succeeded"
      ? color.renderUrl
      : null;
  }
  const style = styleById(args.styles, args.styleId);
  return style !== null && style.renderStatus === "succeeded"
    ? style.renderUrl
    : null;
}

/**
 * The pending line for a style, in the shape docs/01 section H uses for a shade
 * ("Applying rust lip"). The name is lower cased because it sits inside a
 * sentence.
 */
export function applyingStyleLine(style: HairStyleOption): string {
  return fill(copy.hair.applyingStyleTemplate, {
    style: style.name.toLowerCase(),
  });
}

/** The same line for a hair color, for example "Applying warm chestnut". */
export function applyingColorLine(color: HairColorOption): string {
  return fill(copy.hair.applyingColorTemplate, {
    color: color.name.toLowerCase(),
  });
}

/** What the hero is showing right now. */
export type HairHeroPresentation = {
  /** The image to draw, or null when there is nothing to draw. */
  readonly imageUrl: string | null;
  /** True while a new render is on its way and an older one is on screen. */
  readonly dimmed: boolean;
  /** "Applying warm chestnut", or null. */
  readonly statusLine: string | null;
  /** "Preview unavailable for this style.", or null. */
  readonly unavailableLine: string | null;
};

/** Which choice the hero is currently about, so a failure names the right one. */
export type HeroSubject = "style" | "color";

export type HairHeroInput = {
  readonly captureImageUrl: string | null;
  /** The last render that arrived, or null. */
  readonly renderUrl: string | null;
  /** The status line for a render in flight, or null when nothing is pending. */
  readonly pendingLine: string | null;
  readonly pending: boolean;
  /** True when the try on failed or could not be asked for. */
  readonly unavailable: boolean;
  readonly subject: HeroSubject;
};

/**
 * The hero, docs/01 section I item 2 (the enlarged style) with section I's
 * states: "same pending and failed patterns as Makeup", which section H writes
 * out:
 *
 * - Render pending: the previous render stays visible, dimmed to 70 percent,
 *   with the status line under it. No spinner over the face.
 * - Try on failed: the unedited selfie, with the preview unavailable line.
 *
 * A failed render never leaves the last successful render on screen, because the
 * style and color selected on the screen would then belong to a face wearing
 * different ones.
 */
export function heroPresentation(
  input: HairHeroInput,
): HairHeroPresentation {
  const showsRender = input.renderUrl !== null && !input.unavailable;

  return {
    imageUrl: showsRender ? input.renderUrl : input.captureImageUrl,
    dimmed: input.pending && showsRender,
    statusLine: input.pending ? input.pendingLine : null,
    unavailableLine: input.unavailable
      ? unavailableLineFor(input.subject)
      : null,
  };
}

function unavailableLineFor(subject: HeroSubject): string {
  return subject === "color"
    ? copy.hair.previewUnavailableColor
    : copy.hair.previewUnavailableStyle;
}
