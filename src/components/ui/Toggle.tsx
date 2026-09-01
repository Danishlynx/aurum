import type { ReactNode } from "react";

/**
 * The retention toggle on /welcome and /profile. docs/01-user-flow.md calls it a
 * toggle rather than a checkbox because it is optional, so it reads differently
 * from the two required boxes above it.
 *
 * docs/02-design-system.md allows exactly two radii plus the capture oval, so
 * the track and the knob are radius-sm rectangles rather than a pill. Movement
 * is 180ms from --duration-toggle, which prefers-reduced-motion drops to 0.
 *
 * The drawn track is 52 by 28, which is under the 44px tap target
 * docs/06-safety-privacy.md requires. The label beside it flips the switch too,
 * so the row was always large enough to hit, but the switch itself has to be:
 * the pseudo element takes it to 44 high without changing what is drawn. The
 * 8px it claims above and below is the gap to the row on either side, so two
 * stacked toggles never share a pixel. The offset is 9 rather than 8 because an
 * absolutely positioned pseudo element is placed against the padding box and
 * the track has a 1px hairline.
 */

type ToggleProps = {
  readonly id: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly children: ReactNode;
};

export function Toggle({
  id,
  checked,
  onCheckedChange,
  children,
}: ToggleProps) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4 py-1">
      <label htmlFor={id} className="font-body text-body text-text">
        {children}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          onCheckedChange(!checked);
        }}
        className={`relative h-7 w-[52px] shrink-0 rounded-sm border bg-surface before:absolute before:inset-x-0 before:-top-[9px] before:-bottom-[9px] before:content-[''] ${
          checked ? "border-accent" : "border-raised"
        }`}
      >
        <span
          aria-hidden="true"
          style={{
            transitionDuration: "var(--duration-toggle)",
            transitionTimingFunction: "var(--ease-in-out)",
          }}
          className={`absolute top-[3px] block h-5 w-5 rounded-sm transition-[left] ${
            checked ? "left-[27px] bg-accent" : "left-[3px] bg-raised"
          }`}
        />
      </button>
    </div>
  );
}
