import type { HairHeroPresentation } from "./hair-content";

/**
 * The hair hero, docs/01-user-flow.md section I item 2: "Tapping one enlarges
 * it." The enlarged style sits above the row, full column width, square
 * cornered, on the Basalt frame every hero in this app uses.
 *
 * States, section I: "same pending and failed patterns as Makeup". A pending
 * render leaves the previous one on screen at 70 percent with a status line
 * under it, and never puts a spinner over the face. A failed one shows the
 * unedited selfie with the preview unavailable line. Which of those is on screen
 * was decided by heroPresentation.
 *
 * The image swaps in place and fades from 70 percent back to full over
 * --duration-crossfade, which prefers-reduced-motion drops to zero. It moves
 * only because the person tapped a style or a color.
 *
 * There is no Before and After here. docs/01 gives that toggle to /makeup alone,
 * where the change sits on the face itself; on /hair the row of styles beside
 * the hero already carries the comparison.
 */

type HairHeroProps = {
  readonly hero: HairHeroPresentation;
};

export function HairHero({ hero }: HairHeroProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square w-full overflow-hidden bg-surface">
        {hero.imageUrl === null ? null : (
          /*
           * The person's own frame or a render of it, from a short lived signed
           * URL. Not run through the image optimizer, for the same reason as the
           * report and makeup heroes: a URL that expires is not something to
           * cache at the edge (docs/03-architecture.md, "Deployment").
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero.imageUrl}
            // The style row and the status line below already say what this is.
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
        One line under the hero, never over it. The region is live so a style or
        color change is announced without moving focus.
      */}
      <p aria-live="polite" className="font-body text-small text-text-muted">
        {hero.statusLine ?? hero.unavailableLine ?? ""}
      </p>
    </div>
  );
}
