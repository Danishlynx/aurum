/**
 * What a file's first bytes say about its format, for the one case the capture
 * screen has to answer in its own words: a HEIC picked from an iPhone's
 * gallery on a browser that cannot decode it.
 *
 * Why it exists. accept="image/*" without image/heic makes iOS hand over a
 * JPEG, so the ordinary path never sees a HEIC. A HEIC still arrives from a
 * desktop browser given the original file, and createImageBitmap and the img
 * element both fail on it with a generic error, which the screen used to show
 * as "Upload did not complete": untrue (nothing was uploaded) and useless (the
 * person cannot act on it). Sniffing the header lets the screen say what the
 * problem is and what to do.
 *
 * Pure: bytes in, boolean out. The caller reads the first HEIC_SNIFF_BYTES of
 * the file and nothing more.
 */

/** How many bytes of the file the sniff reads. */
export const HEIC_SNIFF_BYTES = 16;

/**
 * The ISO base media brands that mean HEIF or HEIC: the still image brands
 * (heic, heix), the generic HEIF brand (mif1) and its sequence brand (msf1).
 * Each appears at byte 8, right after the box size and the "ftyp" tag.
 */
const HEIC_BRANDS = ["heic", "heix", "mif1", "msf1"] as const;

const FTYP_OFFSET = 4;
const BRAND_OFFSET = 8;

function ascii(bytes: ArrayLike<number>, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const value = bytes[offset + index];
    if (value === undefined) {
      return "";
    }
    text += String.fromCharCode(value);
  }
  return text;
}

/**
 * True when the bytes open an ISO base media file whose major brand is one of
 * the HEIF or HEIC brands. Anything shorter than the brand, or any other
 * signature, is false: a JPEG, a PNG, a WebP and an empty file all answer no.
 */
export function looksLikeHeic(bytes: ArrayLike<number>): boolean {
  if (bytes.length < BRAND_OFFSET + 4) {
    return false;
  }
  if (ascii(bytes, FTYP_OFFSET, 4) !== "ftyp") {
    return false;
  }
  const brand = ascii(bytes, BRAND_OFFSET, 4);
  return (HEIC_BRANDS as readonly string[]).includes(brand);
}
