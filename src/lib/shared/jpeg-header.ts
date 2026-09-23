/**
 * The size of a JPEG, read from its header and nothing else.
 *
 * The server has to know what it is about to send to Perfect Corp before it
 * reserves a unit for it: the engine's own input rules are stated in pixels and
 * bytes (src/lib/server/providers/perfectcorp/endpoints.ts, imageConstraints),
 * and until 2026-09-23 nothing enforced them anywhere. Decoding the picture to
 * find that out would need an image library, which CLAUDE.md asks the human
 * about before adding, and would mean holding a decoded frame in a serverless
 * function for a number that sits in the first few hundred bytes of the file.
 *
 * So this walks the marker segments instead. A JPEG is a start of image marker
 * (FF D8) followed by segments, each a marker (FF xx) and a big endian length
 * that counts itself, until the start of scan (FF DA) begins the entropy coded
 * data. The frame header (one of the SOF markers) carries the height and width.
 * Everything before it is application data and tables, which are skipped by
 * length without being read.
 *
 * Every malformed input answers null, never a guess: a missing start of image,
 * a marker that is not a marker, a segment that claims to run past the end of
 * the buffer, a scan or an end of image before any frame header, or a header
 * that does not turn up inside the first 64 KB. The caller treats null and a
 * wrong size the same way, so there is no reason to be clever about a file
 * that is not what it says it is.
 */

export interface JpegDimensions {
  readonly width: number;
  readonly height: number;
}

/** How far into the file the frame header is looked for. */
export const JPEG_HEADER_SCAN_LIMIT_BYTES = 64 * 1024;

const MARKER_PREFIX = 0xff;
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;

/**
 * The start of frame markers, ITU T.81 table B.1: C0 to C3, C5 to C7, C9 to CB,
 * CD to CF. C4 is a Huffman table, C8 is reserved, CC is an arithmetic
 * conditioning table, and none of the three carries a size.
 */
const SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * A frame header segment is at least the length field (2), the sample
 * precision (1), the height (2), the width (2) and the component count (1).
 */
const SOF_MIN_LENGTH = 8;

function isStandalone(marker: number): boolean {
  return (
    marker === TEM ||
    marker === SOI ||
    (marker >= RST_FIRST && marker <= RST_LAST)
  );
}

function readUint16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/** True when the first two bytes are the JPEG start of image marker. */
export function hasJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === MARKER_PREFIX && bytes[1] === SOI;
}

/**
 * Reads the pixel size from the first frame header, or null when the bytes are
 * not a JPEG whose frame header can be found and trusted.
 */
export function readJpegHeader(bytes: Uint8Array): JpegDimensions | null {
  if (!hasJpegMagic(bytes)) {
    return null;
  }

  const limit = Math.min(bytes.length, JPEG_HEADER_SCAN_LIMIT_BYTES);
  let position = 2;

  while (position < limit) {
    if (bytes[position] !== MARKER_PREFIX) {
      return null;
    }
    // Any number of FF bytes may pad the space before a marker (T.81 B.1.1.2).
    while (position < limit && bytes[position] === MARKER_PREFIX) {
      position += 1;
    }
    if (position >= limit) {
      return null;
    }

    const marker = bytes[position] ?? 0;
    position += 1;

    if (marker === EOI || marker === SOS) {
      // The picture ended, or its scan data began, without a frame header.
      return null;
    }
    if (isStandalone(marker)) {
      continue;
    }

    if (position + 2 > bytes.length) {
      return null;
    }
    const length = readUint16(bytes, position);
    if (length < 2 || position + length > bytes.length) {
      return null;
    }

    if (SOF_MARKERS.has(marker)) {
      if (length < SOF_MIN_LENGTH) {
        return null;
      }
      const height = readUint16(bytes, position + 3);
      const width = readUint16(bytes, position + 5);
      // A zero height is legal in the standard (it is defined later by a DNL
      // segment) and is not something a camera or a canvas ever writes, so it
      // is treated as unreadable rather than as a size.
      if (width === 0 || height === 0) {
        return null;
      }
      return { width, height };
    }

    position += length;
  }

  return null;
}
