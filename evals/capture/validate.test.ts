import { createHash } from "node:crypto";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React server environment. The mock replaces that marker package and nothing
 * else, so the real validator runs here.
 */
vi.mock("server-only", () => ({}));

import {
  CAPTURE_MAX_BYTES,
  CAPTURE_MAX_LONG_SIDE_PX,
  CAPTURE_MIN_SHORT_SIDE_PX,
  validateCaptureObject,
} from "@/lib/server/capture/validate";
import type { StoredObject } from "@/lib/server/db/storage";
import type { Capture } from "@/lib/server/db/types";
import { isHttpError } from "@/lib/server/http/responses";
import { copy } from "@/lib/shared/copy";

/**
 * eval:capture, deterministic, runs on every PR.
 * The server side read of the stored bytes before any reservation
 * (docs/04-integrations.md, "Implementation rules").
 *
 * The bytes are built here, not read from a fixture: a header is a few dozen
 * bytes and the checks are about the header and the digest, never the picture.
 */

function uint16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function segment(marker: number, payload: readonly number[]): number[] {
  return [0xff, marker, ...uint16(payload.length + 2), ...payload];
}

/** SOI, a JFIF APP0, a baseline frame header, and a token of scan data. */
function jpegBytes(width: number, height: number, padding = 0): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 72, 0, 72, 0, 0]),
    ...segment(0xc0, [8, ...uint16(height), ...uint16(width), 1, 0x01, 0x11, 0x00]),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    ...new Array<number>(padding).fill(0x2a),
    0xff, 0xd9,
  ]);
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CAPTURE_ID = "00000000-0000-4000-8000-000000000001";

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storedObject(bytes: Uint8Array, byteLength = bytes.byteLength): StoredObject {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return { bytes: buffer, contentType: "image/jpeg", byteLength };
}

function captureRow(overrides: Partial<Capture>): Capture {
  return {
    id: CAPTURE_ID,
    user_id: "00000000-0000-4000-8000-000000000002",
    sha256: "0".repeat(64),
    storage_path: "owner/capture.jpg",
    width: 1080,
    height: 1440,
    quality: null,
    deleted_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function loggedLines(): Record<string, unknown>[] {
  return warn.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>,
  );
}

function expectRefusal(run: () => void, check: string): void {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isHttpError(thrown)).toBe(true);
  if (!isHttpError(thrown)) {
    return;
  }
  expect(thrown.status).toBe(409);
  expect(thrown.code).toBe("capture_unreadable");
  expect(thrown.message).toBe(copy.errors.captureUnreadable);

  const line = loggedLines().find(
    (entry) => entry.event === "aurum.capture_unreadable",
  );
  expect(line).toBeDefined();
  expect(line?.check).toBe(check);
  expect(line?.captureId).toBe(CAPTURE_ID);
  // The numbers, never the bytes or the digest.
  const serialized = JSON.stringify(line);
  expect(serialized).not.toContain("sha256");
  expect(serialized).not.toContain("\"bytes\"");
  expect(serialized.length).toBeLessThan(600);
}

describe("validateCaptureObject", () => {
  it("accepts a 1080 by 1440 JPEG whose digest matches the row", () => {
    const bytes = jpegBytes(1080, 1440);
    const capture = captureRow({ sha256: digestOf(bytes) });
    expect(() => validateCaptureObject(storedObject(bytes), capture)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a size mismatch between the bytes and the object", () => {
    const bytes = jpegBytes(1080, 1440);
    const capture = captureRow({ sha256: digestOf(bytes) });
    expectRefusal(
      () => validateCaptureObject(storedObject(bytes, bytes.byteLength + 10), capture),
      "size",
    );
  });

  it("refuses an empty object", () => {
    expectRefusal(
      () => validateCaptureObject(storedObject(new Uint8Array(0)), captureRow({})),
      "size",
    );
  });

  it("refuses an object over the byte ceiling before reading it", () => {
    const bytes = jpegBytes(1080, 1440);
    const capture = captureRow({ sha256: digestOf(bytes) });
    // The header is fine; the declared length is what fails.
    const oversized: StoredObject = {
      ...storedObject(bytes),
      byteLength: CAPTURE_MAX_BYTES + 1,
    };
    expectRefusal(() => validateCaptureObject(oversized, capture), "size");

    // And a real buffer over the ceiling, so the check is on the bytes too.
    const big = new Uint8Array(CAPTURE_MAX_BYTES + 1);
    big.set(bytes);
    expectRefusal(() => validateCaptureObject(storedObject(big), captureRow({})), "size");
  });

  it("refuses a PNG", () => {
    const capture = captureRow({ sha256: digestOf(PNG_BYTES) });
    expectRefusal(() => validateCaptureObject(storedObject(PNG_BYTES), capture), "format");
  });

  it("refuses a JPEG with no readable frame header", () => {
    const truncated = jpegBytes(1080, 1440).subarray(0, 12);
    const capture = captureRow({ sha256: digestOf(truncated) });
    expectRefusal(() => validateCaptureObject(storedObject(truncated), capture), "format");
  });

  it("refuses a header size other than the registered one", () => {
    const bytes = jpegBytes(1080, 1440);
    const capture = captureRow({ sha256: digestOf(bytes), width: 1440, height: 1080 });
    expectRefusal(() => validateCaptureObject(storedObject(bytes), capture), "dimensions");
  });

  it("refuses a row that registered no size", () => {
    const bytes = jpegBytes(1080, 1440);
    const capture = captureRow({ sha256: digestOf(bytes), width: null, height: null });
    expectRefusal(() => validateCaptureObject(storedObject(bytes), capture), "dimensions");
  });

  it("refuses a short side under the floor", () => {
    const short = CAPTURE_MIN_SHORT_SIDE_PX - 1;
    const bytes = jpegBytes(short, 640);
    const capture = captureRow({ sha256: digestOf(bytes), width: short, height: 640 });
    expectRefusal(() => validateCaptureObject(storedObject(bytes), capture), "short_side");
  });

  it("refuses a long side over the ceiling", () => {
    const long = CAPTURE_MAX_LONG_SIDE_PX + 1;
    const bytes = jpegBytes(1080, long);
    const capture = captureRow({ sha256: digestOf(bytes), width: 1080, height: long });
    expectRefusal(() => validateCaptureObject(storedObject(bytes), capture), "long_side");
  });

  it("refuses a digest other than the row's", () => {
    const bytes = jpegBytes(1080, 1440);
    const other = jpegBytes(1080, 1440, 3);
    const capture = captureRow({ sha256: digestOf(other) });
    expectRefusal(() => validateCaptureObject(storedObject(bytes), capture), "digest");
  });

  it("accepts a row whose digest was stored in upper case", () => {
    const bytes = jpegBytes(1080, 1440);
    const capture = captureRow({ sha256: digestOf(bytes).toUpperCase() });
    expect(() => validateCaptureObject(storedObject(bytes), capture)).not.toThrow();
  });
});
