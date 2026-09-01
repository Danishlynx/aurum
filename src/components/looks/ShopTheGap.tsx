import { ProductCard } from "@/components/ui/ProductCard";
import { copy } from "@/lib/shared/copy";
import { GAP_LISTING_COUNT, type LookGap } from "@/lib/shared/looks-view";

import { gapLine, gapProductType } from "./looks-content";

/**
 * "Shop the gap", docs/01-user-flow.md section K item 3: "if a look is missing a
 * piece (no shoes in the wardrobe), a product card fetched within the palette
 * and, if location is allowed, near the person. Line: 'You do not own shoes yet.
 * These sit in your palette and are near you.'"
 *
 * Up to three listings per gap, which is what the shopping pool was sized for
 * (GAP_LISTING_COUNT). A gap that came back with nothing still shows a card: the
 * empty product state names the piece and says "No listing found near you yet",
 * which is the honest answer and the one docs/06-safety-privacy.md requires. No
 * product, price, or store is ever invented to fill the row.
 *
 * The line drops "and are near you" when no listing in the gap carries a
 * distance, for the reason written on gapLine.
 */

type ShopTheGapProps = {
  readonly gaps: readonly LookGap[];
};

export function ShopTheGap({ gaps }: ShopTheGapProps) {
  if (gaps.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h3 className="font-display text-title text-text">
        {copy.looks.shopTheGapHeading}
      </h3>

      {gaps.map((gap) => (
        <div key={gap.type} className="flex flex-col gap-3">
          <p className="max-w-[64ch] font-body text-small text-text-muted">
            {gapLine(gap)}
          </p>

          {gap.listings.length === 0 ? (
            <ProductCard product={null} productType={gapProductType(gap)} />
          ) : (
            gap.listings.slice(0, GAP_LISTING_COUNT).map((listing, index) => (
              <ProductCard
                key={listing.url}
                product={listing}
                productType={gapProductType(gap)}
                /*
                 * Ties "View listing" to this listing's own name for a screen
                 * reader. Built from the gap and the position rather than from
                 * the URL, because an id is matched literally and a URL is
                 * untrusted text.
                 */
                id={`gap-${gap.type}-${index}`}
              />
            ))
          )}
        </div>
      ))}
    </section>
  );
}
