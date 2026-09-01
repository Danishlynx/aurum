import { Column } from "@/components/layout/Column";

/**
 * The screen title row from the skeleton in docs/02-design-system.md "Layout":
 * display-2, left aligned, in Cormorant 300.
 *
 * The (app) screens themselves are built in Layer 1 and later. Until then each
 * one renders its title so the navigation, the banner, and the shell can be
 * seen and screenshotted at 390px.
 */

type ScreenTitleProps = {
  readonly children: string;
};

export function ScreenTitle({ children }: ScreenTitleProps) {
  return (
    <Column>
      <h1 className="font-display text-display-2 font-light text-text">
        {children}
      </h1>
    </Column>
  );
}
