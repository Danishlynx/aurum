"use client";

import { useId } from "react";
import type { ChangeEvent } from "react";

import { buttonClassName } from "@/components/ui/Button";
import type { ButtonVariant } from "@/components/ui/Button";
import { copy } from "@/lib/shared/copy";
import { MAX_GARMENTS_PER_REQUEST } from "@/lib/shared/wardrobe-view";

/**
 * "Add garments", docs/01-user-flow.md section J items 1 and 2: the empty state's
 * button, and the add flow's "multi select from the camera roll".
 *
 * Built the same way as "Upload instead" on /capture: the input carries the
 * semantics and the keyboard focus, the label carries the look, so a keyboard
 * person still sees the gold hairline. multiple is what makes it a multi select;
 * accept keeps the picker on images.
 *
 * More than MAX_GARMENTS_PER_REQUEST photos in one pick are cut here rather than
 * refused, so a person who selected their whole camera roll gets the first
 * armful added instead of an error. The ceiling itself lives with the route's
 * schema in src/lib/shared/wardrobe-view.ts.
 */

type AddGarmentsProps = {
  readonly variant: ButtonVariant;
  readonly disabled?: boolean;
  readonly onFiles: (files: File[]) => void;
};

export function AddGarments({
  variant,
  disabled = false,
  onFiles,
}: AddGarmentsProps) {
  const id = useId();

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const picked = Array.from(event.target.files ?? []);
    // Cleared so picking the same photos twice still fires a change.
    event.target.value = "";
    if (picked.length === 0) {
      return;
    }
    onFiles(picked.slice(0, MAX_GARMENTS_PER_REQUEST));
  }

  return (
    <span className="relative flex w-full">
      <input
        id={id}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        onChange={handleChange}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        className={`${buttonClassName(variant, disabled)} cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent`}
      >
        {copy.wardrobe.addAction}
      </label>
    </span>
  );
}
