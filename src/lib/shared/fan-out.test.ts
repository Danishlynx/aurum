import { describe, expect, it } from "vitest";

import {
  LEADER_ANALYSIS_KIND,
  fanOutOrder,
  reachedChargedSuccess,
  type FanOutKind,
} from "./fan-out";

/**
 * The order the readings are started in, and what a capture that produced
 * nothing costs a judge.
 *
 * Both are here rather than in the jobs runner because both are rules, and a
 * rule that can only be exercised through Supabase and a provider key is a rule
 * nobody checks. Nothing in this file reaches either.
 */

/** What one selfie can start in this build: everything but hair type. */
const RUNNABLE: readonly FanOutKind[] = [
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
];

describe("fanOutOrder", () => {
  it("puts the tone reading in front of everything else", () => {
    // The live failure this exists for: on 2026-09-03 the skin analysis took a
    // frame the tone analysis refused on the pose, and 16 units bought a capture
    // that could not build a profile.
    const order = fanOutOrder(RUNNABLE);
    expect(order.leader).toBe("attributes");
    expect(order.leader).toBe(LEADER_ANALYSIS_KIND);
    expect(order.followers).toEqual(["skin", "fitzpatrick", "face_shape"]);
  });

  it("names every kind exactly once, so nothing is dropped or run twice", () => {
    const order = fanOutOrder(RUNNABLE);
    const all = [
      ...(order.leader === null ? [] : [order.leader]),
      ...order.followers,
    ];
    expect(new Set(all)).toEqual(new Set(RUNNABLE));
    expect(all).toHaveLength(RUNNABLE.length);
  });

  it("starts the rest immediately when the tone reading is not in this run", () => {
    // A re analysis after a tone reading that already succeeded: there is
    // nothing to wait for, so nothing waits.
    const order = fanOutOrder(["skin", "face_shape"]);
    expect(order.leader).toBeNull();
    expect(order.followers).toEqual(["skin", "face_shape"]);
  });

  it("has nothing to start for an empty run", () => {
    expect(fanOutOrder([])).toEqual({ leader: null, followers: [] });
  });
});

describe("reachedChargedSuccess", () => {
  it("is false for the capture the tone reading refused", () => {
    /*
     * The shape the tone first fan out produces: the leader is refused, and the
     * readings that were waiting on it are closed without ever having reserved
     * anything. A failed task is charged nothing, so this capture cost zero and
     * must not take one of a judge's three analyses.
     */
    expect(
      reachedChargedSuccess([
        { status: "failed", creditsUsed: 0 },
        { status: "failed", creditsUsed: 0 },
        { status: "failed", creditsUsed: 0 },
      ]),
    ).toBe(false);
  });

  it("is false while nothing has finished at all", () => {
    expect(
      reachedChargedSuccess([
        { status: "pending", creditsUsed: 0 },
        { status: "running", creditsUsed: 0 },
      ]),
    ).toBe(false);
  });

  it("is false for a capture with no analyses on it", () => {
    expect(reachedChargedSuccess([])).toBe(false);
  });

  it("is true once one reading has come back", () => {
    expect(
      reachedChargedSuccess([
        { status: "succeeded", creditsUsed: 20 },
        { status: "failed", creditsUsed: 0 },
      ]),
    ).toBe(true);
  });

  it("counts a success whose credits read zero", () => {
    // The ledger is the account of record, and a success is what the person was
    // given. A count that argued with the reading they can see would be worse
    // than a count that is generous to us.
    expect(reachedChargedSuccess([{ status: "succeeded", creditsUsed: 0 }])).toBe(
      true,
    );
  });

  it("counts units spent on a reading that then failed to parse", () => {
    // failChargedJob in the jobs runner: the provider charged for a task whose
    // answer we could not read. The money is gone, so the analysis was used.
    expect(reachedChargedSuccess([{ status: "failed", creditsUsed: 16 }])).toBe(
      true,
    );
  });
});
