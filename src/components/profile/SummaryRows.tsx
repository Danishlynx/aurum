import Link from "next/link";

import { buttonClassName } from "@/components/ui/Button";
import type { ProfileSummaryRow } from "@/lib/shared/profile-view";

import {
  affordanceHref,
  affordanceLabel,
  summaryLabelId,
  summaryValueIsMissing,
  summaryValueLine,
} from "./profile-content";

/**
 * The profile summary, docs/01-user-flow.md section L item 1: "the profile
 * summary as short rows: skin type, top concern, tone and undertone, season,
 * face shape, hair type. Each row has a 'Retake' or 'Adjust' affordance where it
 * applies."
 *
 * Rows with hairlines, not cards (docs/02-design-system.md, anti slop checklist
 * item 4). The label sits in Sand small above the value in Ivory body, 8px
 * apart, which is the label to content rhythm the design system sets.
 *
 * A row whose reading never came back says so in Sand rather than showing a dash
 * or an empty space, and keeps its affordance, which is the way out of that
 * state. There is no heading above the list: the screen title is "Profile" and
 * the doc gives these rows no name of their own.
 *
 * The affordance is a quiet link, so the only gold on this screen stays with the
 * retention toggle below.
 */

type SummaryRowsProps = {
  readonly rows: readonly ProfileSummaryRow[];
};

export function SummaryRows({ rows }: SummaryRowsProps) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col">
      {rows.map((row) => {
        const href = affordanceHref(row.action);
        const label = affordanceLabel(row.action);
        const labelId = summaryLabelId(row.key);
        const missing = summaryValueIsMissing(row.value);

        return (
          <li
            key={row.key}
            className="flex min-h-[44px] items-center justify-between gap-4 border-t border-raised py-4 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-col gap-2">
              <span
                id={labelId}
                className="font-body text-small text-text-muted"
              >
                {row.label}
              </span>
              <span
                className={`max-w-[70ch] font-body text-body ${
                  missing ? "text-text-muted" : "text-text"
                }`}
              >
                {summaryValueLine(row.value)}
              </span>
            </div>

            {href === null || label === null ? null : (
              <Link
                href={href}
                aria-describedby={labelId}
                className={`${buttonClassName("quiet")} shrink-0`}
              >
                {label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
