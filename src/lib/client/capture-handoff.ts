/**
 * The still that /capture hands to /analyzing.
 *
 * docs/01-user-flow.md section E opens with the person's captured selfie filling
 * the screen. The uploaded object is private and behind a signed URL, so the
 * screen shows the frame the browser already has rather than fetching it back.
 *
 * It is held in sessionStorage, which is scoped to the tab and cleared when the
 * tab closes, and it is dropped as soon as /analyzing has read it.
 */

const PREVIEW_KEY = "aurum.capture.preview";

type StoredPreview = {
  readonly captureId: string;
  readonly dataUrl: string;
};

export function rememberCapturePreview(
  captureId: string,
  dataUrl: string,
): void {
  const value: StoredPreview = { captureId, dataUrl };
  try {
    window.sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(value));
  } catch {
    // Storage is full or blocked. The reveal falls back to the plain canvas.
  }
}

export function readCapturePreview(captureId: string): string | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PREVIEW_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "captureId" in parsed &&
      "dataUrl" in parsed
    ) {
      const stored = parsed as StoredPreview;
      if (
        stored.captureId === captureId &&
        typeof stored.dataUrl === "string" &&
        stored.dataUrl.startsWith("data:image/")
      ) {
        return stored.dataUrl;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function forgetCapturePreview(): void {
  try {
    window.sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // Nothing to do. The value expires with the tab.
  }
}
