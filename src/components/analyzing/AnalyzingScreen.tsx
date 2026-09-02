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
 * what advances the provider tasks, so leaving as soon as the core set lands
 * would strand the face shape and hair type results that Layer 3 reads.
 */

const POLL_INTERVAL_MS = 1500;
/** After this many polls in a row that never reached the server, stop and say so. */
const FAILURES_BEFORE_GIVING_UP = 3;

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

  useEffect(() => {
    if (captureId === null) {
      router.replace("/capture");
      return;
    }
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

    const complete = result.data.complete ?? state.settled;
    if (!complete) {
      return;
    }

    finishedRef.current = true;
    if (state.coreSucceeded) {
      forgetCapturePreview();
      router.replace("/report");
      return;
    }
    /*
     * The reading stopped. The server already turned the provider's refusal into
     * a sentence that says what to do about it (a turned head, a frame with no
     * face), so that sentence is what shows. The timeout line is the fallback
     * for a core job that failed without saying why, which is what a timeout
     * looks like from here.
     */
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
              <ButtonLink variant="secondary" href="/capture">
                {copy.report.retakePhotoAction}
              </ButtonLink>
            ) : null}
          </Column>
        </div>
      </div>
    </main>
  );
}
