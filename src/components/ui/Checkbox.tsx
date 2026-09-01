import type { ChangeEvent, ReactNode } from "react";

/**
 * The consent checkbox on /welcome. docs/02-design-system.md has no checkbox
 * entry, so this is built from the parts the system does define: Basalt fill,
 * Umber hairline, radius-sm, a gold hairline when selected, Ivory text, and a
 * 44px tap target from the row.
 *
 * The input itself carries the semantics and the keyboard behaviour; the drawn
 * box is a sibling, so focus and checked state come straight from the input.
 */

type CheckboxProps = {
  readonly id: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly children: ReactNode;
};

export function Checkbox({
  id,
  checked,
  onCheckedChange,
  children,
}: CheckboxProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onCheckedChange(event.target.checked);
  }

  return (
    <label
      htmlFor={id}
      className="flex min-h-[44px] cursor-pointer items-center gap-3 py-1"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border bg-surface peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
          checked ? "border-accent" : "border-raised"
        }`}
      >
        {checked ? (
          <svg
            viewBox="0 0 20 20"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent"
          >
            <path d="M4 10.5 8 14.5 16 5.5" />
          </svg>
        ) : null}
      </span>
      <span className="font-body text-body text-text">{children}</span>
    </label>
  );
}
