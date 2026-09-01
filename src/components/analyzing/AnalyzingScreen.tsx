"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Column } from "@/components/layout/Column";
import { ButtonLink } from "@/components/ui/Button";
import { fetchJobs } from "@/lib/client/api";
import type { ClientJob } from "@/lib/client/api";
import {
  forgetCapturePreview,
  readCapturePreview,
} from "@/lib/client/capture-handoff";
import { copy } from "@/lib/shared/copy";
import { TERMINAL_JOB_STATUSES } from "@/lib/shared/schemas";

/**
 * E. Analyzing, docs/01-user-flow.md section E.
 *
 * The selfie fills the screen, darkened at the edges by a single radial
 * vignette, which is the one gradient the design system allows. Below it, one
 * line of status.
 *
 * The steps are driven by job completion, never by timers: if a job is slow the
 * status line stays and nothing fakes progress. The masks that bloom over the
 * face belong to Layer 1, together with the mask data they draw; until then the
 * status lines advance on their own, which is what reduced motion sees anyway.
 */

const POLL_INTERVAL_MS = 1500;
/** After this many polls in a row that never reached the server, stop and say so. */
const FAILURES_BEFORE_GIVING_UP = 3;

type StatusKey = keyof typeof copy.analyzing;

function isTerminal(job: ClientJob): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status);
}

/**
 * The status line for a set of jobs, in the sequence docs/01 section E gives.
 * A kind with no job is nothing to wait for, so it does not hold the line.
 */
export function statusKeyFor(jobs: readonly ClientJob[]): StatusKey {
  const waitingOn = (kinds: readonly string[]): boolean =>
    jobs.some(
      (job) => job.kind !== null && kinds.includes(job.kind) && !isTerminal(job),
    );

  if (jobs.length === 0 || waitingOn(["skin"])) {
    return "readingSkin";
  }
  if (waitingOn(["fitzpatrick", "attributes"])) {
    return "readingTone";
  }
  if (waitingOn(["face_shape", "hair_type"])) {
    return "readingFaceShapeAndHair";
  }
  return "buildingProfile";
}

/**
 * docs/03-architecture.md step 6: the profile is built when the core set is
 * complete, which is skin plus at least one of Fitzpatrick or attributes.
 */
export function coreSetSucceeded(jobs: readonly ClientJob[]): boolean {
  const succeeded = (kind: string): boolean =>
    jobs.some((job) => job.kind === kind && job.status === "succeeded");
  return succeeded("skin") && (succeeded("fitzpatrick") || succeeded("attributes"));
}

export function AnalyzingScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const captureId = searchParams.get("capture");

  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusKey>("readingSkin");
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
    setStatus(statusKeyFor(jobs));

    const complete =
      result.data.complete ?? (jobs.length > 0 && jobs.every(isTerminal));
    if (!complete) {
      return;
    }

    finishedRef.current = true;
    if (coreSetSucceeded(jobs)) {
      forgetCapturePreview();
      router.replace("/report");
      return;
    }
    setProblem(copy.errors.providerTimeout);
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
    <main className="relative flex min-h-[100svh] flex-col justify-end overflow-hidden bg-surface">
      {preview !== null ? (
        // The person's own frame. Every word that describes it is on the screen
        // already, so an alt text would only repeat the status line.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
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
    </main>
  );
}
