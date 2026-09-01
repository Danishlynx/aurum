"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Sheet } from "@/components/ui/Sheet";
import { copy } from "@/lib/shared/copy";
import type { Undertone } from "@/lib/shared/palette";

import { UNDERTONE_OPTIONS } from "./color-content";
import { saveUndertone } from "./undertone-client";

/**
 * The undertone adjuster, docs/01-user-flow.md section G item 2: a sheet with
 * three choices, "Warm", "Cool", "Neutral", each with a one line test under it.
 * "Choosing one updates the profile and re derives the palette."
 *
 * The intro line is the doc's, word for word: "Lighting can fool a camera. You
 * know your skin. Pick what is true." The sheet is titled with the doc's own
 * name for this decision, "Confirm your undertone", which is also the label the
 * tone swatch carries when no undertone came back.
 *
 * The three choices are named rows, not colored squares. A warm, a cool, and a
 * neutral reference color would be three hex values invented inside a component,
 * and every color on this screen is either a design token or data derived from
 * the person's own tone by src/lib/shared/palette.ts. Selection is shown the way
 * the design system shows it everywhere else, as a hairline that turns gold.
 *
 * After a successful save the screen is re rendered on the server, so the season
 * line and both swatch lists below come back derived from the new undertone. The
 * browser never re derives a palette of its own.
 */

type UndertoneAdjusterProps = {
  readonly open: boolean;
  /** The undertone currently on the profile, or null when none is known. */
  readonly selected: Undertone | null;
  readonly onClose: () => void;
};

export function UndertoneAdjuster({
  open,
  selected,
  onClose,
}: UndertoneAdjusterProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function choose(undertone: Undertone): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    setProblem(null);
    const result = await saveUndertone(undertone);
    setSaving(false);
    if (!result.ok) {
      setProblem(copy.color.adjusterFailed);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <Sheet open={open} title={copy.color.confirmUndertone} onClose={onClose}>
      <div className="flex flex-col gap-6">
        <p className="max-w-[64ch] font-display text-reading text-text">
          {copy.color.adjusterIntro}
        </p>

        <ul className="flex flex-col gap-3">
          {UNDERTONE_OPTIONS.map((option) => {
            const isSelected = option.undertone === selected;
            return (
              <li key={option.undertone}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    void choose(option.undertone);
                  }}
                  className={`flex min-h-[72px] w-full flex-col justify-center gap-1 rounded-sm border px-4 py-3 text-left ${
                    isSelected ? "border-accent" : "border-raised"
                  }`}
                >
                  <span className="font-display text-title text-text">
                    {option.name}
                  </span>
                  <span className="font-body text-small text-text-muted">
                    {option.test}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {problem === null ? null : (
          <p
            role="status"
            className="max-w-[70ch] font-body text-small text-text-muted"
          >
            {problem}
          </p>
        )}
      </div>
    </Sheet>
  );
}
