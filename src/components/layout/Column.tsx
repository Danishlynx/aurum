import type { ReactNode } from "react";

/**
 * The one content column, per docs/02-design-system.md "Layout": mobile first at
 * 390px with 20px side padding, and on desktop a 480px column centered on the
 * Obsidian canvas. It never reflows into multi column.
 */

type ColumnProps = {
  readonly children: ReactNode;
  /** Extra layout classes for the column itself, never colors or type. */
  readonly className?: string;
};

export function Column({ children, className = "" }: ColumnProps) {
  return (
    <div
      className={`mx-auto w-full max-w-[var(--column-max)] px-[var(--column-padding)] ${className}`}
    >
      {children}
    </div>
  );
}
