/**
 * Exports the capture outcomes the calibration reads: what the client measured
 * on each first camera capture, beside what the engine then did with it.
 *
 * Why this exists. Every threshold in src/lib/shared/quality.ts was set from
 * synthetic stripes or one founder's phone. The honest way to set one is against
 * the frames the gate let through and what the engine said about them, and
 * since 2026-09-23 both halves are stored: captures.quality carries every number
 * the gate measured, and analyses.raw carries the engine's refusal code, its
 * face_quality words and its elapsed time. This script joins the two and writes
 * them to a file the report and the eval read.
 *
 * What it writes, and what it will not:
 *
 * - One row per capture whose quality says path "camera" and attempt 1: the
 *   frame the person actually took, before any reframe. Gallery uploads and
 *   reframes are a different population and are left out.
 * - Rows where any reading was refused for reason "provider" are excluded: an
 *   outage or a schema failure says nothing about the frame.
 * - Numbers, a capture id, a timestamp, the engine's words. No pixel, no
 *   landmark, no storage path, no signed URL. The text is scanned by the same
 *   findLeaks the fixture sanitizer uses, and nothing is written if a URL or a
 *   provider host survives.
 *
 * The output lives at evals/fixtures/private/capture-outcomes.json, which is
 * gitignored. It is never committed and this script never runs in CI: it needs
 * the service role key, which CI does not have and must not be given.
 *
 * Run it:
 *
 *     npm run calibration:export
 *
 * The key is read from SUPABASE_SERVICE_ROLE_KEY, from the shell or from
 * .env.local, and is never printed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { storedCaptureQualitySchema } from "@/lib/shared/capture-quality-stored";
import { ANALYSIS_FAILURE_REASONS } from "@/lib/shared/analysis-failure";

import {
  CAPTURE_OUTCOMES_FORMAT,
  CAPTURE_OUTCOMES_PATH,
  captureOutcomesFileSchema,
  type CaptureOutcomesFile,
  type OutcomeAnalysis,
  type OutcomeRow,
} from "../evals/support/capture-outcomes";
import { findLeaks } from "./sanitize-perfectcorp-fixture";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How many captures one page of the query carries. */
const PAGE_SIZE = 500;

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

/**
 * The smallest .env.local reader that does the job. Values are never printed
 * and never returned to a caller that would; they go into process.env only
 * where nothing is set already, so a shell value still wins.
 */
export function loadEnvLocal(path = resolve(REPO_ROOT, ".env.local")): void {
  if (!existsSync(path)) {
    return;
  }
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

/* ------------------------------------------------------------------ */
/* The rows as the database hands them                                 */
/* ------------------------------------------------------------------ */

/** The refusal note the jobs layer writes into analyses.raw. */
const refusalNoteSchema = z.object({
  refusal: z.object({
    reason: z.enum(ANALYSIS_FAILURE_REASONS),
    code: z.string().nullable().optional(),
    elapsed_ms: z.number().nullable().optional(),
  }),
});

/** The engine's own words, as the provider schema stores them. */
const faceQualityRawSchema = z.object({
  face_quality: z
    .object({
      has_face: z.union([z.boolean(), z.string()]).nullish(),
      area: z.string().nullish(),
      frontal: z.string().nullish(),
      lighting: z.string().nullish(),
      faceangle: z.string().nullish(),
    })
    .nullish(),
});

const analysisRowSchema = z.object({
  kind: z.enum(["skin", "fitzpatrick", "attributes", "face_shape", "hair_type"]),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  provider_task_id: z.string().nullable(),
  raw: z.unknown(),
  credits_used: z.number(),
});

const captureRowSchema = z.object({
  id: z.string().min(1),
  created_at: z.string().min(1),
  quality: z.unknown(),
  analyses: z.array(analysisRowSchema),
});

type CaptureRow = z.infer<typeof captureRowSchema>;

/**
 * One analysis row, reduced to what the calibration reads. Pure, so the
 * reduction is tested without a database.
 */
export function toOutcomeAnalysis(
  analysis: z.infer<typeof analysisRowSchema>,
): OutcomeAnalysis {
  const refusal = refusalNoteSchema.safeParse(analysis.raw);
  const quality = faceQualityRawSchema.safeParse(analysis.raw);
  const block = quality.success ? quality.data.face_quality : null;
  return {
    kind: analysis.kind,
    status: analysis.status,
    ran: analysis.provider_task_id !== null,
    refusal: refusal.success
      ? {
          reason: refusal.data.refusal.reason,
          code: refusal.data.refusal.code ?? null,
          elapsedMs: refusal.data.refusal.elapsed_ms ?? null,
        }
      : null,
    faceQuality:
      block === null || block === undefined
        ? null
        : {
            hasFace: block.has_face ?? null,
            area: block.area ?? null,
            frontal: block.frontal ?? null,
            lighting: block.lighting ?? null,
            faceangle: block.faceangle ?? null,
          },
    creditsUsed: analysis.credits_used,
  };
}

/**
 * One capture row to one outcome row, or null when the capture is not a first
 * camera capture, its quality does not parse, or a reading failed for a reason
 * that says nothing about the frame.
 */
export function toOutcomeRow(
  capture: CaptureRow,
): { row: OutcomeRow } | { skipped: "not_first_camera" | "unreadable_quality" | "provider" } {
  const quality = storedCaptureQualitySchema.safeParse(capture.quality);
  if (!quality.success) {
    return { skipped: "unreadable_quality" };
  }
  if (quality.data.path !== "camera" || quality.data.attempt !== 1) {
    return { skipped: "not_first_camera" };
  }
  const analyses = capture.analyses.map(toOutcomeAnalysis);
  if (analyses.some((entry) => entry.refusal?.reason === "provider")) {
    return { skipped: "provider" };
  }
  return {
    row: {
      captureId: capture.id,
      createdAt: capture.created_at,
      quality: quality.data,
      analyses,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export async function exportCaptureOutcomes(args: {
  readonly outPath?: string;
  readonly now?: Date;
}): Promise<{ readonly written: number; readonly skipped: Record<string, number> }> {
  if (process.env.CI !== undefined && process.env.CI !== "") {
    throw new ExportError("This export needs the service role key and never runs in CI.");
  }
  loadEnvLocal();
  const env = envSchema.safeParse(process.env);
  if (!env.success) {
    throw new ExportError(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (shell or .env.local).",
    );
  }

  const client = createClient(env.data.NEXT_PUBLIC_SUPABASE_URL, env.data.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const rows: OutcomeRow[] = [];
  const skipped: Record<string, number> = {
    not_first_camera: 0,
    unreadable_quality: 0,
    provider: 0,
  };

  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await client
      .from("captures")
      .select("id, created_at, quality, analyses(kind, status, provider_task_id, raw, credits_used)")
      .eq("quality->>path", "camera")
      .eq("quality->>attempt", "1")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (result.error !== null) {
      throw new ExportError(`read captures failed: ${result.error.message}`);
    }
    const page = z.array(captureRowSchema).safeParse(result.data);
    if (!page.success) {
      throw new ExportError("The captures query answered rows of a shape this script does not read.");
    }
    for (const capture of page.data) {
      const outcome = toOutcomeRow(capture);
      if ("row" in outcome) {
        rows.push(outcome.row);
      } else {
        skipped[outcome.skipped] = (skipped[outcome.skipped] ?? 0) + 1;
      }
    }
    if (page.data.length < PAGE_SIZE) {
      break;
    }
  }

  const file: CaptureOutcomesFile = {
    format: CAPTURE_OUTCOMES_FORMAT,
    exportedAt: (args.now ?? new Date()).toISOString(),
    filter: {
      path: "camera",
      attempt: 1,
      excludedProviderFailures: skipped.provider ?? 0,
    },
    rows,
  };
  // The file has to parse under the schema the readers use, or it is not written.
  captureOutcomesFileSchema.parse(file);

  const text = `${JSON.stringify(file, null, 2)}\n`;
  const leaks = findLeaks(text);
  if (leaks.length > 0) {
    throw new ExportError(
      `The export carries ${leaks.join(", ")}. Nothing was written.`,
    );
  }

  const outPath = args.outPath ?? CAPTURE_OUTCOMES_PATH;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, "utf8");
  return { written: rows.length, skipped };
}

export async function main(): Promise<number> {
  try {
    const outcome = await exportCaptureOutcomes({});
    console.log(
      `Wrote ${String(outcome.written)} first camera captures to ${CAPTURE_OUTCOMES_PATH} (skipped: ${JSON.stringify(outcome.skipped)}).`,
    );
    return 0;
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
