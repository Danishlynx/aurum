import { describe, expect, it } from "vitest";

import { HEIC_SNIFF_BYTES, looksLikeHeic } from "./image-format";

/** An ISO base media header with the given major brand at byte 8. */
function isoHeader(brand: string): number[] {
  const bytes = [0, 0, 0, 24, ...Array.from("ftyp", (c) => c.charCodeAt(0))];
  for (const character of brand) {
    bytes.push(character.charCodeAt(0));
  }
  // Minor version, then the start of the compatible brands.
  bytes.push(0, 0, 0, 0);
  return bytes;
}

describe("looksLikeHeic", () => {
  it("recognises the four HEIF and HEIC brands", () => {
    for (const brand of ["heic", "heix", "mif1", "msf1"]) {
      expect(looksLikeHeic(isoHeader(brand)), brand).toBe(true);
    }
  });

  it("does not mistake other ISO base media files for a HEIC", () => {
    // An MP4 and an AVIF share the ftyp box and are not this problem.
    expect(looksLikeHeic(isoHeader("isom"))).toBe(false);
    expect(looksLikeHeic(isoHeader("avif"))).toBe(false);
  });

  it("answers no to a JPEG, a PNG and an empty file", () => {
    expect(looksLikeHeic([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])).toBe(false);
    expect(
      looksLikeHeic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    ).toBe(false);
    expect(looksLikeHeic([])).toBe(false);
    expect(looksLikeHeic(new Uint8Array(0))).toBe(false);
  });

  it("answers no to a header cut short of the brand", () => {
    expect(looksLikeHeic(isoHeader("heic").slice(0, 10))).toBe(false);
  });

  it("needs no more than the bytes the screen reads", () => {
    expect(looksLikeHeic(isoHeader("heic").slice(0, HEIC_SNIFF_BYTES))).toBe(true);
  });
});
