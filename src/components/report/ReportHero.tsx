"use client";

import { useState } from "react";

import { Chip } from "@/components/ui/Chip";
import { cssImageUrl } from "@/components/ui/remote-image";
import type { ConcernView } from "@/lib/shared/report-view";

import {
  defaultConcernKey,
  hasHeroContent,
  orderedConcerns,
} from "./report-content";

/**
 * The report hero, docs/01-user-flow.md section F item 1: the selfie with mask
 * toggles, one small toggle per detected concern, tapping one shows that
 * concern's mask, the top concern is active by default.
 *
 * docs/02-design-system.md, MaskToggle: "a chip row above the hero. The active
 * one shows its Leaf mask on the face. Exactly one active at a time." The hero
 * is square cornered, the only image in the product is the person's own face,
 * and the mask is drawn in Leaf, the one translucent gold in the system.
 *
 * The mask image is used as a CSS mask so the color on the face is always the
 * Leaf token and never whatever the provider painted. UNVERIFIED: Perfect Corp's
 * mask format has not been confirmed against a live response yet (docs/04, the
 * verify first task), so maskMode is set to luminance, which is right for a
 * white on black mask. If the real masks arrive with an alpha channel instead,
 * change the two maskMode lines and nothing else.
 *
 * The face is never covered by a spinner and nothing here animates on its own:
 * switching a toggle is a tap, so the mask crossfades over --duration-toggle,
 * which prefers-reduced-motion drops to zero.
 */

type ReportHeroProps = {
  readonly captureImageUrl: string | null;
  readonly concerns: readonly ConcernView[];
};

export function ReportHero({ captureImageUrl, concerns }: ReportHeroProps) {
  const ordered = orderedConcerns(concerns);
  const [activeKey, setActiveKey] = useState<string | null>(() =>
    defaultConcernKey(ordered),
  );

  const active = ordered.find((concern) => concern.key === activeKey) ?? null;
  const maskUrl = active?.maskUrl ?? null;
  const maskValue = maskUrl === null ? null : cssImageUrl(maskUrl);

  // Nothing to draw: no selfie and no mask. The page asks the same question
  // before it gives this component a column to sit in.
  if (!hasHeroContent({ captureImageUrl, concerns: ordered })) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {ordered.length > 0 ? (
        /*
         * One row, as docs/02-design-system.md specifies, scrolled sideways
         * rather than wrapped: a report can carry a dozen concerns, and three
         * wrapped rows of chips would push the person's own face off the screen.
         * The top concern is first, so the default is always in view.
         */
        <div
          role="group"
          // py-1.5 leaves room for the 44px tap area the chip extends above and
          // below itself, so scrolling sideways never scrolls anything upward.
          className="flex gap-2 overflow-x-auto py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            marginInline: "calc(var(--column-padding) * -1)",
            paddingInline: "var(--column-padding)",
          }}
        >
          {ordered.map((concern) => (
            <span key={concern.key} className="shrink-0">
              <Chip
                selected={concern.key === activeKey}
                onSelect={() => {
                  setActiveKey(concern.key);
                }}
              >
                {concern.label}
              </Chip>
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative aspect-square w-full overflow-hidden bg-surface">
        {captureImageUrl === null ? null : (
          /*
           * The person's own frame, from a short lived signed URL. It is not run
           * through the image optimizer: docs/03-architecture.md keeps the
           * optimizer for product thumbnails and renders, and a signed URL that
           * expires is not something to cache at the edge.
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={captureImageUrl}
            // Described by the toggles and the reading below it.
            alt=""
            className="h-full w-full object-cover"
          />
        )}
        {maskValue === null ? null : (
          <span
            aria-hidden="true"
            className="absolute inset-0 transition-opacity"
            style={{
              backgroundColor: "var(--mask)",
              WebkitMaskImage: maskValue,
              maskImage: maskValue,
              WebkitMaskSize: "cover",
              maskSize: "cover",
              WebkitMaskPosition: "center",
              maskPosition: "center",
              maskMode: "luminance",
              transitionDuration: "var(--duration-toggle)",
              transitionTimingFunction: "var(--ease-in-out)",
            }}
          />
        )}
      </div>
    </div>
  );
}
