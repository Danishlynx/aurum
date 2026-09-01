/**
 * The client side image pipeline for /capture.
 *
 * docs/01-user-flow.md section D and docs/03-architecture.md step 1: the frame
 * is downscaled to a 1024px long edge, EXIF is stripped, it is hashed, and only
 * then does anything leave the phone.
 *
 * EXIF is stripped by construction. Every byte we upload is re encoded from a
 * canvas, and a canvas carries pixels only, so orientation, GPS, and device
 * metadata cannot survive the round trip. Orientation is applied while decoding
 * so the re encoded pixels are already the right way up.
 */

import type { GrayscaleImage } from "@/lib/shared/quality";

/** docs/03-architecture.md: the upload is a 1024px long edge. */
export const CAPTURE_LONG_EDGE = 1024;

/**
 * The still shown behind the reveal on /analyzing. Smaller than the upload
 * because it travels through sessionStorage as a data URL.
 */
export const PREVIEW_LONG_EDGE = 720;

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
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    return {
      source: bitmap,
      size: { width: bitmap.width, height: bitmap.height },
      release: () => {
        bitmap.close();
      },
    };
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
