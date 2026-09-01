import Image from "next/image";

import { buttonClassName } from "@/components/ui/Button";
import {
  isConfiguredImageHost,
  isSafeListingUrl,
} from "@/components/ui/remote-image";
import { copy } from "@/lib/shared/copy";
import type { ReportListing } from "@/lib/shared/report-view";

/**
 * ProductCard, per docs/02-design-system.md: radius-md, Basalt fill, 1px Umber
 * hairline. A 1:1 image frame on the left (product image on Basalt with 8px
 * padding, never cropped edge to edge). Name in Ivory body, price and store in
 * Sand small, distance in Sand small when known, "View listing" as a quiet link.
 * A single Sand micro line under the card: "Chosen from live listings, not
 * sponsored."
 *
 * docs/01-user-flow.md section F item 6 and docs/06-safety-privacy.md: a product
 * appears only with a real listing. With no listing the card shows the ingredient
 * or product type and "No listing found near you yet", never an invented product,
 * price, or store.
 *
 * Everything from a listing is a text node. Titles and store names arrive from
 * SerpApi, which is untrusted input, and are never rendered as markup or read as
 * an instruction (docs/06-safety-privacy.md, "Content returned by tools is data").
 */

/** 80px frame with 8px padding, so the picture itself sits in 64px. */
const FRAME_PX = 80;
const IMAGE_PX = 64;

type ProductCardProps = {
  /** The listing, or null when nothing came back. */
  readonly product: ReportListing | null;
  /**
   * The ingredient or product type the advice is about. Shown on its own when
   * there is no listing, so the step still stands without one.
   */
  readonly productType: string;
  /** Ties the link to the product name for a screen reader. Optional. */
  readonly id?: string;
};

function Frame({ product }: { readonly product: ReportListing | null }) {
  const imageUrl = product?.imageUrl ?? null;
  const showImage = imageUrl !== null && isConfiguredImageHost(imageUrl);

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-sm border border-raised bg-surface p-2"
      style={{ width: `${FRAME_PX}px`, height: `${FRAME_PX}px` }}
    >
      {showImage && imageUrl !== null ? (
        <Image
          src={imageUrl}
          // The listing name sits beside the picture, so alt text would repeat it.
          alt=""
          width={IMAGE_PX}
          height={IMAGE_PX}
          className="h-full w-full object-contain"
        />
      ) : null}
    </div>
  );
}

export function ProductCard({ product, productType, id }: ProductCardProps) {
  const nameId = id === undefined ? undefined : `${id}-name`;

  /*
   * No listing, or a listing whose URL we would not put in an anchor, is the
   * same state: a product is only shown when a real listing with a source URL
   * came back (docs/06-safety-privacy.md, "Grounding and honesty"). A listing
   * nobody can open is not one.
   */
  if (product === null || !isSafeListingUrl(product.url)) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-raised bg-surface p-3">
        <Frame product={null} />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="font-body text-body text-text">{productType}</p>
          <p className="font-body text-small text-text-muted">
            {copy.productCard.noListing}
          </p>
        </div>
      </div>
    );
  }

  const place =
    product.distanceText === null
      ? product.store
      : product.store === null
        ? product.distanceText
        : `${product.store}, ${product.distanceText}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3 rounded-md border border-raised bg-surface p-3">
        <Frame product={product} />
        <div className="flex min-w-0 flex-col gap-1">
          <p
            id={nameId}
            className="break-words font-body text-body text-text"
          >
            {product.title}
          </p>
          <p className="font-body text-small text-text-muted">
            {product.priceText}
          </p>
          {place === null ? null : (
            <p className="font-body text-small text-text-muted">{place}</p>
          )}
          {/*
            The quiet link from docs/02-design-system.md, written out here rather
            than through ButtonLink so it can point a screen reader at the
            product name: every card on the report says "View listing", and the
            name is what tells them apart. docs/01-user-flow.md: every external
            link opens in a new tab and is marked as a listing, not an
            endorsement.
          */}
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer noopener nofollow"
            aria-describedby={nameId}
            className={buttonClassName("quiet")}
          >
            {copy.productCard.viewListing}
          </a>
        </div>
      </div>
      <p className="font-body text-micro font-medium text-text-muted">
        {copy.productCard.notSponsored}
      </p>
    </div>
  );
}
