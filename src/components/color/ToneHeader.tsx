"use client";

import { useState } from "react";

import { ColorSquare } from "@/components/ui/Swatch";
import { copy } from "@/lib/shared/copy";
import type { Undertone } from "@/lib/shared/palette";

import { adjusterOpensAutomatically, undertoneLabel } from "./color-content";
import { UndertoneAdjuster } from "./UndertoneAdjuster";

/**
 * docs/01-user-flow.md section G item 1: "A wide swatch of the detected skin
 * tone with the undertone label ('Warm undertone') and a 'Not quite right?' link
 * that opens the undertone adjuster."
 *
 * States, from the same section: with no undertone the swatch carries "Confirm
 * your undertone" and the adjuster opens on its own. The square then draws in
 * Basalt, because there is no detected tone to paint and a stand in color would
 * be a reading we never took.
 *
 * The sheet also opens when the person arrived from the "Adjust" affordance on
 * /profile (docs/01-user-flow.md section L item 1), which asks for it by name in
 * the query string. Either way it is a sheet the person opened.
 *
 * The "Not quite right?" link is the one gold thing on this screen.
 *
 * The undertone label sits 8 under the swatch, which is what every swatch in the
 * palette grid below does (src/components/ui/Swatch.tsx, mt-2) and what
 * docs/02-design-system.md means by "8 between a label and its content". It was
 * 12 here, so the widest swatch on the screen named itself differently from the
 * twelve under it.
 */

/** The wide tone swatch, taller than a grid square and the full column wide. */
const SWATCH_HEIGHT_CLASS = "h-24";

type ToneHeaderProps = {
  readonly skinToneHex: string | null;
  readonly undertone: Undertone | null;
  /** True when the query string asked for the adjuster. See color-content.ts. */
  readonly openAdjuster?: boolean;
};

export function ToneHeader({
  skinToneHex,
  undertone,
  openAdjuster = false,
}: ToneHeaderProps) {
  const [open, setOpen] = useState(
    () => openAdjuster || adjusterOpensAutomatically(undertone),
  );

  return (
    <div className="flex flex-col gap-2">
      <ColorSquare
        hex={skinToneHex ?? ""}
        className={`w-full ${SWATCH_HEIGHT_CLASS}`}
      />
      <p className="font-display text-title text-text">
        {undertoneLabel(undertone)}
      </p>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="inline-flex min-h-[44px] items-center self-start font-body text-body text-accent underline-offset-4 hover:underline focus-visible:underline"
      >
        {copy.color.adjusterLink}
      </button>

      <UndertoneAdjuster
        open={open}
        selected={undertone}
        onClose={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}
