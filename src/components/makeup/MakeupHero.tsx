import { Chip } from "@/components/ui/Chip";
import { copy } from "@/lib/shared/copy";

import type { HeroPresentation } from "./makeup-content";

/**
 * The makeup hero, docs/01-user-flow.md section H item 1: "the selfie with the
 * recommended full look applied by the try on API. Toggle: 'Before' and 'After'
 * (a tap and hold shows Before)."
 *
 * The toggle appears only once a render exists, because with nothing rendered
 * there is no After to compare with. Holding anywhere on the hero shows Before
 * and releasing returns to After, which is the doc's tap and hold; the two chips
 * do the same thing for a keyboard and for a screen reader.
 *
 * States, docs/01 section H: a pending render leaves the previous one on screen
 * at 70 percent with a status line under it, and never puts a spinner over the
 * face. A failed try on shows the unedited selfie with "Preview unavailable for
 * this shade." Which of those is on screen was decided by heroPresentation.
 *
 * The image swaps in place and fades from 70 percent back to full over
 * --duration-crossfade, which prefers-reduced-motion drops to zero. It is the
 * one crossfade docs/02-design-system.md allows here, and it moves only because
 * the person tapped a shade.
 */

type MakeupHeroProps = {
  readonly hero: HeroPresentation;
  readonly showBefore: boolean;
  readonly onShowBefore: () => void;
  readonly onShowAfter: () => void;
};

export function MakeupHero({
  hero,
  showBefore,
  onShowBefore,
  onShowAfter,
}: MakeupHeroProps) {
  const holdable = hero.beforeAfterAvailable;

  return (
    <div className="flex flex-col gap-3">
      {holdable ? (
        <div
          role="group"
          aria-label={copy.makeup.beforeAfterLabel}
          className="flex gap-2 py-1.5"
        >
          <Chip selected={showBefore} onSelect={onShowBefore}>
            {copy.makeup.before}
          </Chip>
          <Chip selected={!showBefore} onSelect={onShowAfter}>
            {copy.makeup.after}
          </Chip>
        </div>
      ) : null}

      <div
        className="relative aspect-square w-full overflow-hidden bg-surface"
        onPointerDown={holdable ? onShowBefore : undefined}
        onPointerUp={holdable ? onShowAfter : undefined}
        onPointerLeave={holdable ? onShowAfter : undefined}
        onPointerCancel={holdable ? onShowAfter : undefined}
      >
        {hero.imageUrl === null ? null : (
          /*
           * The person's own frame or a render of it, from a short lived signed
           * URL. Not run through the image optimizer, for the same reason as the
           * report hero: a URL that expires is not something to cache at the
           * edge (docs/03-architecture.md, "Deployment").
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero.imageUrl}
            // The shade rows and the status line below already say what this is.
            alt=""
            draggable={false}
            className={`h-full w-full select-none object-cover transition-opacity ${
              hero.dimmed ? "opacity-70" : "opacity-100"
            }`}
            style={{
              transitionDuration: "var(--duration-crossfade)",
              transitionTimingFunction: "var(--ease-in-out)",
            }}
          />
        )}
      </div>

      {/*
        One line under the hero, never over it. The region is live so a shade
        change is announced without moving focus.
      */}
      <p aria-live="polite" className="font-body text-small text-text-muted">
        {hero.statusLine ?? hero.unavailableLine ?? ""}
      </p>
    </div>
  );
}
