import { describe, expect, it } from "vitest";

import type { ClientJob } from "@/lib/client/api";
import { analysisFailureReasonFor } from "@/lib/shared/analysis-failure";
import { analysisFailureCopy, copy } from "@/lib/shared/copy";

import { coreSetSucceeded, revealStateFor, statusKeyFor } from "./reveal";

/**
 * The reveal, docs/01-user-flow.md section E. Every assertion here is about job
 * completion driving the screen: no test needs a clock, because the screen never
 * reads one.
 */

let nextId = 0;

function job(
  kind: ClientJob["kind"],
  status: ClientJob["status"],
): ClientJob {
  nextId += 1;
  return { id: `job-${nextId}`, kind, status };
}

const ALL_KINDS = [
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
  "hair_type",
] as const;

function allWith(status: ClientJob["status"]): ClientJob[] {
  return ALL_KINDS.map((kind) => job(kind, status));
}

/**
 * A job the engine refused, carrying the sentence the server writes for that
 * provider code. The mapping is the shared one the jobs layer calls
 * (messageForTaskFailure), so what these tests drive through the reveal is the
 * real string a live refusal produces, not a stand in.
 */
function refused(kind: ClientJob["kind"], providerCode: string): ClientJob {
  const failed = job(kind, "failed");
  return {
    ...failed,
    error: analysisFailureCopy(analysisFailureReasonFor(providerCode)),
  };
}

/** The three codes the live API sent on 2026-09-02. */
const FACE_ANGLE_CODE = "error_face_angle_rightward";
const NOT_FORWARD_CODE = "error_face_not_forward_facing";
const NO_FACE_CODE = "error_no_face";

describe("statusKeyFor", () => {
  it("starts on the skin line before any job exists", () => {
    expect(statusKeyFor([])).toBe("readingSkin");
  });

  it("holds the skin line while the skin job runs", () => {
    expect(statusKeyFor(allWith("running"))).toBe("readingSkin");
  });

  it("moves to the tone line once skin is done", () => {
    const jobs = [
      job("skin", "succeeded"),
      job("fitzpatrick", "running"),
      job("attributes", "running"),
      job("face_shape", "running"),
    ];
    expect(statusKeyFor(jobs)).toBe("readingTone");
  });

  it("moves on when a step failed rather than waiting for it", () => {
    const jobs = [
      job("skin", "failed"),
      job("fitzpatrick", "failed"),
      job("attributes", "failed"),
      job("face_shape", "running"),
    ];
    expect(statusKeyFor(jobs)).toBe("readingFaceShapeAndHair");
  });

  it("ends on the profile line when every job is terminal", () => {
    expect(statusKeyFor(allWith("succeeded"))).toBe("buildingProfile");
  });

  it("ignores a kind it does not know", () => {
    expect(statusKeyFor([job(null, "running")])).toBe("buildingProfile");
  });
});

describe("coreSetSucceeded", () => {
  it("is true for skin plus Fitzpatrick", () => {
    expect(
      coreSetSucceeded([
        job("skin", "succeeded"),
        job("fitzpatrick", "succeeded"),
        job("attributes", "failed"),
      ]),
    ).toBe(true);
  });

  it("is true for skin plus attributes", () => {
    expect(
      coreSetSucceeded([
        job("skin", "succeeded"),
        job("fitzpatrick", "failed"),
        job("attributes", "succeeded"),
      ]),
    ).toBe(true);
  });

  it("is false without the skin analysis", () => {
    expect(
      coreSetSucceeded([
        job("skin", "failed"),
        job("fitzpatrick", "succeeded"),
      ]),
    ).toBe(false);
  });

  it("is false while the core jobs are still running", () => {
    expect(coreSetSucceeded(allWith("running"))).toBe(false);
  });
});

describe("revealStateFor", () => {
  it("blooms the masks only after the skin analysis succeeds", () => {
    expect(revealStateFor([job("skin", "running")]).masksBloom).toBe(false);
    expect(revealStateFor([job("skin", "succeeded")]).masksBloom).toBe(true);
  });

  it("skips the mask step for a failed skin analysis and still advances", () => {
    const jobs = [job("skin", "failed"), job("attributes", "succeeded")];
    const state = revealStateFor(jobs);
    expect(state.masksBloom).toBe(false);
    expect(state.status).toBe("buildingProfile");
  });

  it("is not settled while one job is still running", () => {
    const jobs = [job("skin", "succeeded"), job("hair_type", "running")];
    expect(revealStateFor(jobs).settled).toBe(false);
  });

  it("is settled when every job is terminal, failures included", () => {
    const jobs = [job("skin", "succeeded"), job("hair_type", "failed")];
    expect(revealStateFor(jobs).settled).toBe(true);
  });

  it("is never settled on an empty set, so an empty poll cannot end the reveal", () => {
    expect(revealStateFor([]).settled).toBe(false);
  });

  it("reports the core set separately from being settled", () => {
    const jobs = [
      job("skin", "succeeded"),
      job("fitzpatrick", "succeeded"),
      job("attributes", "failed"),
      job("face_shape", "failed"),
      job("hair_type", "failed"),
    ];
    const state = revealStateFor(jobs);
    expect(state.settled).toBe(true);
    expect(state.coreSucceeded).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The lifecycle a live capture really produces                        */
/* ------------------------------------------------------------------ */

/**
 * Three runs, each one a shape the provider is known to produce. The point of
 * this block is that nothing about the reveal is asserted from a hand written
 * error string: every failed job carries the sentence the server writes for a
 * code that was read off the wire.
 */
describe("the reveal through a live capture", () => {
  it("run one: every kind succeeds, so the reveal ends on the report", () => {
    /*
     * hair_type is the exception this build always fails, because detection
     * takes three photos and the capture flow has one. It is failed before any
     * provider call and it must not hold the reveal or stop the routing.
     */
    const jobs = [
      job("skin", "succeeded"),
      job("fitzpatrick", "succeeded"),
      job("attributes", "succeeded"),
      job("face_shape", "succeeded"),
      job("hair_type", "succeeded"),
    ];
    const state = revealStateFor(jobs);
    expect(state).toEqual({
      status: "buildingProfile",
      masksBloom: true,
      settled: true,
      coreSucceeded: true,
      problem: null,
    });
  });

  it("run two: the tone reading is refused for a turned head, and the report still comes", () => {
    /*
     * The failure the live run found. facialColorTones checks the face angle
     * strictly and refuses a head turned a few degrees; the skin analyzer takes
     * the same frame. docs/01 section E: the step is skipped, and docs/01
     * section F renders the report with the tone line missing.
     */
    const jobs = [
      job("skin", "succeeded"),
      refused("attributes", FACE_ANGLE_CODE),
      job("fitzpatrick", "succeeded"),
      job("face_shape", "succeeded"),
      refused("hair_type", NOT_FORWARD_CODE),
    ];
    const state = revealStateFor(jobs);

    expect(state.settled).toBe(true);
    expect(state.masksBloom).toBe(true);
    // Fitzpatrick carried the core set, so the reveal routes.
    expect(state.coreSucceeded).toBe(true);
    expect(state.problem).toBeNull();
    expect(state.status).toBe("buildingProfile");
  });

  it("run two, without Fitzpatrick: the refused tone reading is what the person is told", () => {
    const jobs = [
      job("skin", "succeeded"),
      refused("attributes", FACE_ANGLE_CODE),
      refused("fitzpatrick", NOT_FORWARD_CODE),
    ];
    const state = revealStateFor(jobs);

    expect(state.coreSucceeded).toBe(false);
    expect(state.problem).toBe(copy.capture.facingAway);
    // Not the timeout line the screen used to show for every dead end.
    expect(state.problem).not.toBe(copy.errors.providerTimeout);
  });

  it("run three: the skin analysis is refused, so the core set is short", () => {
    /*
     * docs/03-architecture.md step 6 makes the skin analysis part of the core
     * set, so there is no profile to route to: no concerns, no masks, no
     * ranking. The person is told the frame had no face in it and is sent back
     * to the camera, which is the only thing that fixes it.
     */
    const jobs = [
      refused("skin", NO_FACE_CODE),
      refused("attributes", NO_FACE_CODE),
      refused("fitzpatrick", NO_FACE_CODE),
      refused("face_shape", NO_FACE_CODE),
      refused("hair_type", NO_FACE_CODE),
    ];
    const state = revealStateFor(jobs);

    expect(state.settled).toBe(true);
    expect(state.masksBloom).toBe(false);
    expect(state.coreSucceeded).toBe(false);
    expect(state.problem).toBe(copy.capture.rejection.no_face);
  });

  it("prefers the skin failure when more than one core kind was refused", () => {
    const jobs = [
      refused("skin", NO_FACE_CODE),
      refused("attributes", FACE_ANGLE_CODE),
    ];
    expect(revealStateFor(jobs).problem).toBe(copy.capture.rejection.no_face);
  });

  it("holds the problem back while the other core kind can still land", () => {
    const jobs = [
      job("skin", "succeeded"),
      refused("attributes", FACE_ANGLE_CODE),
      job("fitzpatrick", "running"),
    ];
    const state = revealStateFor(jobs);
    // The screen only reads problem once settled, and this set is not.
    expect(state.settled).toBe(false);
    expect(state.problem).toBe(copy.capture.facingAway);
  });

  it("says nothing of its own when a core job failed without a reason", () => {
    // The screen falls back to the timeout line, which is what a job that died
    // silently looks like from the client.
    const jobs = [job("skin", "failed"), job("attributes", "failed")];
    expect(revealStateFor(jobs).problem).toBeNull();
  });

  it("ignores an empty error string rather than showing a blank line", () => {
    const jobs = [{ ...job("skin", "failed"), error: "   " }];
    expect(revealStateFor(jobs).problem).toBeNull();
  });
});
