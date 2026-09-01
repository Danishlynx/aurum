"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Column } from "@/components/layout/Column";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { copy } from "@/lib/shared/copy";
import type { HairView } from "@/lib/shared/hair-view";

import { ColorRow } from "./ColorRow";
import {
  applyingColorLine,
  applyingStyleLine,
  colorByName,
  heroPresentation,
  initialColorName,
  initialStyleId,
  openingRenderUrl,
  styleById,
  styleRenderSeed,
  type HeroSubject,
} from "./hair-content";
import { HairHero } from "./HairHero";
import {
  fetchRender,
  requestHairColorRender,
  requestHairstyleRender,
  saveHairChoice,
} from "./renders-client";
import { StyleRow } from "./StyleRow";

/**
 * I. Hair, docs/01-user-flow.md section I: the enlarged style above a row of 3
 * to 4 styles, a row of hair colors rendered on the selected style, and
 * "Save this".
 *
 * This is the only client component on the screen, because everything here is a
 * tap: choosing a style, choosing a color, saving. The face shape line above it
 * and the view it renders were both built on the server.
 *
 * How a render is asked for:
 *
 * - A style is one hairstyle try on; a color is one hair color try on applied to
 *   the selected style (section I item 3). Choosing a style while a color is
 *   selected asks for the color on the new style, so a tap is always one render,
 *   never two.
 * - A render already on hand is never asked for again: the view arrives with the
 *   renders the server had, and a style rendered here is kept for the rest of
 *   the visit. Anything else answers from the params hash cache on the server
 *   (docs/03-architecture.md, "Caching"), so a style tapped twice costs one
 *   render.
 * - A request is made only when there is a photo to render on. With no photo
 *   (the original was deleted, or there is no key and nothing was ever captured)
 *   nothing is requested and the hero says so. It never shows a stand in face or
 *   another person's render.
 * - While a render is in flight the previous one stays on screen at 70 percent
 *   with the status line under it. No spinner over the face.
 * - Only the newest request can change the screen. An older one that lands late
 *   is dropped, so the hero always matches the selected style and color.
 */

/** The poll cadence for a running render, the same as the makeup screen's. */
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

type HairScreenProps = {
  readonly view: HairView;
  /**
   * True when the app is serving the saved demo profile, which nobody may write
   * to. It decides which sentence a refused save gets, so the screen never tells
   * a person their choice is stored when it is not, and never blames the demo
   * profile for an ordinary failure.
   */
  readonly readOnly: boolean;
};

export function HairScreen({ view, readOnly }: HairScreenProps) {
  const captureImageUrl = view.captureImageUrl;
  const colors = view.colors;
  const styles = view.styles;

  const seed = useMemo(() => styleRenderSeed(styles), [styles]);
  const firstStyleId = useMemo(() => initialStyleId(view), [view]);
  const firstColorName = useMemo(() => initialColorName(view), [view]);
  /** The render the view already carried for the opening choice, if any. */
  const firstRenderUrl = useMemo(
    () =>
      openingRenderUrl({
        styles,
        colors,
        styleId: firstStyleId,
        colorName: firstColorName,
      }),
    [colors, firstColorName, firstStyleId, styles],
  );

  const [styleId, setStyleId] = useState<string | null>(firstStyleId);
  const [colorName, setColorName] = useState<string | null>(firstColorName);
  /** Style id to the style only render on hand for it. */
  const [rendered, setRendered] = useState<Record<string, string>>(seed);
  const [renderUrl, setRenderUrl] = useState<string | null>(firstRenderUrl);
  const [pending, setPending] = useState(false);
  const [pendingLine, setPendingLine] = useState<string | null>(null);
  /*
   * Nothing rendered and no photo to render on is known before the first paint,
   * so the documented line is in the server rendered HTML rather than flashing
   * an empty hero and then saying so.
   */
  const [unavailable, setUnavailable] = useState(
    firstRenderUrl === null && captureImageUrl === null,
  );
  const [subject, setSubject] = useState<HeroSubject>(
    firstColorName === null ? "style" : "color",
  );
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** Bumped by every new request; a stale answer is dropped. */
  const ticketRef = useRef(0);
  const mountedRef = useRef(true);
  /** The same map as rendered, readable inside a request without re running it. */
  const renderedRef = useRef(seed);
  const askedForFirstStyleRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const recordStyleRender = useCallback((id: string, url: string): void => {
    renderedRef.current = { ...renderedRef.current, [id]: url };
    setRendered(renderedRef.current);
  }, []);

  const apply = useCallback(
    async (
      nextStyleId: string | null,
      nextColorName: string | null,
      statusLine: string | null,
    ) => {
      ticketRef.current += 1;
      const ticket = ticketRef.current;
      const current = () => mountedRef.current && ticket === ticketRef.current;

      const color = colorByName(colors, nextColorName);
      setSubject(color === null ? "style" : "color");

      const stop = (nothingToShow: boolean): void => {
        setPending(false);
        setPendingLine(null);
        setUnavailable(nothingToShow);
      };

      // A color has to sit on a style, and with no style there is nothing to
      // render at all.
      if (nextStyleId === null) {
        stop(true);
        return;
      }

      /*
       * A render already on hand for exactly this choice: show it and spend
       * nothing. Only style renders are held this way, because a color render
       * belongs to a style and a color together.
       */
      if (color === null) {
        const held = renderedRef.current[nextStyleId];
        if (held !== undefined) {
          stop(false);
          setRenderUrl(held);
          return;
        }
      }

      // No photo, no try on. Saying so is the documented state; drawing anything
      // else on the hero would be a face we did not render.
      if (captureImageUrl === null) {
        stop(true);
        return;
      }

      setPending(true);
      setPendingLine(statusLine);
      setUnavailable(false);

      const started =
        color === null
          ? await requestHairstyleRender({ styleId: nextStyleId })
          : await requestHairColorRender({
              styleId: nextStyleId,
              colorHex: color.hex,
              colorName: color.name,
            });
      if (!current()) {
        return;
      }
      if (!started.ok) {
        stop(true);
        return;
      }

      const settle = (url: string | null): void => {
        stop(url === null);
        if (url === null) {
          return;
        }
        setRenderUrl(url);
        if (color === null) {
          recordStyleRender(nextStyleId, url);
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
    [captureImageUrl, colors, recordStyleRender],
  );

  /**
   * The style the screen opens on, asked for once (section I item 2 shows the
   * row already rendered). It carries no status line: the doc's line names a
   * choice a person just made, and nobody chose this one. Nothing is asked for
   * when the view already carried the render, so opening the screen twice costs
   * one render at most.
   */
  useEffect(() => {
    if (askedForFirstStyleRef.current) {
      return;
    }
    askedForFirstStyleRef.current = true;
    if (firstStyleId === null || firstRenderUrl !== null) {
      return;
    }
    void apply(firstStyleId, firstColorName, null);
  }, [apply, firstColorName, firstRenderUrl, firstStyleId]);

  function chooseStyle(nextStyleId: string): void {
    const style = styleById(styles, nextStyleId);
    if (style === null) {
      return;
    }
    setStyleId(nextStyleId);
    // The status line names what the person just chose, which is the style, even
    // when a color they chose earlier is still on it.
    void apply(nextStyleId, colorName, applyingStyleLine(style));
  }

  function chooseColor(nextColorName: string): void {
    const color = colorByName(colors, nextColorName);
    if (color === null) {
      return;
    }
    setColorName(nextColorName);
    void apply(styleId, nextColorName, applyingColorLine(color));
  }

  async function saveChoice(): Promise<void> {
    if (saving || styleId === null) {
      return;
    }
    setSaving(true);
    const result = await saveHairChoice({ styleId, colorName });
    if (!mountedRef.current) {
      return;
    }
    setSaving(false);
    if (result === "saved") {
      setToast(copy.hair.savedToast);
      return;
    }
    setToast(
      result === "read_only" && readOnly
        ? copy.hair.saveReadOnly
        : copy.hair.saveFailed,
    );
  }

  const hero = heroPresentation({
    captureImageUrl,
    renderUrl,
    pendingLine,
    pending,
    unavailable,
    subject,
  });

  return (
    <div className="flex flex-col gap-8">
      <Column>
        <HairHero hero={hero} />
      </Column>

      {styles.length === 0 ? null : (
        <Column>
          <StyleRow
            styles={styles}
            rendered={rendered}
            selectedId={styleId}
            onSelect={chooseStyle}
          />
        </Column>
      )}

      <Column>
        <ColorRow
          colors={colors}
          selectedName={colorName}
          onSelect={chooseColor}
        />
      </Column>

      <Column>
        <Button
          variant="primary"
          disabled={saving || styleId === null}
          onClick={() => {
            void saveChoice();
          }}
        >
          {copy.hair.saveAction}
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
