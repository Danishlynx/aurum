"use client";

import { useEffect } from "react";

/**
 * Toast, per docs/02-design-system.md: bottom, Basalt, Ivory text, one line,
 * 3 seconds, no icon. docs/01-user-flow.md adds: sentence case, one line.
 */

const TOAST_MILLISECONDS = 3000;

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
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-[var(--column-padding)]">
      <p
        role="status"
        className="w-full max-w-[var(--column-max)] rounded-sm border border-raised bg-surface px-4 py-3 font-body text-body text-text"
      >
        {message}
      </p>
    </div>
  );
}
