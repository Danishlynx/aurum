"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { copy } from "@/lib/shared/copy";

/**
 * Sheet, per docs/02-design-system.md: slides up from the bottom, Basalt,
 * radius-md on the top corners, a 32px Umber drag handle. Motion is 280ms, read
 * from --duration-sheet so prefers-reduced-motion drops it to 0.
 *
 * The scrim is the Obsidian canvas at 90 percent opacity, not a gradient.
 *
 * Keyboard, docs/06-safety-privacy.md "Accessibility as safety": "The whole flow
 * works with a keyboard on desktop." A sheet is the one surface in this app that
 * covers the screen it opened over, so it owns three things:
 *
 * 1. Focus moves into the panel when it opens, and Tab stays inside it. Without
 *    the trap, one Tab past the close control lands on the screen behind, which
 *    is covered by the scrim and cannot be seen.
 * 2. Escape closes it, which is the keyboard equivalent of tapping the scrim.
 * 3. Focus returns to the control that opened it, so a person is put back where
 *    they were rather than at the top of the document. A sheet that opened on
 *    its own (the undertone adjuster with no undertone on the profile) has no
 *    opener to return to, and nothing is moved in that case.
 *
 * The scrim is a mouse affordance only: it carries the same action as the close
 * control below the content, so putting it in the tab order would mean tabbing
 * past a second, invisible "Close" to reach the sheet. It is out of the tab
 * order and hidden from assistive technology, and Escape is its keyboard half.
 */

/** Everything a person can reach with Tab. Used to find the ends of the trap. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type SheetProps = {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
};

export function Sheet({ open, title, onClose, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** The control focus came from, restored when the sheet closes. */
  const openerRef = useRef<HTMLElement | null>(null);
  /**
   * Every caller writes onClose inline, so its identity changes on every render
   * of the screen behind the sheet. Read through a ref, the effect below can
   * depend on open alone: typing a letter into the delete confirmation re
   * renders this component, and an effect that re ran there would restore focus
   * to the opener between two keystrokes.
   */
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    // The panel itself, not the first control inside it: a screen reader then
    // reads the title before the choices, and Tab moves forward from the top.
    panelRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        // Nothing inside to tab to, so Tab holds the panel rather than leaving.
        event.preventDefault();
        panel.focus();
        return;
      }

      const target = document.activeElement;
      const inside = panel.contains(target);
      if (event.shiftKey) {
        if (!inside || target === first || target === panel) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || target === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const opener = openerRef.current;
      openerRef.current = null;
      // A control that was removed while the sheet was open (the delete control
      // after a delete) is not focused back into existence.
      if (opener !== null && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-canvas opacity-90"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
            type="button"
            onClick={onClose}
            /*
             * "Close" sets 42 wide in Manrope 16, so the box carries a minimum
             * width to reach the 44px tap target docs/06-safety-privacy.md
             * requires. It is left aligned at the foot of the sheet, so the two
             * pixels are taken on the right and the word does not move.
             */
            className="inline-flex min-h-[44px] min-w-[44px] items-center font-body text-body text-text-muted underline-offset-4 hover:underline focus-visible:underline"
          >
            {copy.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}
