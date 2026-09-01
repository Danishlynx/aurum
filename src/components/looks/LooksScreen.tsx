"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Column } from "@/components/layout/Column";
import { buttonClassName } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { copy } from "@/lib/shared/copy";
import {
  DEFAULT_OCCASION,
  type LooksView,
  type LookView,
  type Occasion,
} from "@/lib/shared/looks-view";

import { AccessorySlot, type AccessoryOption } from "./AccessorySlot";
import { LookCard } from "./LookCard";
import {
  applyingLine,
  heroPresentation,
  type LookHero,
} from "./looks-content";
import {
  fetchLooks,
  fetchRender,
  requestClothRender,
  saveLook,
} from "./looks-client";
import { LooksBodySkeleton } from "./LooksSkeleton";
import { OccasionRow } from "./OccasionRow";

/**
 * K. Looks, docs/01-user-flow.md section K: the occasion chips, two to three
 * composed looks with their rationales, the cloth try on of the hero garment on
 * the top look, "Shop the gap", and the two controls at the bottom.
 *
 * This is the only client component on the screen, because everything here is a
 * tap: choosing an occasion, saving a look, going back to the chips.
 *
 * Why the view is fetched here rather than rendered on the server, which is what
 * /report, /color, /makeup, and /hair all do: a look belongs to an occasion, and
 * the occasion is a chip the person taps. The screen would fetch a new view on
 * the first tap either way, so it fetches every one of them the same way, from
 * the one route the Layer 4 contract names. The session check and the redirect
 * still happen on the server, in page.tsx.
 *
 * The cloth try on, docs/01 section K item 2 and its pending state ("the flat
 * lay shows first; the rendered hero arrives when the job completes"):
 *
 * - Only the top look is rendered. docs/04-integrations.md records that cloth
 *   try on takes one garment_category per call, so a whole outfit would be one
 *   call per garment; docs/09-build-order-and-demo.md names rendering the hero
 *   garment alone as the answer to that, with the rest shown as a flat lay.
 * - A garment already rendered during this visit is never rendered again, and
 *   the same parameters answer from the params hash cache on the server
 *   (docs/03-architecture.md, "Caching"), so tapping back to an occasion costs
 *   nothing.
 * - While a render is in flight the previous one stays on screen at 70 percent
 *   with the status line under it. No spinner over the image.
 * - Only the newest request can change the screen. An older one that lands late
 *   is dropped, so the render always belongs to the look on screen.
 * - Every refusal (no key, a cap, the kill switch, fixture mode) becomes
 *   "Preview unavailable for this garment." No substitute image is ever shown.
 *
 * Fixture mode: the checked in looks render in full and every write answers 403,
 * which becomes the read only line rather than a claim that something was saved.
 */

/** The poll cadence for a running render, the same as /makeup and /hair use. */
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

const NO_HERO: LookHero = {
  imageUrl: null,
  dimmed: false,
  statusLine: null,
  unavailableLine: null,
  visible: false,
};

type LooksScreenProps = {
  /**
   * True when the app is serving the saved demo profile, which nobody may write
   * to. It decides which sentence a refused save gets, so the screen never
   * blames the demo profile for an ordinary failure and never tells a person a
   * look was saved when it was not.
   */
  readonly readOnly: boolean;
  /**
   * The accessory try ons this session could actually produce, resolved on the
   * server (docs/09-build-order-and-demo.md Layer 6). Empty in fixture mode,
   * without a key, with the kill switch off, with no accessory in the wardrobe,
   * and for every category whose endpoint is still unverified, which draws no
   * affordance at all.
   */
  readonly accessoryOptions?: readonly AccessoryOption[];
};

export function LooksScreen({
  readOnly,
  accessoryOptions = [],
}: LooksScreenProps) {
  const [occasion, setOccasion] = useState<Occasion>(DEFAULT_OCCASION);
  const [view, setView] = useState<LooksView | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  /** Garment id to the cloth render on hand for it, for this visit. */
  const [renders, setRenders] = useState<Record<string, string>>({});
  const [renderPending, setRenderPending] = useState(false);
  const [renderUnavailable, setRenderUnavailable] = useState(false);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const mountedRef = useRef(true);
  /** Bumped by every new request; a stale answer is dropped. */
  const viewTicketRef = useRef(0);
  const renderTicketRef = useRef(0);
  /** The same map as renders, readable inside a request without re running it. */
  const rendersRef = useRef<Record<string, string>>({});
  const occasionRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const recordRender = useCallback((garmentId: string, url: string): void => {
    rendersRef.current = { ...rendersRef.current, [garmentId]: url };
    setRenders(rendersRef.current);
  }, []);

  /**
   * The cloth try on for the top look's hero garment. Nothing is asked for when
   * the look has no hero, when a render for that garment is already on hand, or
   * when the view arrived with one.
   */
  const applyClothRender = useCallback(
    async (looksView: LooksView): Promise<void> => {
      renderTicketRef.current += 1;
      const ticket = renderTicketRef.current;
      const current = () =>
        mountedRef.current && ticket === renderTicketRef.current;

      const top = looksView.looks[0];
      const heroGarmentId = top?.heroGarmentId ?? null;

      setRenderPending(false);
      setRenderUnavailable(false);

      if (top === undefined || heroGarmentId === null) {
        return;
      }
      if (rendersRef.current[heroGarmentId] !== undefined) {
        return;
      }
      if (top.renderUrl !== null) {
        recordRender(heroGarmentId, top.renderUrl);
        return;
      }
      if (top.renderStatus === "failed") {
        setRenderUnavailable(true);
        return;
      }

      setRenderPending(true);

      const stop = (nothingToShow: boolean): void => {
        setRenderPending(false);
        setRenderUnavailable(nothingToShow);
      };

      const started = await requestClothRender(heroGarmentId);
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
          recordRender(heroGarmentId, url);
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
    },
    [recordRender],
  );

  const load = useCallback(
    async (next: Occasion): Promise<void> => {
      viewTicketRef.current += 1;
      const ticket = viewTicketRef.current;

      setLoading(true);
      setUnavailable(false);

      const result = await fetchLooks(next);
      if (!mountedRef.current || ticket !== viewTicketRef.current) {
        return;
      }

      setLoading(false);
      if (!result.ok) {
        setView(null);
        setUnavailable(true);
        return;
      }
      setView(result.view);
      void applyClothRender(result.view);
    },
    [applyClothRender],
  );

  useEffect(() => {
    void load(occasion);
  }, [load, occasion]);

  function chooseOccasion(next: Occasion): void {
    if (next === occasion) {
      return;
    }
    setOccasion(next);
  }

  async function save(lookId: string): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    const result = await saveLook(lookId);
    if (!mountedRef.current) {
      return;
    }
    setSaving(false);
    if (result === "saved") {
      setToast(copy.looks.savedToast);
      return;
    }
    setToast(
      result === "read_only" && readOnly
        ? copy.looks.saveReadOnly
        : copy.looks.saveFailed,
    );
  }

  /**
   * "Try another occasion", docs/01 section K item 4. Quiet, because the chips
   * are already on the screen and this is the way back up to them from the
   * bottom of a long one. Focus moves with the scroll so a keyboard person lands
   * on the row rather than watching it go past.
   */
  function tryAnotherOccasion(): void {
    const row = occasionRowRef.current;
    if (row === null) {
      return;
    }
    row.scrollIntoView({ block: "start" });
    row.focus({ preventScroll: true });
  }

  function heroFor(look: LookView, index: number): LookHero {
    // Only the top look carries a try on (docs/01 section K item 2).
    if (index !== 0) {
      return NO_HERO;
    }
    const heroGarmentId = look.heroGarmentId;
    const held =
      heroGarmentId === null ? undefined : renders[heroGarmentId];
    return heroPresentation({
      renderUrl: held ?? look.renderUrl,
      pending: renderPending,
      pendingLine: applyingLine(look),
      unavailable: renderUnavailable,
    });
  }

  const looks = view?.looks ?? [];

  return (
    <div className="flex flex-col gap-8">
      <Column>
        <OccasionRow
          ref={occasionRowRef}
          selected={occasion}
          onSelect={chooseOccasion}
        />
      </Column>

      {view !== null && view.wardrobeEmpty ? (
        <Column>
          {/* docs/01-user-flow.md section K, "No wardrobe", verbatim. */}
          <p className="max-w-[64ch] font-body text-body text-text-muted">
            {copy.looks.noWardrobe}
          </p>
        </Column>
      ) : null}

      {loading ? <LooksBodySkeleton /> : null}

      {!loading && unavailable ? (
        <Column>
          <p role="status" className="max-w-[64ch] font-body text-body text-text">
            {copy.looks.unavailable}
          </p>
        </Column>
      ) : null}

      {!loading && !unavailable && looks.length === 0 ? (
        <Column>
          <p className="max-w-[64ch] font-body text-body text-text">
            {copy.looks.noLooksForOccasion}
          </p>
        </Column>
      ) : null}

      {looks.map((look, index) => (
        <Column key={look.id}>
          <LookCard
            look={look}
            hero={heroFor(look, index)}
            leading={index === 0}
            saving={saving}
            onSave={(lookId) => {
              void save(lookId);
            }}
            /*
             * The top look only, docs/09-build-order-and-demo.md Layer 6: "One
             * accessory try on in the top look". With no options the slot
             * renders nothing, so the card is unchanged.
             */
            accessory={
              index === 0 && accessoryOptions.length > 0 ? (
                <AccessorySlot options={accessoryOptions} />
              ) : null
            }
          />
        </Column>
      ))}

      <Column className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={tryAnotherOccasion}
          className={buttonClassName("quiet")}
        >
          {copy.looks.tryAnotherOccasionAction}
        </button>
        {/*
          docs/01-user-flow.md "Screen map": "Wardrobe is reached from Looks."
          This is that route, quiet, because the looks are the screen.
        */}
        <Link href="/wardrobe" className={buttonClassName("quiet")}>
          {copy.nav.wardrobe}
        </Link>
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
