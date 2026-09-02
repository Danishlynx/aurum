/**
 * The rule that decides whether an open classification job is work in flight or
 * work that died.
 *
 * Why this exists. A classification is not a pollable job: the Claude call is
 * one HTTP round trip inside the request, and a serverless function does no
 * work after its response is sent, so nothing can advance a classification once
 * its request is over. classifyGarment still checks for an open job first,
 * which is the right idempotency rule while the call is live and the wrong one
 * forever after: a request that died mid call (a function timeout, a dropped
 * connection, a closed tab) leaves the row at running, findOpenJobForSubject
 * keeps matching it, and every later attempt answers alreadyRunning. The card
 * then holds its skeleton chips permanently and cannot even reach the failed
 * state the flow doc describes, because that needs a failed job.
 *
 * The window separates the two cases, so these tests pin both edges: inside it
 * a second tap is still idempotent, past it the garment can be classified again.
 *
 * Spec: docs/01-user-flow.md section J ("States"), docs/03-architecture.md
 * ("Jobs, not long requests").
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JobRecord } from "@/lib/server/db/types";
import {
  isStaleClassificationJob,
  STALE_CLASSIFICATION_JOB_MS,
} from "@/lib/server/wardrobe/classify";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function jobUpdatedAt(iso: string): JobRecord {
  return {
    id: "job-1",
    user_id: "owner-1",
    subject_type: "classification",
    subject_id: "garment-1",
    status: "running",
    provider_task_id: null,
    attempts: 1,
    last_polled_at: null,
    error: null,
    created_at: iso,
    updated_at: iso,
  };
}

function jobAgedMs(ms: number): JobRecord {
  return jobUpdatedAt(new Date(NOW - ms).toISOString());
}

describe("isStaleClassificationJob", () => {
  it("holds a job that was touched a moment ago, so a double tap is idempotent", () => {
    expect(isStaleClassificationJob(jobAgedMs(0), NOW)).toBe(false);
    expect(isStaleClassificationJob(jobAgedMs(1_000), NOW)).toBe(false);
  });

  it("holds a job that is still inside the window a live call could occupy", () => {
    expect(
      isStaleClassificationJob(jobAgedMs(STALE_CLASSIFICATION_JOB_MS - 1), NOW),
    ).toBe(false);
  });

  it("releases a job that has outlived the window", () => {
    expect(
      isStaleClassificationJob(jobAgedMs(STALE_CLASSIFICATION_JOB_MS + 1), NOW),
    ).toBe(true);
  });

  it("releases a job left running by an interrupted request", () => {
    // The founder uploads a garment, the classify call is cut off mid flight,
    // and he taps add again a few minutes later. Before the window, that second
    // attempt answered alreadyRunning forever.
    expect(isStaleClassificationJob(jobAgedMs(5 * 60_000), NOW)).toBe(true);
  });

  it("covers the provider timeout with room to spare", () => {
    // A call that is still inside the Claude timeout has to count as live, or
    // the window would let a second call start beside a first one that is
    // genuinely still running and spend two credits on one garment.
    expect(STALE_CLASSIFICATION_JOB_MS).toBeGreaterThan(30_000);
  });

  it("treats a job with an unreadable timestamp as live", () => {
    // The safe half of the pair: keeping the old behaviour costs a person one
    // tap, while releasing on a timestamp nobody parsed could spend a credit.
    expect(isStaleClassificationJob(jobUpdatedAt("not a date"), NOW)).toBe(false);
  });
});
