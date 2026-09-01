import { describe, expect, it } from "vitest";

import type { ClientJob } from "@/lib/client/api";

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
