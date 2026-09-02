"use client";

import { useRouter } from "next/navigation";

import { copy } from "@/lib/shared/copy";

/**
 * The back control from the screen skeleton in docs/02-design-system.md
 * ("back    title    profile").
 *
 * docs/02, Iconography: "Icons never appear without a text label except the
 * shutter and the back control", so this is a chevron with an accessible name
 * and no visible one. It is drawn to the icon spec the doc gives: 20px, 1.5px
 * stroke, Sand at rest and Ivory once it is hovered or focused.
 *
 * It is drawn as a chip rather than as a bare glyph because on /capture it sits
 * over a live camera feed, where a hairline on its own would disappear against
 * a bright frame. Basalt fill, Umber hairline, radius-sm: the parts the design
 * system already defines, and the same construction as Chip.
 *
 * Where it goes: back through the history when there is history to go back
 * through, because /capture is reached both from /welcome on a first run and
 * from "Retake photo" on /report, and only the history knows which. A screen
 * opened directly has no previous screen, so it falls back to the href the
 * caller names.
 */

type BackControlProps = {
  /** Where to go when this tab has no previous screen. */
  readonly fallbackHref: string;
  /** Layout classes for the control itself, never colors or type. */
  readonly className?: string;
};

export function BackControl({
  fallbackHref,
  className = "",
}: BackControlProps) {
  const router = useRouter();

  function handleClick(): void {
    // Read at click time, so the server render and the first client render
    // agree and nothing depends on the history during hydration.
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallbackHref);
  }

  return (
    <button
      type="button"
      aria-label={copy.common.back}
      onClick={handleClick}
      className={`flex h-11 w-11 items-center justify-center rounded-sm border border-raised bg-surface text-text-muted hover:text-text focus-visible:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 4.5 6.5 10l5.5 5.5" />
      </svg>
    </button>
  );
}
