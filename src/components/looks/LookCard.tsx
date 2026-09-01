import { Button } from "@/components/ui/Button";
import { ProductCard } from "@/components/ui/ProductCard";
import { copy } from "@/lib/shared/copy";
import type { LookView } from "@/lib/shared/looks-view";

import { FlatLay } from "./FlatLay";
import {
  garmentItems,
  listingItems,
  typeLabel,
  type LookHero,
} from "./looks-content";
import { ShopTheGap } from "./ShopTheGap";

/**
 * One composed look, docs/01-user-flow.md section K item 2: "two to three looks,
 * each a card with a flat lay of the garments (from the person's wardrobe) and,
 * for the top look, a rendered try on of the hero garment on the person. Each
 * look has a two line rationale from the stylist layer. Never a numeric score."
 *
 * There is no score on this card, no rank, and no "01 / 02" marker: the looks
 * are ordered, not numbered, and docs/02-design-system.md bans the marker on
 * anything that is not a sequence.
 *
 * Why it is a hairline separated block rather than a rounded card: three
 * identical rounded cards in a column is anti slop item 4, and the checklist
 * says to rework them into rows with hairlines or to vary the hierarchy. This
 * does both. The top look is the one that carries the render and the one gold
 * primary button on the screen; the looks under it carry the same content with a
 * secondary save.
 *
 * Order inside the card, and why: the render (when there is one) shows the
 * person, the flat lay shows the clothes, the rationale explains the pair, then
 * anything that has to be bought. The rationale is set in Cormorant 19/30, the
 * same as the reading on /report, because it is the same voice: a consultant
 * saying why.
 *
 * Pieces that are listings rather than clothes the person owns are drawn as
 * product cards instead of flat lay tiles, so each one carries its price, its
 * store, its link, and the "not sponsored" line (docs/06-safety-privacy.md,
 * "Grounding and honesty"). That is the whole no wardrobe state: every piece is
 * a listing, so the look is a stack of product cards under its rationale.
 */

type LookCardProps = {
  readonly look: LookView;
  /** What the hero area shows, decided by heroPresentation. */
  readonly hero: LookHero;
  /**
   * True for the first look on the screen. It takes the gold primary save, so
   * there is exactly one gold fill on the screen (docs/02-design-system.md,
   * Button: "One per screen").
   */
  readonly leading: boolean;
  readonly saving: boolean;
  readonly onSave: (lookId: string) => void;
};

export function LookCard({
  look,
  hero,
  leading,
  saving,
  onSave,
}: LookCardProps) {
  const rationaleId = `look-${look.id}-rationale`;
  const garments = garmentItems(look);
  const listings = listingItems(look);

  return (
    <article
      aria-labelledby={rationaleId}
      className="flex flex-col gap-4 border-t border-raised pt-6"
    >
      {hero.visible ? (
        <div className="flex flex-col gap-3">
          {hero.imageUrl === null ? null : (
            <div className="aspect-square w-full overflow-hidden bg-surface">
              {/*
                A real cloth try on of the hero garment on the person's own
                capture, from a short lived signed URL. Not run through the image
                optimizer, for the same reason as the report hero: a URL that
                expires is not something to cache at the edge.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={hero.imageUrl}
                // The rationale below already says what this look is.
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
            </div>
          )}

          {/*
            One line under the render, never over it. The region is live so a
            try on finishing is announced without moving focus.
          */}
          <p aria-live="polite" className="font-body text-small text-text-muted">
            {hero.statusLine ?? hero.unavailableLine ?? ""}
          </p>
        </div>
      ) : null}

      <FlatLay items={garments} labelledBy={rationaleId} />

      <p
        id={rationaleId}
        className="max-w-[64ch] font-display text-reading text-text"
      >
        {look.rationale}
      </p>

      {listings.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          {listings.map((item, index) => (
            <ProductCard
              key={item.listing.url}
              product={item.listing}
              productType={typeLabel(item.type)}
              /*
               * Ties "View listing" to this listing's own name for a screen
               * reader. Built from the look and the position rather than from
               * the URL, because an id is matched literally and a URL is
               * untrusted text.
               */
              id={`look-${look.id}-item-${index}`}
            />
          ))}
        </div>
      )}

      <ShopTheGap gaps={look.gaps} />

      <Button
        variant={leading ? "primary" : "secondary"}
        disabled={saving}
        onClick={() => {
          onSave(look.id);
        }}
      >
        {copy.looks.saveLookAction}
      </Button>
    </article>
  );
}
