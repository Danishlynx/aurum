"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { copy } from "@/lib/shared/copy";

/**
 * Sheet, per docs/02-design-system.md: slides up from the bottom, Basalt,
 * radius-md on the top corners, a 32px Umber drag handle. Motion is 280ms, read
 * from --duration-sheet so prefers-reduced-motion drops it to 0.
 *
 * The scrim is the Obsidian canvas at 90 percent opacity, not a gradient.
 */

type SheetProps = {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
};

export function Sheet({ open, title, onClose, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    document.addEventListener("keydown", handleKeyDown);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, handleKeyDown]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label={copy.common.close}
        onClick={onClose}
        className="absolute inset-0 bg-canvas opacity-90"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          transitionDuration: "var(--duration-sheet)",
          transitionTimingFunction: "var(--ease-out)",
        }}
        className="relative w-full max-w-[var(--column-max)] rounded-t-md border-t border-raised bg-surface px-[var(--column-padding)] pb-8 pt-4 transition-transform"
      >
        <div className="mx-auto h-1 w-8 rounded-sm bg-raised" />
        <h2 className="mt-6 font-display text-title font-normal text-text">
          {title}
        </h2>
        <div className="mt-4">{children}</div>
        <div className="mt-8">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[44px] items-center font-body text-body text-text-muted underline-offset-4 hover:underline focus-visible:underline"
          >
            {copy.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}
