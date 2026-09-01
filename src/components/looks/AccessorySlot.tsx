"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { copy, fill } from "@/lib/shared/copy";
import {
  accessoryCategoryLabel,
  type AccessoryCategory,
} from "@/lib/shared/color-view";

import { fetchRender, requestAccessoryRender } from "./looks-client";

/**
 * The accessory try on in the top look,
 * docs/09-build-order-and-demo.md Layer 6: "One accessory try on in the top look
 * (earrings or a bag) from the fashion APIs".
 *
 * It is the quietest thing on the card: one text button under the look, and only
 * when the server says a try on would actually produce a picture. The options
 * come from src/lib/server/renders/index.ts (accessoryTryOnOptions), which
 * returns nothing in fixture mode, nothing without a Perfect Corp key, nothing
 * with the kill switch off, nothing when the wardrobe holds no accessory, and
 * nothing for a category whose endpoint is still unverified in endpoints.ts.
 * Today that is every category except the watch, so on the demo profile this
 * component renders nothing at all rather than a button that refuses.
 *
 * Why the person picks the category: the wardrobe records every accessory under
 * one type (src/lib/shared/wardrobe-view.ts), so a photo of a bag and a photo of
 * a pair of earrings are the same row. Nothing on the server can tell which
 * endpoint the photo belongs to, and guessing would put a bag on someone's ears.
 * With one callable category the button starts the try on directly; with more
 * than one it opens a chip row and the person says which.
 *
 * The rest follows the patterns the other try on screens set: the previous
 * picture stays while a new one is in flight, one status line under the image
 * and never over it, no spinner, and every refusal becomes
 * copy.looks.previewUnavailableAccessory. There is no stand in image here.
 */

/** The poll cadence for a running render, the same as the rest of /looks uses. */
const POLL_INTERVAL_MS = 1500;
/** 120 seconds, the point at which docs/03-architecture.md marks a job failed. */
const MAX_POLLS = 80;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

/** One accessory the person owns, offered in one category. */
export type AccessoryOption = {
  readonly garmentId: string;
  readonly category: AccessoryCategory;
};

type AccessorySlotProps = {
  readonly options: readonly AccessoryOption[];
};

export function AccessorySlot({ options }: AccessorySlotProps) {
  const [open, setOpen] = useState(false);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [pendingCategory, setPendingCategory] =
    useState<AccessoryCategory | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const mountedRef = useRef(true);
  /** Bumped by every new request; a stale answer is dropped. */
  const ticketRef = useRef(0);
  const chipsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * The chips replace the button that opened them, so a keyboard person would
   * otherwise be left with focus on an element that no longer exists and would
   * start again from the top of the document. Focus moves to the first choice,
   * which is where their tap was heading (docs/06-safety-privacy.md,
   * "Accessibility as safety": the whole flow works with a keyboard).
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    chipsRef.current?.querySelector("button")?.focus();
  }, [open]);

  const apply = useCallback(async (option: AccessoryOption): Promise<void> => {
    ticketRef.current += 1;
    const ticket = ticketRef.current;
    const current = () => mountedRef.current && ticket === ticketRef.current;

    setPendingCategory(option.category);
    setUnavailable(false);

    const stop = (nothingToShow: boolean): void => {
      setPendingCategory(null);
      setUnavailable(nothingToShow);
    };

    const started = await requestAccessoryRender(option);
    if (!current()) {
      return;
    }
    if (!started.ok) {
      stop(true);
      return;
    }

    const settle = (url: string | null): void => {
      stop(url === null);
      if (url !== null) {
        setRenderUrl(url);
      }
    };

    if (started.render.status === "succeeded") {
      settle(started.render.renderUrl);
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
        settle(polled.render.renderUrl);
        return;
      }
    }

    stop(true);
  }, []);

  // Nothing this session could render. The affordance is not on the card at all.
  const first = options[0];
  if (first === undefined) {
    return null;
  }

  const pending = pendingCategory !== null;
  const statusLine = pending
    ? fill(copy.looks.applyingAccessoryTemplate, {
        accessory: accessoryCategoryLabel(pendingCategory).toLowerCase(),
      })
    : unavailable
      ? copy.looks.previewUnavailableAccessory
      : null;

  /**
   * One callable category is not a choice, so the button starts the try on
   * itself. More than one opens the chips and the person says which.
   */
  function start(): void {
    if (options.length === 1) {
      void apply(first);
      return;
    }
    setOpen(true);
  }

  return (
    <div className="flex flex-col gap-3">
      {renderUrl === null ? null : (
        <div className="aspect-square w-full overflow-hidden bg-surface">
          {/*
            The accessory the person owns, worn on their own capture, from a
            short lived signed URL. Not run through the image optimizer, for the
            same reason as the look hero above it.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={renderUrl}
            // The status line and the rationale already say what this is.
            alt=""
            draggable={false}
            className={`h-full w-full select-none object-cover transition-opacity ${
              pending ? "opacity-70" : "opacity-100"
            }`}
            style={{
              transitionDuration: "var(--duration-crossfade)",
              transitionTimingFunction: "var(--ease-in-out)",
            }}
          />
        </div>
      )}

      {open && options.length > 1 ? (
        <div
          ref={chipsRef}
          role="group"
          aria-label={copy.looks.accessoryCategoriesLabel}
          /*
           * gap-y-3 rather than gap-2, the same as the occasion row above: a
           * chip claims 6px above and below itself as tap area
           * (src/components/ui/Chip.tsx), so 8px between two wrapped rows would
           * let one row answer a tap meant for the other.
           */
          className="flex flex-wrap gap-x-2 gap-y-3"
        >
          {options.map((option) => (
            <Chip
              key={option.category}
              selected={option.category === pendingCategory}
              onSelect={() => {
                void apply(option);
              }}
            >
              {accessoryCategoryLabel(option.category)}
            </Chip>
          ))}
        </div>
      ) : (
        <Button variant="quiet" disabled={pending} onClick={start}>
          {copy.looks.addAccessoryAction}
        </Button>
      )}

      {/* One line under the picture, never over it. */}
      <p aria-live="polite" className="font-body text-small text-text-muted">
        {statusLine ?? ""}
      </p>
    </div>
  );
}
