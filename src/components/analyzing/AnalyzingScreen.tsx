"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { RevealMask } from "@/components/analyzing/RevealMask";
import { revealStateFor, type StatusKey } from "@/components/analyzing/reveal";
import { Column } from "@/components/layout/Column";
import { ButtonLink } from "@/components/ui/Button";
import { fetchJobs } from "@/lib/client/api";
import {
  forgetCapturePreview,
  readCapturePreview,
} from "@/lib/client/capture-handoff";
import {
  canReframeCapture,
  forgetCaptureSource,
  resubmitReframedCapture,
} from "@/lib/client/capture-source";
import { copy } from "@/lib/shared/copy";

/**
 * E. Analyzing, docs/01-user-flow.md section E.
 *
 * The selfie fills the screen, darkened at the edges by a single radial
 * vignette, which is the one gradient the design system allows. As the skin
 * analysis returns, its mask blooms over the face in translucent Leaf gold and
 * settles. Below it, one line of status.
 *
 * Every step is driven by job completion, never by a timer: the poll is the only
 * clock, the status line for a set of jobs is a pure function of that set
 * (src/components/analyzing/reveal.ts), and a failed job has its step skipped
 * rather than waited for.
 *
 * The screen leaves for /report when every job for the capture is terminal and
 * the core set succeeded. It waits for the stragglers on purpose: this poll is
 * what advances the provider tasks, so leaving the moment the core set lands
 * would strand the face shape and hair type results that Layer 3 reads.
 *
 * That wait is bounded. Once the core set has succeeded there is a profile to
 * show, and a non core job that never reaches a terminal status would otherwise
 * hold a finished reading behind a screen with no way off it. So the stragglers
 * get STRAGGLER_POLLS_AFTER_CORE more polls to land and then the reveal routes
 * without them, which is the same outcome docs/01 section E gives a job that
 * fails: the step is skipped and the report says what is missing.
 *
 * One thing happens before a refusal is shown: a capture every core reading of
 * which was refused over its framing is sent back cropped tighter, up to twice,
 * and this screen follows it. See the poll below. It costs nothing (a refused
 * task is charged nothing) and it is the difference between a person being told
 * their photo was no good and a person getting their reading.
 *
 * The status line still says what is running now and nothing else. Since the
 * tone reading now goes first and the rest follow it
 * (src/lib/shared/fan-out.ts), a run that used to open on "Reading your skin"
 * can open on "Reading your tone". Both are true when they show, which is the
 * rule docs/01 section E actually sets: the sequence is driven by job
 * completion, and nothing here fakes progress.
 */

const POLL_INTERVAL_MS = 1500;
/** After this many polls in a row that never reached the server, stop and say so. */
const FAILURES_BEFORE_GIVING_UP = 3;
/**
 * 20 polls, 30 seconds, counted only from the poll the core set succeeded on.
 * Long enough that a slow face shape or hair type reading lands inside it on
 * every run recorded so far, short enough that a stuck one is not the person's
 * problem.
 */
const STRAGGLER_POLLS_AFTER_CORE = 20;

export function AnalyzingScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const captureId = searchParams.get("capture");

  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusKey>("readingSkin");
  const [masksBloom, setMasksBloom] = useState(false);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failuresRef = useRef(0);
  const finishedRef = useRef(false);
  /** Polls seen since the core set succeeded. Zero until it does. */
  const stragglerPollsRef = useRef(0);

  useEffect(() => {
    if (captureId === null) {
      router.replace("/capture");
      return;
    }
    /*
     * A new capture id on the same screen is the self healing retry below: the
     * reframed photo was accepted and this screen is now watching its readings.
     * Everything counted per capture starts again, or the poll would still be
     * finished and the refusal of the last attempt would still be on screen.
     */
    finishedRef.current = false;
    failuresRef.current = 0;
    stragglerPollsRef.current = 0;
    setProblem(null);
    setPreview(readCapturePreview(captureId));
  }, [captureId, router]);

  const poll = useCallback(async () => {
    if (captureId === null || finishedRef.current) {
      return;
    }
    const result = await fetchJobs(captureId);

    if (!result.ok) {
      if (result.kind === "unauthorized" || result.kind === "forbidden") {
        finishedRef.current = true;
        router.replace("/welcome");
        return;
      }
      failuresRef.current += 1;
      if (failuresRef.current >= FAILURES_BEFORE_GIVING_UP) {
        finishedRef.current = true;
        setProblem(copy.errors.requestFailed);
      }
      return;
    }

    failuresRef.current = 0;
    const jobs = result.data.jobs;
    const state = revealStateFor(jobs);
    setStatus(state.status);
    // Once a mask has bloomed it stays: the analysis behind it does not un happen.
    setMasksBloom((bloomed) => bloomed || state.masksBloom);
    /*
     * The first signed URL wins. Every poll signs the same object again, and
     * taking the new one would re fetch the image and blink the bloom every 1.5
     * seconds. The window is ten minutes, which outlasts this screen.
     */
    const signed = result.data.maskUrl ?? null;
    if (signed !== null) {
      setMaskUrl((current) => current ?? signed);
    }

    if (state.coreSucceeded) {
      stragglerPollsRef.current += 1;
    }
    const complete = result.data.complete ?? state.settled;
    const waitedLongEnough =
      state.coreSucceeded &&
      stragglerPollsRef.current > STRAGGLER_POLLS_AFTER_CORE;
    if (!complete && !waitedLongEnough) {
      return;
    }

    finishedRef.current = true;
    if (state.coreSucceeded) {
      forgetCapturePreview();
      forgetCaptureSource();
      router.replace("/report");
      return;
    }

    /*
     * The reading stopped, and every core reading of it was refused for
     * something a tighter crop of the same photo could fix: a face too small in
     * the picture, or a face the engine could not find. That is the framing
     * failure the founder's phone hit twice on 2026-09-03, and it is not the
     * person's fault: the browser has no face detector, so the frame we composed
     * around their face was composed around lit skin.
     *
     * A refused task is charged nothing, so trying again is free. The photo is
     * still in memory (src/lib/client/capture-source.ts), so it goes back
     * cropped tighter and this screen follows the new capture, without the
     * person being shown a refusal for a photo that has not run out of chances.
     * One status line is all they see.
     *
     * Everything else falls straight through to the refusal below, and so does
     * the last attempt.
     */
    if (state.reframeable && canReframeCapture(captureId)) {
      setStatus("reframing");
      const outcome = await resubmitReframedCapture(captureId);
      if (outcome.ok) {
        router.replace(
          `/analyzing?capture=${encodeURIComponent(outcome.captureId)}`,
        );
        return;
      }
    }

    /*
     * The reading stopped. The server already turned the provider's refusal into
     * a sentence that says what to do about it (a turned head, a frame with no
     * face), so that sentence is what shows. The timeout line is the fallback
     * for a core job that failed without saying why, which is what a timeout
     * looks like from here.
     */
    forgetCaptureSource();
    setProblem(state.problem ?? copy.errors.providerTimeout);
  }, [captureId, router]);

  useEffect(() => {
    if (captureId === null) {
      return;
    }
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [captureId, poll]);

  return (
    <main className="flex min-h-[100svh] flex-col items-center bg-canvas">
      {/*
        docs/02-design-system.md, Layout: the same 480px column /capture composes
        into, so the frame a person framed in the oval is the frame that fills
        this screen. It matters twice over here: on a wide window the selfie used
        to be blown up and cropped to a strip, and the mask that blooms over it
        is aligned to the picture, so the picture has to keep its shape.
      */}
      <div className="relative flex w-full max-w-[var(--column-max)] flex-1 flex-col justify-end overflow-hidden bg-surface">
        {preview !== null ? (
          // The person's own frame. Every word that describes it is on the
          // screen already, so an alt text would only repeat the status line.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        {masksBloom ? <RevealMask maskUrl={maskUrl} /> : null}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 42%, transparent 30%, var(--canvas) 100%)",
          }}
        />
        <div className="relative pb-12 pt-8">
          <Column className="flex flex-col gap-6">
            <p aria-live="polite" className="font-body text-body text-text">
              {problem ?? copy.analyzing[status]}
            </p>
            {problem !== null ? (
              /*
               * Primary, because a stopped reveal has exactly one thing to do
               * and this is it: docs/02-design-system.md allows one gold fill
               * per screen, and on this screen nothing else is competing for
               * it. Going to /capture remounts the camera screen, which asks
               * for the camera again from scratch.
               */
              <ButtonLink variant="primary" href="/capture">
                {copy.report.retakePhotoAction}
              </ButtonLink>
            ) : null}
          </Column>
        </div>
      </div>
    </main>
  );
}
