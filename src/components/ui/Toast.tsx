"use client";

import { useEffect } from "react";

/**
 * Toast, per docs/02-design-system.md: bottom, Basalt, Ivory text, one line,
 * 3 seconds, no icon. docs/01-user-flow.md adds: sentence case, one line.
 *
 * "Bottom" means the bottom of the screen's content, not of the glass. Every
 * screen that raises a toast is inside the (app) group, which carries the bottom
 * navigation (src/components/app-shell/BottomNav.tsx: 56 high plus its 1px
 * hairline), and a toast 24 above the viewport floor covered the five navigation
 * labels for its three seconds. It is offset by the height of that navigation
 * instead, so the 24 is measured from the thing it must not cover.
 */

const TOAST_MILLISECONDS = 3000;

/** BottomNav: 56 high, a 1px hairline above it, and the 24 gap above that. */
const BOTTOM_OFFSET = "81px";

type ToastProps = {
  /** Null when nothing is showing. A new string restarts the 3 seconds. */
  readonly message: string | null;
  readonly onDismiss: () => void;
};

export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (message === null) {
      return;
    }
    const timer = window.setTimeout(onDismiss, TOAST_MILLISECONDS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [message, onDismiss]);

  if (message === null) {
    return null;
  }

  return (
    <div
      style={{ bottom: BOTTOM_OFFSET }}
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-[var(--column-padding)]"
    >
      <p
        role="status"
        className="w-full max-w-[var(--column-max)] rounded-sm border border-raised bg-surface px-4 py-3 font-body text-body text-text"
      >
        {message}
      </p>
    </div>
  );
}
