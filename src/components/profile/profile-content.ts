/**
 * The deterministic decisions the profile screen makes about its own content.
 *
 * Pure functions and data only. No React, no I/O, no server import, so the same
 * module is safe inside the client components on this screen and can be unit
 * tested without a renderer (the pattern set by
 * src/components/report/report-content.ts).
 *
 * Spec: docs/01-user-flow.md section L.
 */

import { COLOR_ADJUSTER_HREF } from "@/components/color/color-content";
import { copy } from "@/lib/shared/copy";
import type { ProfileSummaryRow } from "@/lib/shared/profile-view";

/** The affordance a summary row carries, or none. */
export type SummaryAction = ProfileSummaryRow["action"];

/**
 * Where a row's affordance goes, docs/01-user-flow.md section L item 1: "Each
 * row has a 'Retake' or 'Adjust' affordance where it applies."
 *
 * "Retake" is a new photo, so it goes to the capture screen. "Adjust" is the
 * undertone, which only the adjuster on /color can change, so it goes there with
 * the sheet already asked for rather than leaving the person to find the "Not
 * quite right?" link themselves.
 */
export function affordanceHref(action: SummaryAction): string | null {
  switch (action) {
    case "retake":
      return "/capture";
    case "adjust":
      return COLOR_ADJUSTER_HREF;
    default:
      return null;
  }
}

/** The words on that affordance. Both are the doc's own, from copy.profile. */
export function affordanceLabel(action: SummaryAction): string | null {
  switch (action) {
    case "retake":
      return copy.profile.retakeAffordance;
    case "adjust":
      return copy.profile.adjustAffordance;
    default:
      return null;
  }
}

/**
 * The line a row shows in place of its value.
 *
 * A row with no value is a reading that never came back, so it says so. There is
 * no dash, no "unknown", and no stand in figure: docs/02-design-system.md, anti
 * slop checklist item 10, and the honesty rule in docs/06-safety-privacy.md.
 */
export function summaryValueLine(value: string | null): string {
  return value ?? copy.profile.valueUnavailable;
}

/** True when a row is showing that line rather than a reading. */
export function summaryValueIsMissing(value: string | null): boolean {
  return value === null;
}

/**
 * The id of a row's label, so the affordance beside it can point at the label
 * for its description.
 *
 * Six rows carrying a link that reads "Retake" and nothing else would be six
 * identical links to a screen reader. Pointing each one at the label it sits
 * beside says which reading it retakes, using words already on the screen rather
 * than a sentence written for assistive technology alone.
 */
export function summaryLabelId(key: ProfileSummaryRow["key"]): string {
  return `profile-row-${key}`;
}

/**
 * True when the typed confirmation matches, docs/01-user-flow.md section L:
 * "typed confirmation: the person types DELETE", and "Global states and rules":
 * "Every destructive action has a typed confirmation."
 *
 * The match is exact, including case and surrounding space. A destructive action
 * that accepts "delete " has a weaker gate than the doc asks for, and the field
 * is six characters long.
 */
export function deleteArmed(typed: string): boolean {
  return typed === copy.profile.deleteConfirmWord;
}
