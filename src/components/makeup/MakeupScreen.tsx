"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Column } from "@/components/layout/Column";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import type { MakeupView } from "@/lib/shared/color-view";
import { copy } from "@/lib/shared/copy";
import type { ReportListing } from "@/lib/shared/report-view";

import { fetchMakeupListings } from "./listings-client";
import {
  applyingLine,
  heroPresentation,
  initialSelection,
  listingForRow,
  renderParams,
  shadeAt,
} from "./makeup-content";
import { MakeupHero } from "./MakeupHero";
import {
  fetchRender,
  requestMakeupRender,
  saveMakeupLook,
} from "./renders-client";
import { ShadeRow } from "./ShadeRow";

/**
 * H. Makeup, docs/01-user-flow.md section H: the hero with the look applied, the
 * four shade rows with the product card for the selected shade, and "Save this
 * look".
 *
 * This is the only client component on the screen, because everything here is a
 * tap: choosing a shade, holding for Before, saving. The view it renders was
 * built on the server.
 *
 * How a render is asked for:
 *
 * - The look is rendered as a whole, so every request carries all four rows'
 *   current shades, not only the row that changed (section H item 1).
 * - A request is made only when there is a photo to render on. With no photo
 *   (the original was deleted, or there is no key and nothing was ever
 *   captured) nothing is requested and the hero says "Preview unavailable for
 *   this shade." It never shows a stand in face or another person's render.
 * - While a render is in flight the previous one stays on screen at 70 percent
 *   with the status line under it. No spinner over the face.
 * - Only the newest request can change the screen. An older one that lands late
 *   is dropped, so the hero always matches the swatches.
 */

/** The poll cadence for a running render, the same as the reveal's. */
const POLL_INTERVAL_MS = 1500;
/**
 * 120 seconds, the point at which docs/03-architecture.md marks a job failed.
 * Past it the screen stops asking and shows the documented unavailable line.
 */
const MAX_POLLS = 80;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

type MakeupScreenProps = {
  readonly view: MakeupView;
};

export function MakeupScreen({ view }: MakeupScreenProps) {
  const categories = view.categories;
  const captureImageUrl = view.captureImageUrl;

  const initial = useMemo(() => initialSelection(categories), [categories]);
  const [selection, setSelection] = useState<number[]>(initial);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingLine, setPendingLine] = useState<string | null>(null);
  /*
   * With no photo there is nothing to render a look on, and that is known before
   * the first paint. Starting in the unavailable state puts the documented line
   * in the server rendered HTML rather than flashing an empty hero and then
   * saying so.
   */
  const [unavailable, setUnavailable] = useState(captureImageUrl === null);
  const [showBefore, setShowBefore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /**
   * The listings on hand, and the selection they were fetched for. The server
   * built the first pair; a shade change fetches the next one. A row whose shade
   * has moved past its listing shows the empty product state until the new
   * listing lands, because the old one is for a different shade.
   */
  const [products, setProducts] = useState<(ReportListing | null)[] | null>(
    view.product,
  );
  const [groundedSelection, setGroundedSelection] =
    useState<readonly number[]>(initial);

  /** Bumped by every new request; a stale answer is dropped. */
  const ticketRef = useRef(0);
  const groundTicketRef = useRef(0);
  const mountedRef = useRef(true);
  const askedForFirstLookRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyLook = useCallback(
    async (nextSelection: readonly number[], statusLine: string | null) => {
      ticketRef.current += 1;
      const ticket = ticketRef.current;
      const current = () => mountedRef.current && ticket === ticketRef.current;

      // No photo, no try on. Saying so is the documented state; drawing anything
      // else on the hero would be a face we did not render.
      if (captureImageUrl === null) {
        setPending(false);
        setPendingLine(null);
        setUnavailable(true);
        return;
      }

      setPending(true);
      setPendingLine(statusLine);
      setUnavailable(false);

      const started = await requestMakeupRender(
        renderParams(categories, nextSelection),
      );
      if (!current()) {
        return;
      }
      if (!started.ok) {
        setPending(false);
        setPendingLine(null);
        setUnavailable(true);
        return;
      }
      if (started.render.status === "succeeded") {
        setPending(false);
        setPendingLine(null);
        if (started.render.renderUrl === null) {
          setUnavailable(true);
          return;
        }
        setRenderUrl(started.render.renderUrl);
        return;
      }

      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await delay(POLL_INTERVAL_MS);
        if (!current()) {
          return;
        }
        const polled = await fetchRender(started.render.renderId);
        if (!current()) {
          return;
        }
        if (!polled.ok || polled.render.status === "failed") {
          break;
        }
        if (polled.render.status === "succeeded") {
          setPending(false);
          setPendingLine(null);
          if (polled.render.renderUrl === null) {
            setUnavailable(true);
            return;
          }
          setRenderUrl(polled.render.renderUrl);
          return;
        }
      }

      setPending(false);
      setPendingLine(null);
      setUnavailable(true);
    },
    [captureImageUrl, categories],
  );

  /**
   * The recommended full look, asked for once when the screen opens (section H
   * item 1). It carries no status line: the doc's line names the shade a person
   * just chose, and nobody chose this one. The same parameters answer from the
   * render cache on every later visit, so opening the screen twice costs one
   * render (docs/03-architecture.md, "Caching").
   */
  useEffect(() => {
    if (askedForFirstLookRef.current) {
      return;
    }
    askedForFirstLookRef.current = true;
    void applyLook(initial, null);
  }, [applyLook, initial]);

  /**
   * The listing for the newly selected shade, from the same route that filled
   * the cards on the first paint. A failure leaves the rows in their empty
   * product state rather than showing the previous shade's listing.
   */
  const groundSelection = useCallback(
    async (nextSelection: readonly number[]) => {
      groundTicketRef.current += 1;
      const ticket = groundTicketRef.current;
      const result = await fetchMakeupListings(categories, nextSelection);
      if (!mountedRef.current || ticket !== groundTicketRef.current) {
        return;
      }
      if (!result.ok) {
        return;
      }
      setProducts(result.products);
      setGroundedSelection(nextSelection);
    },
    [categories],
  );

  function chooseShade(categoryIndex: number, shadeIndex: number): void {
    const category = categories[categoryIndex];
    const shade = shadeAt(category, shadeIndex);
    if (category === undefined || shade === null) {
      return;
    }
    const next = [...selection];
    next[categoryIndex] = shadeIndex;
    setSelection(next);
    setShowBefore(false);
    void applyLook(next, applyingLine(category, shade));
    void groundSelection(next);
  }

  async function saveLook(): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    const saved = await saveMakeupLook(renderParams(categories, selection));
    if (!mountedRef.current) {
      return;
    }
    setSaving(false);
    setToast(saved ? copy.makeup.savedToast : copy.makeup.saveFailed);
  }

  const hero = heroPresentation({
    captureImageUrl,
    renderUrl,
    pendingLine,
    pending,
    unavailable,
    showBefore,
  });

  return (
    <div className="flex flex-col gap-8">
      <Column>
        <MakeupHero
          hero={hero}
          showBefore={showBefore}
          onShowBefore={() => {
            setShowBefore(true);
          }}
          onShowAfter={() => {
            setShowBefore(false);
          }}
        />
      </Column>

      {categories.map((category, index) => (
        <Column key={category.category}>
          <ShadeRow
            category={category}
            selectedIndex={selection[index] ?? 0}
            product={listingForRow(
              products,
              index,
              selection[index] ?? 0,
              groundedSelection[index] ?? 0,
            )}
            onSelect={(shadeIndex) => {
              chooseShade(index, shadeIndex);
            }}
          />
        </Column>
      ))}

      <Column>
        <Button
          variant="primary"
          disabled={saving}
          onClick={() => {
            void saveLook();
          }}
        >
          {copy.makeup.saveLookAction}
        </Button>
      </Column>

      <Toast
        message={toast}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </div>
  );
}
