import { ProductCard } from "@/components/ui/ProductCard";
import { Swatch } from "@/components/ui/Swatch";
import type { MakeupCategoryView } from "@/lib/shared/color-view";
import type { ReportListing } from "@/lib/shared/report-view";

import { categoryLabel, shadeProductType } from "./makeup-content";

/**
 * One shade row, docs/01-user-flow.md section H item 2: "'Lip', 'Blush',
 * 'Foundation', 'Eye'. Each row shows three swatches inside the palette, the
 * middle one selected. Selecting re renders the hero."
 *
 * The swatch is the shade variant from docs/02-design-system.md: the color
 * square with its 1px Umber hairline, the name under it in Manrope 14, and a 2px
 * Champagne ring on the selected one.
 *
 * Item 3 puts the product card for the selected shade under the row. It is the
 * same card the report uses, with the same rule: a listing appears only when a
 * real one came back.
 *
 * The section title sits 16 above its swatches, which is the gap every other
 * section title in the app keeps: the routine groups on /report, "Colors to
 * wear" and "What this decides" on /color. It was 12 here and on /hair, so the
 * two try on screens ran a tighter rhythm than the two reading screens for a
 * reason neither doc gives.
 */

type ShadeRowProps = {
  readonly category: MakeupCategoryView;
  readonly selectedIndex: number;
  readonly product: ReportListing | null;
  readonly onSelect: (shadeIndex: number) => void;
};

export function ShadeRow({
  category,
  selectedIndex,
  product,
  onSelect,
}: ShadeRowProps) {
  if (category.shades.length === 0) {
    return null;
  }

  const label = categoryLabel(category.category);
  const selected = category.shades[selectedIndex] ?? category.shades[0];
  const cardId = `makeup-${category.category}`;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">{label}</h2>

      <div
        role="group"
        aria-label={label}
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${category.shades.length}, minmax(0, 1fr))`,
        }}
      >
        {category.shades.map((shade, index) => (
          <Swatch
            key={`${category.category}-${index}`}
            hex={shade.hex}
            name={shade.name}
            size="shade"
            selected={index === selectedIndex}
            onSelect={() => {
              onSelect(index);
            }}
          />
        ))}
      </div>

      <ProductCard
        id={cardId}
        product={product}
        productType={shadeProductType(category, selected)}
      />
    </section>
  );
}
