import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { storedCaptureQualitySchema } from "@/lib/shared/capture-quality-stored";
import { ANALYSIS_FAILURE_REASONS } from "@/lib/shared/analysis-failure";

/**
 * The exported capture outcomes: what the client measured beside what the
 * engine then did, one row per first camera capture.
 *
 * Three things read this file and this module is the one place its shape and
 * its arithmetic live:
 *
 *   scripts/export-capture-outcomes.ts   writes it, from the database
 *   scripts/calibration-report.ts        prints the bucket tables from it
 *   evals/capture/capture.test.ts        computes precision and recall from it
 *
 * The file sits under evals/fixtures/private/, which is gitignored. It carries
 * numbers, a capture id, a timestamp and the engine's own words about the
 * frame, and nothing else: no pixel, no landmark, no signed URL. The export
 * refuses to write it if the sanitizer in scripts/sanitize-perfectcorp-fixture.ts
 * finds a URL or a host in the text.
 *
 * Every function below is pure and tested on synthetic rows, so the arithmetic
 * is proved whether or not a private file exists on the machine running it.
 */

export const CAPTURE_OUTCOMES_FORMAT = "aurum.capture-outcomes.v1";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Relative to the repository root, and gitignored. */
export const CAPTURE_OUTCOMES_RELATIVE_PATH =
  "evals/fixtures/private/capture-outcomes.json";

export const CAPTURE_OUTCOMES_PATH = resolve(
  REPO_ROOT,
  ...CAPTURE_OUTCOMES_RELATIVE_PATH.split("/"),
);

/** The command that produces the file, named wherever its absence is reported. */
export const CAPTURE_OUTCOMES_EXPORT_COMMAND = "npm run calibration:export";

/** The kinds a single selfie can run. hair_type needs three photos. */
export const RUNNABLE_ANALYSIS_KINDS = [
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
] as const;

export const outcomeAnalysisSchema = z.object({
  kind: z.enum(["skin", "fitzpatrick", "attributes", "face_shape", "hair_type"]),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  /** True when a provider task existed for it, whatever became of it. */
  ran: z.boolean(),
  refusal: z
    .object({
      reason: z.enum(ANALYSIS_FAILURE_REASONS),
      code: z.string().nullable(),
      elapsedMs: z.number().nullable(),
    })
    .nullable(),
  /** The engine's own words about the frame, when the result carried them. */
  faceQuality: z
    .object({
      hasFace: z.union([z.boolean(), z.string()]).nullable(),
      area: z.string().nullable(),
      frontal: z.string().nullable(),
      lighting: z.string().nullable(),
      faceangle: z.string().nullable(),
    })
    .nullable(),
  creditsUsed: z.number(),
});

export const outcomeRowSchema = z.object({
  captureId: z.string().min(1),
  createdAt: z.string().min(1),
  quality: storedCaptureQualitySchema,
  analyses: z.array(outcomeAnalysisSchema),
});

export const captureOutcomesFileSchema = z.object({
  format: z.literal(CAPTURE_OUTCOMES_FORMAT),
  exportedAt: z.string().min(1),
  /** What the export left out, as counts, so the file says what it is not. */
  filter: z.object({
    path: z.literal("camera"),
    attempt: z.literal(1),
    excludedProviderFailures: z.number().int().nonnegative(),
  }),
  rows: z.array(outcomeRowSchema),
});

export type OutcomeAnalysis = z.infer<typeof outcomeAnalysisSchema>;
export type OutcomeRow = z.infer<typeof outcomeRowSchema>;
export type CaptureOutcomesFile = z.infer<typeof captureOutcomesFileSchema>;

/**
 * The file, parsed, or null when it is absent. A file that is present and
 * malformed throws: a calibration run on rows the schema cannot vouch for would
 * move thresholds on nothing.
 */
export function readCaptureOutcomes(
  path: string = CAPTURE_OUTCOMES_PATH,
): CaptureOutcomesFile | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = captureOutcomesFileSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `${path} does not match the capture outcomes schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.code}`)
        .join("; ")}. Run ${CAPTURE_OUTCOMES_EXPORT_COMMAND} again.`,
    );
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* What the engine did with the frame                                  */
/* ------------------------------------------------------------------ */

/**
 * accepted      every runnable kind succeeded: the frame was read in full
 * refused       at least one kind was refused for something about the frame
 * undetermined  neither yet: a reading still open, or one that failed for a
 *               reason that says nothing about the frame (a cap, an outage)
 */
export type EngineOutcome = "accepted" | "refused" | "undetermined";

export function engineOutcomeOf(row: OutcomeRow): EngineOutcome {
  const byKind = new Map(row.analyses.map((entry) => [entry.kind, entry]));
  const runnable = RUNNABLE_ANALYSIS_KINDS.map((kind) => byKind.get(kind));
  if (runnable.every((entry) => entry?.status === "succeeded")) {
    return "accepted";
  }
  const refused = row.analyses.some(
    (entry) => entry.refusal !== null && entry.refusal.reason !== "provider",
  );
  return refused ? "refused" : "undetermined";
}

export interface PrecisionRecall {
  /** Rows the engine gave a verdict on, one way or the other. */
  readonly n: number;
  /** Rows the client accepted, among those. */
  readonly accepts: number;
  /** Rows the engine accepted in full, among those. */
  readonly accepted: number;
  /** Rows both accepted. */
  readonly truePositives: number;
  /** P(engine accepted every runnable kind | stored verdict accept). */
  readonly precision: number | null;
  /** P(stored verdict accept | engine accepted every kind). */
  readonly recall: number | null;
}

export function precisionRecallOf(rows: readonly OutcomeRow[]): PrecisionRecall {
  let n = 0;
  let accepts = 0;
  let accepted = 0;
  let truePositives = 0;
  for (const row of rows) {
    const outcome = engineOutcomeOf(row);
    if (outcome === "undetermined") {
      continue;
    }
    n += 1;
    const clientAccepted = row.quality.verdict === "accept";
    const engineAccepted = outcome === "accepted";
    if (clientAccepted) {
      accepts += 1;
    }
    if (engineAccepted) {
      accepted += 1;
    }
    if (clientAccepted && engineAccepted) {
      truePositives += 1;
    }
  }
  return {
    n,
    accepts,
    accepted,
    truePositives,
    precision: accepts === 0 ? null : truePositives / accepts,
    recall: accepted === 0 ? null : truePositives / accepted,
  };
}

/* ------------------------------------------------------------------ */
/* The numbers beside the verdicts                                     */
/* ------------------------------------------------------------------ */

export interface BucketRate {
  readonly label: string;
  /** Rows in the bucket the engine gave a verdict on. */
  readonly n: number;
  /** Of those, rows the engine accepted in full. */
  readonly ok: number;
  readonly rate: number | null;
}

/**
 * Acceptance by bucket of one measured number. Edges are ascending and each
 * bucket is [edge, next edge); the last runs to the second edge's end. A row
 * whose number is null or whose engine outcome is undetermined is left out.
 */
export function bucketRates(
  rows: readonly OutcomeRow[],
  pick: (row: OutcomeRow) => number | null,
  edges: readonly number[],
): BucketRate[] {
  const counts = edges.slice(0, -1).map(() => ({ n: 0, ok: 0 }));
  for (const row of rows) {
    const outcome = engineOutcomeOf(row);
    if (outcome === "undetermined") {
      continue;
    }
    const value = pick(row);
    if (value === null || !Number.isFinite(value)) {
      continue;
    }
    for (let index = 0; index < counts.length; index += 1) {
      const low = edges[index] ?? Number.NEGATIVE_INFINITY;
      const high = edges[index + 1] ?? Number.POSITIVE_INFINITY;
      const last = index === counts.length - 1;
      if (value >= low && (value < high || (last && value <= high))) {
        const bucket = counts[index];
        if (bucket !== undefined) {
          bucket.n += 1;
          if (outcome === "accepted") {
            bucket.ok += 1;
          }
        }
        break;
      }
    }
  }
  return counts.map((bucket, index) => ({
    label: `${formatEdge(edges[index])} to ${formatEdge(edges[index + 1])}`,
    n: bucket.n,
    ok: bucket.ok,
    rate: bucket.n === 0 ? null : bucket.ok / bucket.n,
  }));
}

function formatEdge(edge: number | undefined): string {
  if (edge === undefined || !Number.isFinite(edge)) {
    return edge !== undefined && edge < 0 ? "-inf" : "inf";
  }
  return String(edge);
}

/** The pickers the report and the eval bucket on, in one place. */
export const OUTCOME_PICKERS = {
  absYaw: (row: OutcomeRow): number | null =>
    row.quality.pose == null ? null : Math.abs(row.quality.pose.yaw_degrees),
  pitch: (row: OutcomeRow): number | null =>
    row.quality.pose == null ? null : row.quality.pose.pitch_degrees,
  absRoll: (row: OutcomeRow): number | null =>
    row.quality.pose == null ? null : Math.abs(row.quality.pose.roll_degrees),
  faceWidthRatio: (row: OutcomeRow): number | null =>
    row.quality.face_width_ratio ?? null,
  faceLuma: (row: OutcomeRow): number | null => row.quality.face_luma ?? null,
  blinkMax: (row: OutcomeRow): number | null =>
    row.quality.blink == null
      ? null
      : Math.max(row.quality.blink.left, row.quality.blink.right),
} as const;

/** The edges, in engine terms where the engine publishes any. */
export const OUTCOME_BUCKETS = {
  absYaw: [0, 5, 8, 10, 15, 20, 30, 90],
  pitch: [-90, -20, -10, -5, 0, 6, 10, 20, 90],
  absRoll: [0, 5, 8, 10, 15, 20, 30, 90],
  faceWidthRatio: [0, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.85, 1],
  faceLuma: [0, 0.157, 0.235, 0.4, 0.55, 0.8, 0.882, 1],
  blinkMax: [0, 0.2, 0.5, 0.8, 1],
} as const;

export interface RefusalLine {
  readonly code: string | null;
  readonly reason: string;
  readonly kind: OutcomeAnalysis["kind"];
  readonly elapsedMs: number | null;
  readonly verdict: OutcomeRow["quality"]["verdict"];
  readonly measured: boolean | null;
  readonly yaw: number | null;
  readonly pitch: number | null;
  readonly roll: number | null;
  readonly faceWidthRatio: number | null;
  readonly faceLuma: number | null;
  readonly blinkMax: number | null;
}

/** Every refused reading with our numbers beside it, one line per refusal. */
export function refusalLines(rows: readonly OutcomeRow[]): RefusalLine[] {
  const lines: RefusalLine[] = [];
  for (const row of rows) {
    for (const entry of row.analyses) {
      if (entry.refusal === null) {
        continue;
      }
      lines.push({
        code: entry.refusal.code,
        reason: entry.refusal.reason,
        kind: entry.kind,
        elapsedMs: entry.refusal.elapsedMs,
        verdict: row.quality.verdict,
        measured: row.quality.measured ?? null,
        yaw: row.quality.pose?.yaw_degrees ?? null,
        pitch: row.quality.pose?.pitch_degrees ?? null,
        roll: row.quality.pose?.roll_degrees ?? null,
        faceWidthRatio: row.quality.face_width_ratio ?? null,
        faceLuma: row.quality.face_luma ?? null,
        blinkMax: OUTCOME_PICKERS.blinkMax(row),
      });
    }
  }
  return lines;
}

/** Refusals grouped by the engine's code, most frequent first. */
export function refusalCodeCounts(
  rows: readonly OutcomeRow[],
): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of refusalLines(rows)) {
    const code = line.code ?? "(no code)";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || (left.code < right.code ? -1 : 1));
}
