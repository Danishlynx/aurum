import "server-only";

/**
 * Undertone from the detected skin tone hex.
 *
 * PROVISIONAL. The real mapping is src/lib/shared/palette.ts, which lands with
 * Layer 2 together with the season derivation and the goldens in eval:palette
 * (docs/09-build-order-and-demo.md, Layer 2). Layer 1 still has to write
 * aesthetic_profiles.undertone with undertone_source "detected", because the
 * column is what the colour screen later offers the person to correct, so this
 * file holds the smallest rule that can be argued with, and Layer 2 deletes it.
 *
 * The rule: hue on the standard 0 to 360 circle, read off the RGB the provider
 * returned.
 *
 *   hue at or above 26 degrees   yellow side of skin      warm
 *   hue at or below 17 degrees   pink and red side        cool
 *   in between, or grey          neither reads clearly    neutral
 *
 * The two numbers are where fair to deep skin hexes actually separate: a fair
 * pink tone lands near 11 degrees, a fair golden tone near 34, a deep golden
 * brown near 27, and a deep cool brown near 14. They are not a measurement of
 * anyone's skin and the person can always overrule them on /color, which is why
 * undertone_source exists.
 */

export type Undertone = "warm" | "cool" | "neutral";

export const WARM_AT_OR_ABOVE_DEGREES = 26;
export const COOL_AT_OR_BELOW_DEGREES = 17;

/** Grey enough that hue means nothing. */
const MIN_CHROMA = 8;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function hexToRgb(hex: string): Rgb | null {
  const trimmed = hex.trim().replace(/^#/u, "");
  if (!/^[0-9a-fA-F]{6}$/u.test(trimmed)) {
    return null;
  }
  return {
    r: Number.parseInt(trimmed.slice(0, 2), 16),
    g: Number.parseInt(trimmed.slice(2, 4), 16),
    b: Number.parseInt(trimmed.slice(4, 6), 16),
  };
}

/** Hue in degrees, 0 to 360, or null for a grey. */
export function hueOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    return null;
  }
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const chroma = max - min;
  if (chroma < MIN_CHROMA) {
    return null;
  }

  let hue: number;
  if (max === rgb.r) {
    hue = ((rgb.g - rgb.b) / chroma) % 6;
  } else if (max === rgb.g) {
    hue = (rgb.b - rgb.r) / chroma + 2;
  } else {
    hue = (rgb.r - rgb.g) / chroma + 4;
  }
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** The detected undertone, or null when there is no tone to read. */
export function detectUndertone(skinToneHex: string | null): Undertone | null {
  if (skinToneHex === null) {
    return null;
  }
  const hue = hueOf(skinToneHex);
  if (hue === null) {
    return "neutral";
  }
  if (hue >= WARM_AT_OR_ABOVE_DEGREES && hue < 90) {
    return "warm";
  }
  if (hue <= COOL_AT_OR_BELOW_DEGREES || hue >= 270) {
    return "cool";
  }
  return "neutral";
}
