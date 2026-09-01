import type { ReactNode } from "react";

/**
 * The retention toggle on /welcome and /profile. docs/01-user-flow.md calls it a
 * toggle rather than a checkbox because it is optional, so it reads differently
 * from the two required boxes above it.
 *
 * docs/02-design-system.md allows exactly two radii plus the capture oval, so
 * the track and the knob are radius-sm rectangles rather than a pill. Movement
 * is 180ms from --duration-toggle, which prefers-reduced-motion drops to 0.
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
        className={`relative h-7 w-[52px] shrink-0 rounded-sm border bg-surface ${
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
