/**
 * The client side image pipeline for /capture.
 *
 * docs/01-user-flow.md section D and docs/03-architecture.md step 1: the frame
 * that is sent is the master frame (src/lib/shared/frame-geometry.ts), a 3:4
 * crop drawn straight from the video at its native size, long edge capped at
 * MASTER_MAX_LONG_EDGE and short edge floored at MASTER_MIN_SHORT_EDGE. EXIF is
 * stripped, it is hashed, and only then does anything leave the phone.
 *
 * EXIF is stripped by construction. Every byte we upload is re encoded from a
 * canvas, and a canvas carries pixels only, so orientation, GPS, and device
 * metadata cannot survive the round trip. Orientation is applied while decoding
 * so the re encoded pixels are already the right way up.
 *
 * The sizes the frame is drawn at all live in frame-geometry.ts now
 * (MASTER_MAX_LONG_EDGE, MASTER_MIN_SHORT_EDGE, GUIDANCE_SAMPLE_LONG_EDGE,
 * BURST_MEASURE_LONG_EDGE). This module keeps the drawing helpers, the preview
 * sizes, the JPEG qualities and the decoder.
 */

import type { Box, GrayscaleImage } from "@/lib/shared/quality";

/**
 * The still shown behind the reveal on /analyzing. Smaller than the upload
 * because it travels through sessionStorage as a data URL.
 */
export const PREVIEW_LONG_EDGE = 720;

/**
 * The long edge a garment photo is re encoded at before it goes to storage
 * (src/components/wardrobe/WardrobeScreen.tsx). Not a face frame: the garment
 * classifier reads it and no engine gate applies, so it keeps the size the
 * wardrobe was built on.
 */
export const GARMENT_LONG_EDGE = 1024;

export const CAPTURE_JPEG_QUALITY = 0.92;
export const PREVIEW_JPEG_QUALITY = 0.72;

export type Size = { readonly width: number; readonly height: number };

/** The size that fits inside longEdge without changing the aspect ratio. */
export function fitWithin(size: Size, longEdge: number): Size {
  const largest = Math.max(size.width, size.height);
  if (largest <= longEdge) {
    return { width: Math.round(size.width), height: Math.round(size.height) };
  }
  const scale = longEdge / largest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * The same size, scaled up if needed so its short side reaches minShortEdge.
 * Returns the size untouched when it already does, or when no floor was asked
 * for, so this is inert everywhere but a frame drawn with the master floor.
 */
export function atLeastShortEdge(size: Size, minShortEdge: number): Size {
  const shortest = Math.min(size.width, size.height);
  if (minShortEdge <= 0 || shortest <= 0 || shortest >= minShortEdge) {
    return size;
  }
  const scale = minShortEdge / shortest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("This browser did not give a 2d canvas context.");
  }
  return context;
}

/** Draws any image source into a fresh canvas, scaled to fit longEdge. */
export function drawToCanvas(
  source: CanvasImageSource,
  sourceSize: Size,
  longEdge: number,
): HTMLCanvasElement {
  const target = fitWithin(sourceSize, longEdge);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = context2d(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, target.width, target.height);
  return canvas;
}

/**
 * Draws one region of an image source into a fresh canvas, scaled to fit
 * longEdge. The counterpart of drawToCanvas for a crop: the master frame cut
 * from a video (drawMasterCrop below), the upload composed by masterCropFor,
 * and the reframe retry's box (src/lib/client/capture-source.ts).
 *
 * The region is taken off the source at its own resolution rather than off an
 * already downscaled copy, so a 4000px gallery photo cropped to its face still
 * arrives at the full long edge instead of at the fraction of it the crop would
 * have been. fitWithin never scales up, so a small crop stays its own size
 * rather than being stretched into a soft frame.
 *
 * minShortEdge is the one exception to that, and it defaults to off. The
 * engine's own floor is MASTER_MIN_SHORT_EDGE (480 px on the short side, the
 * skin analysis minimum), and a frame under it is refused before it is read at
 * all. Scaling such a frame up buys nothing in detail but it is the difference
 * between a reading and a refusal, so both upload paths and the retry pass the
 * floor here, and the geometry in frame-geometry.ts stays in source pixels.
 */
export function drawCropToCanvas(
  source: CanvasImageSource,
  region: Box,
  longEdge: number,
  minShortEdge = 0,
): HTMLCanvasElement {
  const regionWidth = Math.max(1, Math.round(region.width));
  const regionHeight = Math.max(1, Math.round(region.height));
  const target = atLeastShortEdge(
    fitWithin({ width: regionWidth, height: regionHeight }, longEdge),
    minShortEdge,
  );
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = context2d(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    Math.round(region.x),
    Math.round(region.y),
    regionWidth,
    regionHeight,
    0,
    0,
    target.width,
    target.height,
  );
  return canvas;
}

/**
 * The master frame, drawn straight from the video.
 *
 * rect is masterRectFor(track) in the track's own pixels (the largest centred
 * 3:4 crop, src/lib/shared/frame-geometry.ts), which is exactly what the 3:4
 * stage shows by object-cover, so the picture this returns is the picture the
 * person framed in, un mirrored. It is the one source rect the capture screen
 * ever draws with: the live line samples it at GUIDANCE_SAMPLE_LONG_EDGE, and
 * the shutter takes it at native size with the engine's long edge cap and
 * short edge floor. No snapshot of the whole sensor frame is taken any more,
 * which is what used to cost five sensor sized canvases per tap.
 */
export function drawMasterCrop(
  video: HTMLVideoElement,
  rect: Box,
  longEdge: number,
  minShortEdge: number,
): HTMLCanvasElement {
  return drawCropToCanvas(video, rect, longEdge, minShortEdge);
}

export function readImageData(canvas: HTMLCanvasElement): ImageData {
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Rec. 709 luminance, 0 to 255, which is the single channel the quality gate in
 * src/lib/shared/quality.ts measures.
 */
export function toGrayscale(image: ImageData): GrayscaleImage {
  const { data, width, height } = image;
  const gray = new Uint8ClampedArray(width * height);
  for (let index = 0, pixel = 0; pixel < gray.length; index += 4, pixel += 1) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    gray[pixel] = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  }
  return { data: gray, width, height };
}

export function toJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error("The browser could not encode the frame."));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

export function toDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL("image/jpeg", quality);
}

/** SHA 256 of the bytes we are about to upload, as 64 lowercase hex characters. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type DecodedImage = {
  readonly source: CanvasImageSource;
  readonly size: Size;
  /** Frees the decoder resource. Always call it once the canvas is drawn. */
  readonly release: () => void;
};

/**
 * Decodes an uploaded file with its EXIF orientation applied, so the pixels we
 * re encode are already upright and the metadata is dropped with the original.
 *
 * Three ways in, tried in order. createImageBitmap with imageOrientation
 * "from-image" is the one that applies the orientation (Safari 16 and Chrome
 * 112 onward). Chrome before 112 and Safari before 16 throw a TypeError on
 * that option rather than ignore it, so the same call is made again without
 * options: the browser then applies the orientation itself or does not, which
 * is still a picture. A browser with no createImageBitmap at all, or one that
 * refuses the file both ways, gets the img element, which every browser has.
 * A file none of them can read throws, and the capture screen says why when it
 * can (src/lib/shared/image-format.ts, the HEIC sniff).
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await bitmapFrom(file);
    if (bitmap !== null) {
      return {
        source: bitmap,
        size: { width: bitmap.width, height: bitmap.height },
        release: () => {
          bitmap.close();
        },
      };
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve(image);
      };
      image.onerror = () => {
        reject(new Error("The browser could not read that image file."));
      };
      image.src = url;
    });
    return {
      source: element,
      size: { width: element.naturalWidth, height: element.naturalHeight },
      release: () => {
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * createImageBitmap with the orientation option, then without it on the
 * TypeError an older browser throws for the option, then null so the caller
 * falls to the img path. Any other failure (a file the decoder cannot read)
 * also answers null: the img path is the second opinion, and it is the one
 * that finally throws.
 */
async function bitmapFrom(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    if (!(error instanceof TypeError)) {
      return null;
    }
  }
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}
