import { describe, expect, it } from "vitest";

import {
  hasJpegMagic,
  JPEG_HEADER_SCAN_LIMIT_BYTES,
  readJpegHeader,
} from "./jpeg-header";

/**
 * Hand built byte arrays, so the reader is pinned to the standard and not to
 * whatever an encoder happened to write.
 */

function uint16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/** A marker segment: FF marker, then a length that counts itself. */
function segment(marker: number, payload: readonly number[]): number[] {
  return [0xff, marker, ...uint16(payload.length + 2), ...payload];
}

/** A frame header: precision 8, height, width, one grey component. */
function sof(marker: number, width: number, height: number): number[] {
  return segment(marker, [8, ...uint16(height), ...uint16(width), 1, 0x01, 0x11, 0x00]);
}

const APP0_JFIF = segment(0xe0, [
  0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, ...uint16(72), ...uint16(72), 0, 0,
]);

const SOI = [0xff, 0xd8];

function bytes(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

describe("readJpegHeader", () => {
  it("reads width and height from SOI, APP0, SOF0", () => {
    const jpeg = bytes(SOI, APP0_JFIF, sof(0xc0, 1080, 1440));
    expect(readJpegHeader(jpeg)).toEqual({ width: 1080, height: 1440 });
  });

  it("reads a progressive frame header (SOF2)", () => {
    const jpeg = bytes(SOI, APP0_JFIF, sof(0xc2, 640, 480));
    expect(readJpegHeader(jpeg)).toEqual({ width: 640, height: 480 });
  });

  it("answers null for PNG magic", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(readJpegHeader(png)).toBeNull();
    expect(hasJpegMagic(png)).toBe(false);
  });

  it("answers null for a file truncated before the frame header", () => {
    const jpeg = bytes(SOI, APP0_JFIF);
    expect(readJpegHeader(jpeg)).toBeNull();
    // Cut inside the APP0 segment itself.
    expect(readJpegHeader(jpeg.subarray(0, 8))).toBeNull();
  });

  it("answers null for a segment whose length runs past the buffer", () => {
    // APP0 claims 200 bytes of payload and provides 4.
    const lying = [0xff, 0xe0, ...uint16(202), 1, 2, 3, 4];
    const jpeg = bytes(SOI, lying, sof(0xc0, 1080, 1440));
    expect(readJpegHeader(jpeg)).toBeNull();
  });

  it("reads through a 0xFF fill byte before a marker", () => {
    const jpeg = bytes(SOI, [0xff], APP0_JFIF, [0xff, 0xff], sof(0xc0, 900, 1200));
    expect(readJpegHeader(jpeg)).toEqual({ width: 900, height: 1200 });
  });

  it("skips standalone markers and Huffman tables on the way", () => {
    const dht = segment(0xc4, [0x00, 1, 2, 3]);
    const jpeg = bytes(SOI, [0xff, 0x01], [0xff, 0xd0], dht, sof(0xc1, 800, 600));
    expect(readJpegHeader(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it("answers null when the scan starts before any frame header", () => {
    const sos = segment(0xda, [1, 1, 0x00, 0, 63, 0]);
    const jpeg = bytes(SOI, APP0_JFIF, sos, [0x12, 0x34], sof(0xc0, 100, 100));
    expect(readJpegHeader(jpeg)).toBeNull();
  });

  it("answers null when the picture ends before any frame header", () => {
    expect(readJpegHeader(bytes(SOI, [0xff, 0xd9]))).toBeNull();
  });

  it("answers null for a byte that is not a marker where one is due", () => {
    expect(readJpegHeader(bytes(SOI, [0x00, 0x10]))).toBeNull();
  });

  it("answers null for a frame header too short to hold a size", () => {
    expect(readJpegHeader(bytes(SOI, segment(0xc0, [8, 0, 0])))).toBeNull();
  });

  it("answers null for a zero width or height", () => {
    expect(readJpegHeader(bytes(SOI, sof(0xc0, 0, 480)))).toBeNull();
    expect(readJpegHeader(bytes(SOI, sof(0xc0, 640, 0)))).toBeNull();
  });

  it("does not look past the first 64 KB", () => {
    // Application segments carry at most 65533 bytes of payload each, so two
    // of them push the frame header beyond the scan limit.
    const big = segment(0xe1, new Array<number>(60_000).fill(0));
    const jpeg = bytes(SOI, big, big, sof(0xc0, 1080, 1440));
    expect(jpeg.length).toBeGreaterThan(JPEG_HEADER_SCAN_LIMIT_BYTES);
    expect(readJpegHeader(jpeg)).toBeNull();
    // The same header inside the limit reads.
    expect(readJpegHeader(bytes(SOI, big, sof(0xc0, 1080, 1440)))).toEqual({
      width: 1080,
      height: 1440,
    });
  });

  it("answers null for an empty or two byte input", () => {
    expect(readJpegHeader(new Uint8Array(0))).toBeNull();
    expect(readJpegHeader(bytes(SOI))).toBeNull();
  });
});
