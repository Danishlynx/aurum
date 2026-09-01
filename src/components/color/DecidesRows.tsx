import Link from "next/link";

import { copy } from "@/lib/shared/copy";

import { DECIDES_ROWS } from "./color-content";

/**
 * "What this decides", docs/01-user-flow.md section G item 6: three short rows
 * linking to Makeup, Hair, and Looks, each with one line.
 *
 * Rows with hairlines, no cards, no arrows appended to the labels
 * (docs/02-design-system.md, anti slop checklist item 5). The whole row is the
 * tap target, so it clears 44px on every line length.
 */
export function DecidesRows() {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">
        {copy.color.decidesHeading}
      </h2>

      <ul className="flex flex-col">
        {DECIDES_ROWS.map((row) => (
          <li key={row.href} className="border-t border-raised first:border-t-0">
            <Link
              href={row.href}
              className="flex min-h-[44px] flex-col justify-center gap-1 py-4"
            >
              <span className="font-body text-body font-semibold text-text">
                {row.label}
              </span>
              <span className="font-body text-small text-text-muted">
                {row.line}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
