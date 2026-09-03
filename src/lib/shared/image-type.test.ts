import { describe, expect, it } from "vitest";

import { storedImageType } from "./image-type";

/**
 * The case this module exists for is the first one: the live makeup try on
 * serves its finished render as binary/octet-stream, and the buckets in
 * migration 0006 accept only image/jpeg, image/png, and image/webp.
 */
describe("storedImageType", () => {
  it("stores an octet stream render as the JPEG its URL says it is", () => {
    expect(
      storedImageType(
        "binary/octet-stream",
        "https://yce-us.s3-accelerate.amazonaws.com/ttl30/x/y.jpg?X-Amz-Signature=abc",
      ),
    ).toEqual({ contentType: "image/jpeg", extension: "jpg" });
  });

  it("keeps a declared type when it is one the buckets accept", () => {
    expect(storedImageType("image/png", "https://example.com/a.jpg")).toEqual({
      contentType: "image/png",
      extension: "png",
    });
    expect(storedImageType("image/jpeg; charset=binary")).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
    expect(storedImageType("image/webp")).toEqual({
      contentType: "image/webp",
      extension: "webp",
    });
  });

  it("reads the extension when the content type says nothing usable", () => {
    expect(storedImageType("application/octet-stream", "https://x/y.png")).toEqual({
      contentType: "image/png",
      extension: "png",
    });
    expect(storedImageType(null, "https://x/y.webp#fragment")).toEqual({
      contentType: "image/webp",
      extension: "webp",
    });
    expect(storedImageType(undefined, "https://x/y.JPEG")).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
  });

  it("falls back to JPEG rather than to a type no bucket accepts", () => {
    expect(storedImageType(null, null)).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
    expect(storedImageType("", "https://x/y")).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
    expect(storedImageType("text/html", "https://x/y?name=a.png")).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
  });
});
