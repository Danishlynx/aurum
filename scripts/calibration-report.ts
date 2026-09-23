/**
 * The calibration report: our numbers beside the engine's verdicts.
 *
 * Reads evals/fixtures/private/capture-outcomes.json (written by
 * scripts/export-capture-outcomes.ts, gitignored) and prints, for each number
 * the gate measures, the engine's acceptance rate by bucket: absolute yaw,
 * signed pitch, absolute roll, face width ratio, face luma over the oval, and
 * the blink maximum; before those, the engine's acceptance of the frames we
 * accepted, per platform (ios, android, desktop). Then every refusal code the
 * engine answered, each with the numbers we measured on the frame it refused.
 *
 * This is how a threshold moves. A constant in src/lib/shared/quality.ts is
 * changed only when a row of this report says the engine refuses on the other
 * side of it (docs/05-evals.md, eval:capture). The report never spends a unit
 * and never reads a database: the export did both of those, once.
 *
 * The same numbers are written to evals/results/capture-calibration-<sha>.json
 * so a PR that moves a threshold can attach the run it moved it on.
 *
 * Run it:
 *
 *     npm run calibration:report
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_OUTCOMES_EXPORT_COMMAND,
  CAPTURE_OUTCOMES_PATH,
  OUTCOME_BUCKETS,
  OUTCOME_PICKERS,
  bucketRates,
  platformRates,
  precisionRecallOf,
  readCaptureOutcomes,
  refusalCodeCounts,
  refusalLines,
  type BucketRate,
  type CaptureOutcomesFile,
} from "../evals/support/capture-outcomes";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The short git sha, or "unknown" outside a checkout. Never throws. */
export function shortGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function percent(rate: number | null): string {
  return rate === null ? "   -  " : `${(rate * 100).toFixed(1).padStart(5)}%`;
}

function fixed(value: number | null, digits: number): string {
  return value === null ? "-" : value.toFixed(digits);
}

function table(title: string, rates: readonly BucketRate[]): string[] {
  const lines = [`${title}`, `  ${"bucket".padEnd(18)} ${"n".padStart(5)} ${"ok".padStart(5)}   rate`];
  for (const rate of rates) {
    lines.push(
      `  ${rate.label.padEnd(18)} ${String(rate.n).padStart(5)} ${String(rate.ok).padStart(5)}  ${percent(rate.rate)}`,
    );
  }
  return lines;
}

/** Everything the report prints and writes, as one object. Pure. */
export function buildCalibrationReport(file: CaptureOutcomesFile, sha: string) {
  const rows = file.rows;
  return {
    sha,
    exportedAt: file.exportedAt,
    rowsRead: rows.length,
    excludedProviderFailures: file.filter.excludedProviderFailures,
    precisionRecall: precisionRecallOf(rows),
    /**
     * Acceptance per kind of camera, over the rows the client accepted. Each
     * platform frames the face differently (src/lib/client/platform.ts), so a
     * rate that looks fine on average can hide one platform the gate gets
     * wrong; docs/05-evals.md asks for the breakdown.
     */
    byPlatform: platformRates(rows.filter((row) => row.quality.verdict === "accept")),
    buckets: {
      absYaw: bucketRates(rows, OUTCOME_PICKERS.absYaw, OUTCOME_BUCKETS.absYaw),
      pitch: bucketRates(rows, OUTCOME_PICKERS.pitch, OUTCOME_BUCKETS.pitch),
      absRoll: bucketRates(rows, OUTCOME_PICKERS.absRoll, OUTCOME_BUCKETS.absRoll),
      faceWidthRatio: bucketRates(
        rows,
        OUTCOME_PICKERS.faceWidthRatio,
        OUTCOME_BUCKETS.faceWidthRatio,
      ),
      faceLuma: bucketRates(rows, OUTCOME_PICKERS.faceLuma, OUTCOME_BUCKETS.faceLuma),
      blinkMax: bucketRates(rows, OUTCOME_PICKERS.blinkMax, OUTCOME_BUCKETS.blinkMax),
    },
    refusalCodes: refusalCodeCounts(rows),
    refusals: refusalLines(rows),
  };
}

export function renderCalibrationReport(
  report: ReturnType<typeof buildCalibrationReport>,
): string {
  const lines: string[] = [];
  lines.push(`Capture calibration at ${report.sha}, export of ${report.exportedAt}`);
  lines.push(
    `${String(report.rowsRead)} first camera captures read, ${String(report.excludedProviderFailures)} left out for provider failures.`,
  );
  const pr = report.precisionRecall;
  lines.push(
    `Verdicts decided by the engine: ${String(pr.n)}. Client accepts ${String(pr.accepts)}, engine accepted in full ${String(pr.accepted)}, both ${String(pr.truePositives)}.`,
  );
  lines.push(
    `Precision (engine accepted | we accepted): ${percent(pr.precision).trim()}. Recall (we accepted | engine accepted): ${percent(pr.recall).trim()}.`,
  );
  lines.push("");
  lines.push(
    ...table("Engine acceptance of our accepted frames, by platform", report.byPlatform),
    "",
  );
  lines.push(...table("Acceptance by |yaw| (degrees)", report.buckets.absYaw), "");
  lines.push(...table("Acceptance by pitch (degrees, signed)", report.buckets.pitch), "");
  lines.push(...table("Acceptance by |roll| (degrees)", report.buckets.absRoll), "");
  lines.push(...table("Acceptance by face width ratio", report.buckets.faceWidthRatio), "");
  lines.push(...table("Acceptance by face luma (0 to 1)", report.buckets.faceLuma), "");
  lines.push(...table("Acceptance by blink max (0 to 1)", report.buckets.blinkMax), "");

  lines.push("Refusal codes");
  if (report.refusalCodes.length === 0) {
    lines.push("  none");
  }
  for (const entry of report.refusalCodes) {
    lines.push(`  ${entry.code.padEnd(40)} ${String(entry.count).padStart(5)}`);
  }
  lines.push("");
  lines.push("Every refusal, with our numbers beside it");
  lines.push(
    `  ${"code".padEnd(36)} ${"kind".padEnd(11)} ${"verdict".padEnd(10)} meas  ${"yaw".padStart(6)} ${"pitch".padStart(6)} ${"roll".padStart(6)} ${"width".padStart(6)} ${"luma".padStart(6)} ${"blink".padStart(6)} ${"ms".padStart(7)}`,
  );
  for (const line of report.refusals) {
    lines.push(
      `  ${(line.code ?? "(no code)").padEnd(36)} ${line.kind.padEnd(11)} ${line.verdict.padEnd(10)} ${
        line.measured === null ? "?" : line.measured ? "y" : "n"
      }     ${fixed(line.yaw, 1).padStart(6)} ${fixed(line.pitch, 1).padStart(6)} ${fixed(line.roll, 1).padStart(6)} ${fixed(line.faceWidthRatio, 2).padStart(6)} ${fixed(line.faceLuma, 2).padStart(6)} ${fixed(line.blinkMax, 2).padStart(6)} ${fixed(line.elapsedMs, 0).padStart(7)}`,
    );
  }
  return lines.join("\n");
}

export function main(): number {
  let file: CaptureOutcomesFile | null;
  try {
    file = readCaptureOutcomes();
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
  if (file === null) {
    console.error(
      `No ${CAPTURE_OUTCOMES_PATH}. Run ${CAPTURE_OUTCOMES_EXPORT_COMMAND} with the service role key first.`,
    );
    return 1;
  }

  const sha = shortGitSha();
  const report = buildCalibrationReport(file, sha);
  console.log(renderCalibrationReport(report));

  const outPath = resolve(REPO_ROOT, "evals", "results", `capture-calibration-${sha}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}.`);
  return 0;
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
  process.exitCode = main();
}
