import Link from "next/link";

import { copy } from "@/lib/shared/copy";

/**
 * The back control from the screen skeleton in docs/02-design-system.md
 * ("Layout"): top left of the header row, Sand, above the screen title.
 *
 * It is drawn as a chevron with no visible label, which the design system allows
 * for exactly two controls: "Icons never appear without a text label except the
 * shutter and the back control." The label is still there for a screen reader,
 * as copy.nav.back, so the control is never nameless.
 *
 * The chevron is Lucide's chevron-left, drawn inline at the system's own weight
 * (1.5px stroke, 20px, currentColor) the same way the checkbox tick is. Nothing
 * is imported to draw one path.
 *
 * href is nullable on purpose, and null renders nothing. The decision about
 * which screens have a way back, and where each one goes, belongs to the table
 * in src/lib/shared/navigation.ts rather than to the screens: a control that
 * appears on one screen and not another has to be decided in one place, or the
 * app grows chevrons that point at guesses.
 *
 * The box is 44px in both directions (docs/06-safety-privacy.md, "Tap targets
 * are at least 44px"), and the chevron sits at its left edge, so it lines up
 * with the 20px column padding the screen title starts at.
 */

type BackLinkProps = {
  /** Where back goes, or null when this screen has no way back. */
  readonly href: string | null;
};

export function BackLink({ href }: BackLinkProps) {
  if (href === null) {
    return null;
  }

  return (
    <Link
      href={href}
      aria-label={copy.nav.back}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-start text-text-muted hover:text-text"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 18 9 12 15 6" />
      </svg>
    </Link>
  );
}
