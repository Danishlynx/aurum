"use client";

import { useId } from "react";
import type { ChangeEvent } from "react";

import { buttonClassName } from "@/components/ui/Button";
import type { ButtonVariant } from "@/components/ui/Button";
import { copy } from "@/lib/shared/copy";

/**
 * "Upload instead", docs/01-user-flow.md section D.
 *
 * docs/06-safety-privacy.md, "Accessibility as safety": the capture screen works
 * with an uploaded photo for people who cannot use the camera. The uploaded file
 * goes through the same downscale, the same EXIF strip, and the same gate as a
 * live frame; there is no second path into the analysis.
 *
 * The input carries the semantics and the keyboard focus, the label carries the
 * look, so a keyboard person still sees the gold hairline.
 */

type UploadInsteadProps = {
  readonly variant: ButtonVariant;
  readonly disabled?: boolean;
  readonly onFile: (file: File) => void;
};

export function UploadInstead({
  variant,
  disabled = false,
  onFile,
}: UploadInsteadProps) {
  const id = useId();

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice still fires a change.
    event.target.value = "";
    if (file !== undefined) {
      onFile(file);
    }
  }

  return (
    <span className="relative flex w-full">
      <input
        id={id}
        type="file"
        accept="image/*"
        disabled={disabled}
        onChange={handleChange}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        className={`${buttonClassName(variant, disabled)} cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent`}
      >
        {copy.capture.uploadInstead}
      </label>
    </span>
  );
}
