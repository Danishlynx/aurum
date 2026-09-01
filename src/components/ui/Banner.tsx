import type { ReactNode } from "react";

/**
 * Banner, per docs/02-design-system.md: full width, Basalt, gold hairline below,
 * Manrope 12 in Sand with the count in Ivory.
 *
 * docs/01-user-flow.md keeps the judge banner visible on every screen, so this
 * renders above the column rather than inside it.
 */

type BannerProps = {
  readonly children: ReactNode;
  /** The plain sentence, for a screen reader that would otherwise read spans. */
  readonly label?: string;
};

export function Banner({ children, label }: BannerProps) {
  return (
    <div className="w-full border-b border-accent bg-surface">
      <p
        role="status"
        aria-label={label}
        className="mx-auto max-w-[var(--column-max)] px-[var(--column-padding)] py-2 font-body text-micro font-medium text-text-muted"
      >
        {children}
      </p>
    </div>
  );
}
