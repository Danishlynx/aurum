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

/** Removes objects. Missing objects are not an error worth failing a job for. */
export async function removeObjects(
  bucket: BucketName,
  storagePaths: readonly string[],
): Promise<void> {
  if (storagePaths.length === 0) {
    return;
  }
  await serviceClient()
    .storage.from(bucket)
    .remove([...storagePaths]);
}
