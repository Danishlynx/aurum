"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { copy, fill } from "@/lib/shared/copy";
import { concernDisplayName, isConcernKey } from "@/lib/shared/concerns";

import { fetchRender, requestSimulationRender } from "./projection-client";

/**
 * The projection row on /report, docs/09-build-order-and-demo.md Layer 6: "Skin
 * simulation for a projected improvement render on the report ('projected',
 * labeled)".
 *
 * It sits after the routine, quiet, and it is the last thing on the screen
 * before the footer, because it is the one picture on the report that is not the
 * person's skin as it is today.
 *
 * The label is required, not decorative: docs/06-safety-privacy.md says "Try on
 * renders are labeled as previews. Skin simulation is labeled as a projection."
 * So the heading is "Projected", the line under it says what the picture is and
 * what it is not, and no wording anywhere here says a product or a routine will
 * do anything.
 *
 * Three states, and no fourth:
 * - a projection exists: the picture, the label, the framing, the concerns
 * - none exists and one could be asked for: the label, the framing, one quiet
 *   button, and the pending or unavailable line after it is tapped
 * - none exists and none could be asked for: nothing. The row is not rendered at
 *   all, so the demo never shows a button that cannot do anything
 *
 * Which of the three it is, is decided on the server
 * (src/lib/server/renders/index.ts, readProjection). This component never
 * guesses at a key, and it never draws a stand in image: with no render there is
 * no picture here, the same rule /makeup, /hair, and /looks follow.
 */

/** The poll cadence for a running render, the same as the other screens use. */
const POLL_INTERVAL_MS = 1500;
/** 120 seconds, the point at which docs/03-architecture.md marks a job failed. */
const MAX_POLLS = 80;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

/** "dark spots and texture", the concerns the projection covers. */
function concernsSentence(concerns: readonly string[]): string | null {
  const names = concerns
    .filter((key) => isConcernKey(key))
    .map((key) => concernDisplayName(key).toLowerCase());
  if (names.length === 0) {
    return null;
  }
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return fill(copy.report.projectionConcernsTemplate, { concerns: listed });
}

type ProjectionRowProps = {
  /** A projection already stored for this face, signed for this request. */
  readonly renderUrl: string | null;
  /** True when asking for one would actually produce a picture. */
  readonly canRender: boolean;
  /** The concerns it covers, in the report's own ranking. */
  readonly concerns: readonly string[];
};

export function ProjectionRow({
  renderUrl,
  canRender,
  concerns,
}: ProjectionRowProps) {
  const [url, setUrl] = useState<string | null>(renderUrl);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const show = useCallback(async (): Promise<void> => {
    if (pending) {
      return;
    }
    setPending(true);
    setUnavailable(false);

    const stop = (nothingToShow: boolean): void => {
      setPending(false);
      setUnavailable(nothingToShow);
    };

    const started = await requestSimulationRender(concerns);
    if (!mountedRef.current) {
      return;
    }
    if (!started.ok) {
      stop(true);
      return;
    }
    if (started.render.status === "succeeded") {
      setUrl(started.render.renderUrl);
      stop(started.render.renderUrl === null);
      return;
    }

    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      await delay(POLL_INTERVAL_MS);
      if (!mountedRef.current) {
        return;
      }
      const polled = await fetchRender(started.render.renderId);
      if (!mountedRef.current) {
        return;
      }
      if (!polled.ok || polled.render.status === "failed") {
        break;
      }
      if (polled.render.status === "succeeded") {
        setUrl(polled.render.renderUrl);
        stop(polled.render.renderUrl === null);
        return;
      }
    }

    stop(true);
  }, [concerns, pending]);

  // Nothing stored and nothing that could be asked for. The row is not part of
  // the screen at all, rather than a control that refuses when it is tapped.
  if (url === null && !canRender) {
    return null;
  }

  const concernsLine = concernsSentence(concerns);

  return (
    <section
      aria-labelledby="projection-heading"
      className="flex flex-col gap-3 border-t border-raised pt-6"
    >
      <h2
        id="projection-heading"
        className="font-body text-small font-medium text-text"
      >
        {copy.report.projectionHeading}
      </h2>

      {url === null ? null : (
        <div className="aspect-square w-full overflow-hidden bg-surface">
          {/*
            The person's own face, projected, from a short lived signed URL. Not
            run through the image optimizer, for the same reason as the report
            hero: a URL that expires is not something to cache at the edge.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            // The heading and the framing line below say what this is.
            alt=""
            draggable={false}
            className="h-full w-full select-none object-cover"
          />
        </div>
      )}

      <p className="max-w-[70ch] font-body text-small text-text-muted">
        {copy.report.projectionFraming}
      </p>

      {concernsLine === null ? null : (
        <p className="max-w-[70ch] font-body text-small text-text-muted">
          {concernsLine}
        </p>
      )}

      {url === null && canRender ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            variant="quiet"
            disabled={pending}
            onClick={() => {
              void show();
            }}
          >
            {copy.report.projectionAction}
          </Button>
          {/*
            One line under the control, never over the face. The region is live
            so a projection finishing is announced without moving focus.
          */}
          <p aria-live="polite" className="font-body text-small text-text-muted">
            {pending
              ? copy.report.projectionPending
              : unavailable
                ? copy.report.projectionUnavailable
                : ""}
          </p>
        </div>
      ) : null}
    </section>
  );
}
