import "server-only";

import { serviceClient, unwrap } from "./service";

/**
 * Private bucket access. Every read and write goes through a short lived signed
 * URL created here on the server (docs/06-safety-privacy.md, "Access").
 *
 * A signed URL is a bearer credential for one object. It is never logged, never
 * stored, and never returned anywhere except in the response to the person who
 * owns the object.
 */

export const BUCKETS = {
  captures: "captures",
  masks: "masks",
  renders: "renders",
  garments: "garments",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/**
 * The upload window promised to the client, docs/03-architecture.md ("60
 * seconds for upload").
 *
 * DEVIATION, recorded on purpose: Supabase mints signed upload tokens with a
 * lifetime it sets itself and the SDK exposes no expiry argument on
 * createSignedUploadUrl. This value is the window the client is told to use and
 * the window the capture flow expects; it is not a platform enforced ceiling.
 */
export const UPLOAD_URL_TTL_SECONDS = 60;

/** Read windows, docs/03-architecture.md ("10 minutes for read"). */
export const READ_URL_TTL_SECONDS = 600;

/** captures/<owner_id>/<capture_id>.<ext>, migration 0006. */
export function capturePath(
  ownerId: string,
  captureId: string,
  extension = "jpg",
): string {
  return `${ownerId}/${captureId}.${extension}`;
}

/** masks/<owner_id>/<capture_id>/<concern_key>.<ext>, migration 0006. */
export function maskPath(
  ownerId: string,
  captureId: string,
  concernKey: string,
  extension = "png",
): string {
  return `${ownerId}/${captureId}/${concernKey}.${extension}`;
}

export interface SignedUpload {
  readonly uploadUrl: string;
  /** Token form of the same grant, for clients that use uploadToSignedUrl. */
  readonly token: string;
  readonly storagePath: string;
  readonly expiresInSeconds: number;
}

export async function createSignedUpload(
  bucket: BucketName,
  storagePath: string,
): Promise<SignedUpload> {
  const result = await serviceClient()
    .storage.from(bucket)
    .createSignedUploadUrl(storagePath, { upsert: true });
  const data = unwrap(`sign upload for ${bucket}`, result);
  return {
    uploadUrl: data.signedUrl,
    token: data.token,
    storagePath: data.path,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  };
}

export async function createSignedRead(
  bucket: BucketName,
  storagePath: string,
  expiresInSeconds = READ_URL_TTL_SECONDS,
): Promise<string> {
  const result = await serviceClient()
    .storage.from(bucket)
    .createSignedUrl(storagePath, expiresInSeconds);
  const data = unwrap(`sign read for ${bucket}`, result);
  return data.signedUrl;
}

export interface StoredObject {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly byteLength: number;
}

/** Pulls an object into memory so it can be handed to a provider. */
export async function downloadObject(
  bucket: BucketName,
  storagePath: string,
): Promise<StoredObject> {
  const result = await serviceClient().storage.from(bucket).download(storagePath);
  const blob = unwrap(`download from ${bucket}`, result);
  const bytes = await blob.arrayBuffer();
  return {
    bytes,
    contentType: blob.type.length > 0 ? blob.type : "image/jpeg",
    byteLength: bytes.byteLength,
  };
}

export async function uploadObject(args: {
  readonly bucket: BucketName;
  readonly storagePath: string;
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
}): Promise<string> {
  const result = await serviceClient()
    .storage.from(args.bucket)
    .upload(args.storagePath, args.bytes, {
      contentType: args.contentType,
      upsert: true,
    });
  const data = unwrap(`upload to ${args.bucket}`, result);
  return data.path;
}

/**
 * Removes objects. Missing objects are not an error worth failing a job for, so
 * this still does not throw: a delete is called from paths that must finish
 * (removeGarment, the scheduled purges) and none of them has anything useful to
 * do with the failure.
 *
 * It does not stay silent, though. It used to discard the result entirely,
 * which meant a delete that genuinely failed looked exactly like one that
 * succeeded. removeGarment then went on to delete the row, and the photo was
 * left in the bucket with nothing pointing at it and no line anywhere saying
 * so. That is the outcome the ordering in removeGarment exists to prevent
 * ("the object goes first"), and docs/06-safety-privacy.md, "Retention", is the
 * promise it keeps. A warning is the least this can do and still be honest.
 *
 * Verified against the live project: a successful remove returns error null
 * with one entry per path actually removed, and removing a path that is already
 * gone returns error null with an empty array, so an empty result is not a
 * failure and is not logged as one.
 *
 * One live observation worth knowing when testing a delete by hand. Reading an
 * object before removing it leaves downloadObject serving the bytes for around
 * a minute after the remove has succeeded, while list() already shows the
 * object gone. A signed read URL, which is the only path anything outside this
 * server is ever given, returns 400 immediately. So the staleness is confined
 * to the service role read path and is not exposure; a test that asserts a
 * delete by calling downloadObject will still get bytes and should use list()
 * or a signed read instead.
 */
export async function removeObjects(
  bucket: BucketName,
  storagePaths: readonly string[],
): Promise<void> {
  if (storagePaths.length === 0) {
    return;
  }
  const result = await serviceClient()
    .storage.from(bucket)
    .remove([...storagePaths]);

  if (result.error !== null) {
    // The bucket and the count, never a path: an object path is part of a
    // signed URL (migration 0006, "Never log an object path").
    console.warn(
      JSON.stringify({
        event: "aurum.storage_remove_failed",
        bucket,
        objects: storagePaths.length,
        error: result.error.message,
      }),
    );
  }
}
