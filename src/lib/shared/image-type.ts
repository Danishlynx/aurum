/**
 * The content type an image is stored under, decided by us rather than taken
 * from whoever served it.
 *
 * The buckets in supabase/migrations/0006_storage_buckets.sql accept exactly
 * three types: image/jpeg, image/png, and image/webp. A provider result URL does
 * not have to agree. The live makeup try on serves its finished render from S3
 * as "binary/octet-stream", and passing that straight through made the upload
 * fail with "mime type binary/octet-stream is not supported": the task had run,
 * the unit was spent, the picture had been downloaded, and the person still saw
 * "Preview unavailable for this shade." The same line sat in the mask writer,
 * where the failure was swallowed and the reveal simply had no mask to bloom.
 *
 * So the type is read from the bytes' declared type when that is one we can
 * store, then from the file extension on the URL, and otherwise it is JPEG,
 * which is what every render endpoint in docs/04-integrations.md returns.
 *
 * Pure, so it is unit tested without a network or a bucket.
 */

export type StoredImageContentType = "image/jpeg" | "image/png" | "image/webp";

export interface StoredImageType {
  readonly contentType: StoredImageContentType;
  /** The file extension the object path ends in. */
  readonly extension: "jpg" | "png" | "webp";
}

const JPEG: StoredImageType = { contentType: "image/jpeg", extension: "jpg" };
const PNG: StoredImageType = { contentType: "image/png", extension: "png" };
const WEBP: StoredImageType = { contentType: "image/webp", extension: "webp" };

/** The type named by a content type header, or null when it names none we store. */
function fromContentType(value: string): StoredImageType | null {
  const lowered = value.toLowerCase();
  if (lowered.includes("png")) {
    return PNG;
  }
  if (lowered.includes("webp")) {
    return WEBP;
  }
  if (lowered.includes("jpeg") || lowered.includes("jpg")) {
    return JPEG;
  }
  return null;
}

/**
 * The type named by the file extension of a URL, or null. The query string is
 * dropped first: a signed URL carries its own dots and slashes.
 */
function fromUrl(value: string): StoredImageType | null {
  const path = value.split("?")[0]?.split("#")[0] ?? "";
  const lowered = path.toLowerCase();
  if (lowered.endsWith(".png")) {
    return PNG;
  }
  if (lowered.endsWith(".webp")) {
    return WEBP;
  }
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) {
    return JPEG;
  }
  return null;
}

/**
 * The content type and extension to store one downloaded image under.
 *
 * Never throws and never returns a type the buckets refuse: an unreadable
 * content type and an extensionless URL both end at JPEG.
 */
export function storedImageType(
  contentType: string | null | undefined,
  url?: string | null,
): StoredImageType {
  const declared = typeof contentType === "string" ? fromContentType(contentType) : null;
  if (declared !== null) {
    return declared;
  }
  const named = typeof url === "string" ? fromUrl(url) : null;
  return named ?? JPEG;
}
