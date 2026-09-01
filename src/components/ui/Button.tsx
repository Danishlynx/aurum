import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Button, per docs/02-design-system.md "Components".
 *
 * primary: Antique gold fill, Obsidian text, Manrope 600 16, height 52,
 * radius-sm, full width on mobile. One per screen.
 * secondary: transparent, 1px Umber hairline, Ivory text. Hover and focus move
 * the hairline to gold.
 * quiet: text only, Sand, underlined on focus.
 * Disabled: Umber fill, Sand text, no opacity tricks.
 *
 * There is no shadow, no gradient, and no transition. A button changes color the
 * instant it is touched, so nothing animates that the person did not trigger.
 */

export type ButtonVariant = "primary" | "secondary" | "quiet";

const FILLED_BASE =
  "inline-flex h-[52px] w-full items-center justify-center rounded-sm px-4 text-center font-body text-body font-semibold";

/** Quiet buttons are text, so the 44px tap target comes from the min height. */
const QUIET_BASE =
  "inline-flex min-h-[44px] items-center font-body text-body underline-offset-4";

export function buttonClassName(
  variant: ButtonVariant,
  disabled = false,
): string {
  if (variant === "quiet") {
    return disabled
      ? `${QUIET_BASE} cursor-default text-text-muted`
      : `${QUIET_BASE} text-text-muted hover:underline focus-visible:underline`;
  }
  if (disabled) {
    return `${FILLED_BASE} cursor-default border border-raised bg-raised text-text-muted`;
  }
  if (variant === "primary") {
    return `${FILLED_BASE} border border-accent bg-accent text-canvas`;
  }
  return `${FILLED_BASE} border border-raised bg-transparent text-text hover:border-accent`;
}

type ButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "className" | "children"
> & {
  readonly variant: ButtonVariant;
  readonly children: ReactNode;
};

export function Button({ variant, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={buttonClassName(variant, disabled === true)}
      {...rest}
    />
  );
}

type ButtonLinkProps = {
  readonly variant: ButtonVariant;
  readonly href: string;
  readonly children: ReactNode;
  /** Set for a listing or a video, which docs/01 says opens in a new tab. */
  readonly external?: boolean;
};

export function ButtonLink({
  variant,
  href,
  children,
  external = false,
}: ButtonLinkProps) {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={buttonClassName(variant)}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClassName(variant)}>
      {children}
    </Link>
  );
}
