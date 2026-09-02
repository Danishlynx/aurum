/**
 * The golden run: one frugal pass over one consented selfie.
 *
 * Why this exists. The account holds 40 Perfect Corp trial units, which is less
 * than one full capture set at the documented prices. Judges therefore get no
 * live analysis at all: the judge experience serves the seeded demo profile
 * (docs/07-payments-and-judge-mode.md, "Demo profile"). The units are spent
 * once, here, on the founder's own face, and everything downstream (the demo
 * profile, the eval fixtures, the screenshots) is seeded from what comes back.
 *
 * What it runs, and what it deliberately does not:
 *
 * - skin       skin analysis, the concern scores and their masks
 * - tone       skin tone analysis, the facial colours the palette is built from
 * - attr       face attributes, one attribute (face shape), cheapest tier
 * - makeup     one makeup try on, optional
 * - hairstyle  one hairstyle try on, optional
 *
 * Not run, on purpose: the Fitzpatrick analysis (10 units for one number the
 * palette can live without) and hair type detection (2 units, and it needs
 * three photos of the same size, which a one selfie flow does not have).
 *
 * Rules this script keeps, in order of importance:
 *
 * 1. Nothing is called before the plan has been printed and agreed to.
 * 2. The planned spend is checked against --spend before the first call, and
 *    the running spend is checked again before every call after that.
 * 3. Calls run one at a time, never in parallel, so the spend is always known.
 * 4. A failure stops the run. No spending call is ever retried automatically.
 * 5. No key value is printed, logged, or written to any output file.
 *
 * Run it:
 *
 *     npm run golden:run -- --image path\to\selfie.jpg --spend 34
 *
 * The flags are documented in docs/SUBMISSION-RUNBOOK.md, section A13.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { UNKNOWN_COST_FALLBACK_UNITS } from "@/lib/server/credits/costs";
import {
  normalize,
  planFor as analysisPlanFor,
  startTask,
  uploadCapture,
} from "@/lib/server/jobs/analysis";
import * as perfectcorp from "@/lib/server/providers/perfectcorp";
import {
  PERFECTCORP_TASK_TIMEOUT_MS,
  createTask,
  downloadResultAssets,
  getEndpoint,
  getTaskSnapshot,
  parseRenderUrls,
  unitsForCall,
  type PerfectCorpEndpointKey,
  type TaskSnapshot,
} from "@/lib/server/providers/perfectcorp";
import { buildMakeupCategoryViews } from "@/lib/server/profile/shades";
import { detectUndertone } from "@/lib/server/profile/undertone";
import { hairstyleTemplateFor } from "@/lib/server/renders/hair";
import { makeupTaskBody } from "@/lib/server/renders/makeup";
import { MAKEUP_CATEGORIES, type MakeupCategory } from "@/lib/shared/color-view";
import type { AnalysisKind } from "@/lib/server/db/types";
import { derivePalette } from "@/lib/shared/palette";
import {
  FACE_COVERAGE_MIN,
  MEAN_LUMINANCE_REJECT_ABOVE,
  MEAN_LUMINANCE_REJECT_BELOW,
  SHARPNESS_REJECT_BELOW,
} from "@/lib/shared/quality";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Anything this script refuses to do, with a line the operator can act on. */
export class GoldenRunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GoldenRunError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* The step catalog                                                    */
/* ------------------------------------------------------------------ */

export const GOLDEN_STEP_KEYS = [
  "skin",
  "tone",
  "attr",
  "makeup",
  "hairstyle",
] as const;

export type GoldenStep = (typeof GOLDEN_STEP_KEYS)[number];

/** The three analyses the demo profile cannot be built without. */
export const DEFAULT_STEPS: readonly GoldenStep[] = ["skin", "tone", "attr"];

type StepDefinition =
  | {
      readonly kind: "analysis";
      readonly analysisKind: AnalysisKind;
      readonly label: string;
    }
  | {
      readonly kind: "render";
      readonly endpointKey: PerfectCorpEndpointKey;
      readonly label: string;
    };

export const GOLDEN_STEPS: Readonly<Record<GoldenStep, StepDefinition>> = {
  skin: {
    kind: "analysis",
    analysisKind: "skin",
    label: "Skin analysis, concern scores and masks",
  },
  tone: {
    kind: "analysis",
    analysisKind: "attributes",
    label: "Skin tone analysis, the facial colours",
  },
  attr: {
    kind: "analysis",
    analysisKind: "face_shape",
    label: "Face attributes, face shape only",
  },
  makeup: {
    kind: "render",
    endpointKey: "makeupTryOn",
    label: "Makeup try on, one render",
  },
  hairstyle: {
    kind: "render",
    endpointKey: "hairstyleTryOn",
    label: "Hairstyle try on, one render",
  },
};

/**
 * The two capture analyses this script will not run, and why. Printed with the
 * plan so the choice is visible every time rather than buried here.
 */
export const SKIPPED_ANALYSES: ReadonlyArray<{
  readonly key: string;
  readonly reason: string;
}> = [
  {
    key: "fitzpatrick",
    reason:
      "10 units for one number. The palette derives without it, so it is not worth a quarter of the balance.",
  },
  {
    key: "hairType",
    reason:
      "Needs three photos of the same size (front, right, left). A one selfie flow cannot satisfy it.",
  },
];

export function isGoldenStep(value: string): value is GoldenStep {
  return (GOLDEN_STEP_KEYS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface GoldenOptions {
  readonly imagePath: string;
  /** Hard ceiling in units. The run aborts rather than crossing it. */
  readonly spendUnits: number;
  readonly steps: readonly GoldenStep[];
  readonly outDir: string;
  /** Skips the typed confirmation, for a non interactive operator. */
  readonly confirm: boolean;
  /** What an endpoint whose real cost is still unknown counts as in the plan. */
  readonly assumeUnknownUnits: number;
  /** Names the capture in the uploaded file name and in the fixture id. */
  readonly captureId: string;
  readonly fixtureId: string;
  readonly makeupCategories: readonly MakeupCategory[];
  readonly hairstyleStyleId: string;
  /** A provider template id read from the API playground, which costs nothing. */
  readonly hairstyleTemplateId: string | null;
}

const DEFAULT_OUT_DIR = "evals/fixtures/golden";
const DEFAULT_CAPTURE_ID = "golden-01";
const DEFAULT_FIXTURE_ID = "live-01";
const DEFAULT_HAIRSTYLE_STYLE_ID = "textured-crop";

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new GoldenRunError("bad_argument", `${flag} needs a value.`);
  }
  return value;
}

function positiveInteger(flag: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new GoldenRunError(
      "bad_argument",
      `${flag} needs a whole number above zero, and was given "${raw}".`,
    );
  }
  return parsed;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Reads the command line. Throws on anything it does not recognise rather than
 * guessing, because a typo in a flag on a script that spends money should stop
 * the script, not change what it does.
 */
export function parseArgs(argv: readonly string[]): GoldenOptions {
  let imagePath: string | null = null;
  let spendUnits: number | null = null;
  let steps: GoldenStep[] = [...DEFAULT_STEPS];
  let outDir = DEFAULT_OUT_DIR;
  let confirm = false;
  let assumeUnknownUnits = UNKNOWN_COST_FALLBACK_UNITS;
  let captureId = DEFAULT_CAPTURE_ID;
  let fixtureId = DEFAULT_FIXTURE_ID;
  let makeupCategories: MakeupCategory[] = [...MAKEUP_CATEGORIES];
  let hairstyleStyleId = DEFAULT_HAIRSTYLE_STYLE_ID;
  let hairstyleTemplateId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--image":
        imagePath = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--spend":
        spendUnits = positiveInteger(flag, requireValue(flag, argv[index + 1]));
        index += 1;
        break;
      case "--steps": {
        const requested = splitList(requireValue(flag, argv[index + 1]));
        const unknown = requested.filter((entry) => !isGoldenStep(entry));
        if (unknown.length > 0) {
          throw new GoldenRunError(
            "bad_argument",
            `--steps does not know ${unknown.join(", ")}. Known steps: ${GOLDEN_STEP_KEYS.join(", ")}.`,
          );
        }
        steps = requested.filter(isGoldenStep);
        index += 1;
        break;
      }
      case "--out":
        outDir = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--confirm":
        confirm = true;
        break;
      case "--assume-unknown":
        assumeUnknownUnits = positiveInteger(
          flag,
          requireValue(flag, argv[index + 1]),
        );
        index += 1;
        break;
      case "--capture-id":
        captureId = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--fixture-id":
        fixtureId = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--makeup-categories": {
        const requested = splitList(requireValue(flag, argv[index + 1]));
        const unknown = requested.filter(
          (entry) => !(MAKEUP_CATEGORIES as readonly string[]).includes(entry),
        );
        if (unknown.length > 0) {
          throw new GoldenRunError(
            "bad_argument",
            `--makeup-categories does not know ${unknown.join(", ")}. Known: ${MAKEUP_CATEGORIES.join(", ")}.`,
          );
        }
        makeupCategories = requested as MakeupCategory[];
        index += 1;
        break;
      }
      case "--hairstyle-style":
        hairstyleStyleId = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--hairstyle-template":
        hairstyleTemplateId = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      default:
        throw new GoldenRunError("bad_argument", `Unknown argument ${String(flag)}.`);
    }
  }

  if (imagePath === null) {
    throw new GoldenRunError("bad_argument", "--image is required.");
  }
  if (spendUnits === null) {
    throw new GoldenRunError(
      "bad_argument",
      "--spend is required. It is the hard ceiling in units, and the run aborts rather than crossing it.",
    );
  }
  if (steps.length === 0) {
    throw new GoldenRunError("bad_argument", "--steps left nothing to run.");
  }

  return {
    imagePath,
    spendUnits,
    steps: dedupeSteps(steps),
    outDir,
    confirm,
    assumeUnknownUnits,
    captureId,
    fixtureId,
    makeupCategories,
    hairstyleStyleId,
    hairstyleTemplateId,
  };
}

/** Keeps the catalog order, so the run order does not depend on typing order. */
function dedupeSteps(steps: readonly GoldenStep[]): GoldenStep[] {
  const wanted = new Set(steps);
  return GOLDEN_STEP_KEYS.filter((key) => wanted.has(key));
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

export interface PlannedCall {
  readonly step: GoldenStep;
  readonly label: string;
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly itemCount: number;
  /** Units from the provider cost table. Null while the table says unknown. */
  readonly tableUnits: number | null;
  /** What the guard counts: the table, or the assumption when it is unknown. */
  readonly assumedUnits: number;
  readonly verification: "confirmed" | "unverified";
}

export interface GoldenPlan {
  readonly calls: readonly PlannedCall[];
  readonly assumedTotalUnits: number;
  /** Steps priced by assumption rather than by the table. */
  readonly unknownCostSteps: readonly GoldenStep[];
  /** Steps whose endpoint is not confirmed against the live docs. */
  readonly unverifiedSteps: readonly GoldenStep[];
}

function endpointAndCountFor(
  step: GoldenStep,
): { readonly endpointKey: PerfectCorpEndpointKey; readonly itemCount: number } {
  const definition = GOLDEN_STEPS[step];
  if (definition.kind === "analysis") {
    const plan = analysisPlanFor(definition.analysisKind);
    return { endpointKey: plan.endpointKey, itemCount: plan.itemCount };
  }
  return { endpointKey: definition.endpointKey, itemCount: 1 };
}

/**
 * Prices the run from the provider's own table, the same table the credits
 * layer reads, so this script and the app can never disagree about what a call
 * costs.
 */
export function buildPlan(options: GoldenOptions): GoldenPlan {
  const calls: PlannedCall[] = options.steps.map((step) => {
    const { endpointKey, itemCount } = endpointAndCountFor(step);
    const tableUnits = unitsForCall(endpointKey, itemCount);
    return {
      step,
      label: GOLDEN_STEPS[step].label,
      endpointKey,
      itemCount,
      tableUnits,
      assumedUnits: tableUnits ?? options.assumeUnknownUnits,
      verification: getEndpoint(endpointKey).verification.state,
    };
  });

  return {
    calls,
    assumedTotalUnits: calls.reduce((sum, call) => sum + call.assumedUnits, 0),
    unknownCostSteps: calls
      .filter((call) => call.tableUnits === null)
      .map((call) => call.step),
    unverifiedSteps: calls
      .filter((call) => call.verification !== "confirmed")
      .map((call) => call.step),
  };
}

/** The one arithmetic check that stands between the plan and the balance. */
export function assertWithinSpend(plan: GoldenPlan, options: GoldenOptions): void {
  if (plan.assumedTotalUnits > options.spendUnits) {
    throw new GoldenRunError(
      "over_spend",
      `The plan comes to ${String(plan.assumedTotalUnits)} units and --spend is ${String(options.spendUnits)}. ` +
        "Nothing was called. Drop a step, or raise --spend if the balance really covers it.",
    );
  }
}

function unitsLabel(call: PlannedCall): string {
  if (call.tableUnits !== null) {
    return `${String(call.tableUnits)} units`;
  }
  return `unknown, counted as ${String(call.assumedUnits)}`;
}

export function formatPlan(plan: GoldenPlan, options: GoldenOptions): string {
  const lines: string[] = [];
  lines.push("Golden run plan");
  lines.push(`Image: ${options.imagePath}`);
  lines.push(`Output: ${options.outDir}`);
  lines.push("");
  lines.push("Calls, in order, one at a time:");
  lines.push("  0. Upload the selfie once. Free, no task is created.");
  for (const [index, call] of plan.calls.entries()) {
    lines.push(
      `  ${String(index + 1)}. ${call.label} [${call.step}] ${call.endpointKey} ${unitsLabel(call)}`,
    );
  }
  lines.push("");
  lines.push(
    `Planned spend: ${String(plan.assumedTotalUnits)} units against --spend ${String(options.spendUnits)}.`,
  );

  if (plan.unknownCostSteps.length > 0) {
    lines.push("");
    lines.push(
      `The cost table has no figure for: ${plan.unknownCostSteps.join(", ")}. ` +
        `Each is counted as ${String(options.assumeUnknownUnits)} units, which is a guess, not a price. ` +
        "Read the real figure from the API console (runbook A3) or raise it with --assume-unknown.",
    );
  }
  if (plan.unverifiedSteps.length > 0) {
    lines.push("");
    lines.push(
      `Not confirmed against the live docs: ${plan.unverifiedSteps.join(", ")}. ` +
        "The provider client refuses these unless PERFECTCORP_ALLOW_UNVERIFIED=true is set for this run.",
    );
  }

  lines.push("");
  lines.push("Deliberately not run:");
  for (const skipped of SKIPPED_ANALYSES) {
    lines.push(`  ${skipped.key}: ${skipped.reason}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* The image, without a decoder                                        */
/* ------------------------------------------------------------------ */

export interface ImageHeader {
  readonly contentType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Width, height, and format from the file header alone.
 *
 * Node ships no image decoder and this script is not allowed to add a
 * dependency, so the pixels stay unread. That is a real limit and it is written
 * down rather than worked around: see describeQualityGate below.
 *
 * Returns null for anything that is not a baseline or progressive JPEG or a
 * PNG, which is also the set of formats the provider accepts.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 24) {
    return null;
  }

  const isPng = PNG_SIGNATURE.every((value, index) => bytes[index] === value);
  if (isPng) {
    return {
      contentType: "image/png",
      width: readUint32(bytes, 16),
      height: readUint32(bytes, 20),
      byteLength: bytes.length,
    };
  }

  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  // Walk the JPEG marker segments to the frame header, which carries the size.
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      return null;
    }
    const length = readUint16(bytes, offset + 2);
    const isFrameHeader =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrameHeader) {
      return {
        contentType: "image/jpeg",
        height: readUint16(bytes, offset + 5),
        width: readUint16(bytes, offset + 7),
        byteLength: bytes.length,
      };
    }
    if (length < 2) {
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

function readUint16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) * 0x1000000 +
    (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
  );
}

/**
 * Checks the header against the image constraints of every endpoint the plan
 * will call. This is the only gate that can run here, and it is the one that
 * matters most: a frame the provider rejects for its size still costs the round
 * trip and the operator's afternoon.
 */
export function checkImageAgainstPlan(
  header: ImageHeader,
  plan: GoldenPlan,
): string[] {
  const problems: string[] = [];
  const longSide = Math.max(header.width, header.height);
  const shortSide = Math.min(header.width, header.height);

  for (const call of plan.calls) {
    const constraints = getEndpoint(call.endpointKey).imageConstraints;
    if (constraints === null) {
      continue;
    }
    if (!constraints.formats.includes(header.contentType)) {
      problems.push(
        `${call.endpointKey} takes ${constraints.formats.join(" or ")} and the file is ${header.contentType}.`,
      );
    }
    if (header.byteLength > constraints.maxBytes) {
      problems.push(
        `${call.endpointKey} takes at most ${String(constraints.maxBytes)} bytes and the file is ${String(header.byteLength)}.`,
      );
    }
    if (
      constraints.minShortSidePx !== null &&
      shortSide < constraints.minShortSidePx
    ) {
      problems.push(
        `${call.endpointKey} needs a short side of at least ${String(constraints.minShortSidePx)}px and the file has ${String(shortSide)}px.`,
      );
    }
    if (
      constraints.maxLongSidePx !== null &&
      longSide > constraints.maxLongSidePx
    ) {
      problems.push(
        `${call.endpointKey} takes a long side of at most ${String(constraints.maxLongSidePx)}px and the file has ${String(longSide)}px. Downscale it first.`,
      );
    }
  }
  return [...new Set(problems)];
}

/**
 * What the capture gate would have said, and why it cannot say it here.
 *
 * src/lib/shared/quality.ts measures sharpness and exposure over grayscale
 * pixels. Getting pixels out of a JPEG needs a decoder, and this repository does
 * not carry one, so the gate is advisory at this point in the pipeline: the real
 * one runs in the browser at capture time, over a canvas, before an upload.
 * The thresholds are printed so the operator can judge the frame by eye against
 * the same numbers the app uses.
 */
export function describeQualityGate(header: ImageHeader): string[] {
  return [
    `Image: ${header.contentType}, ${String(header.width)} by ${String(header.height)}, ${String(header.byteLength)} bytes.`,
    "The sharpness and exposure gate is advisory here and has not run: it reads pixels,",
    "Node has no image decoder, and no dependency is being added for one call.",
    "The gate that does run is the size and format check above, against the provider constraints.",
    `For the eye: the app rejects a face below sharpness ${String(SHARPNESS_REJECT_BELOW)},`,
    `mean luminance outside ${String(MEAN_LUMINANCE_REJECT_BELOW)} to ${String(MEAN_LUMINANCE_REJECT_ABOVE)},`,
    `or a face filling less than ${String(Math.round(FACE_COVERAGE_MIN * 100))} percent of the frame height.`,
  ];
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

/**
 * A .env file, parsed. Values are returned, never printed: every caller in this
 * file puts them straight into process.env and reads names only.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (name.length > 0) {
      values[name] = value;
    }
  }
  return values;
}

/**
 * Loads .env.local into process.env without overwriting anything already set,
 * so a value passed on the command line still wins. Returns the names it set,
 * never the values.
 */
export function loadEnvLocal(path = resolve(process.cwd(), ".env.local")): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const values = parseEnvFile(readFileSync(path, "utf8"));
  const applied: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] === undefined && value.length > 0) {
      process.env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}

/**
 * The kill switch, read strictly.
 *
 * src/lib/server/env.ts treats anything other than the string "false" as on,
 * which is the right default for a web request. A script that spends the whole
 * balance takes the opposite default: it runs only when the switch says "true"
 * in as many words.
 */
export type EnvValues = Readonly<Record<string, string | undefined>>;

export function assertProviderCallsEnabled(env: EnvValues = process.env): void {
  if (env.PROVIDER_CALLS_ENABLED !== "true") {
    throw new GoldenRunError(
      "provider_calls_disabled",
      'PROVIDER_CALLS_ENABLED is not "true". Set it in .env.local for this run and unset it afterwards.',
    );
  }
}

/** The names whose values must never reach a log line or an output file. */
export const SECRET_ENV_NAMES = [
  "PERFECTCORP_API_KEY",
  "PERFECTCORP_API_SECRET",
  "SERPAPI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "JUDGE_ACCESS_CODE_HASH",
] as const;

/**
 * Refuses to write text that carries a key value. The name of the variable is
 * reported; the value never is. Short values are ignored, because a two
 * character secret would match everything and mean nothing.
 */
export function assertNoSecret(text: string, env: EnvValues = process.env): void {
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.length >= 12 && text.includes(value)) {
      throw new GoldenRunError(
        "secret_in_output",
        `The value of ${name} appeared in something about to be written. Nothing was written.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* The fixture written for the eval loaders                            */
/* ------------------------------------------------------------------ */

const concernSchema = z.object({
  providerType: z.string(),
  key: z.string().nullable(),
  uiScore: z.number(),
  rawScore: z.number(),
});

/**
 * The shape of evals/fixtures/analyses/*.json, with one difference that matters:
 * synthetic is false, because this file is a recording of a real face and the
 * loader in that folder asserts the literal true for the hand written set. The
 * golden file therefore lives in its own folder and carries its provenance in
 * the _golden block. evals/golden/golden-run.test.ts checks the two shapes stay
 * in step.
 */
export const goldenFixtureSchema = z.object({
  id: z.string(),
  synthetic: z.literal(false),
  label: z.string(),
  note: z.string(),
  expected: z.object({
    fitzpatrick: z.number().nullable(),
    undertone: z.enum(["warm", "cool", "neutral"]).nullable(),
    topConcernKey: z.string(),
    skinType: z.enum(["combination", "oily", "dry", "balanced"]).nullable(),
  }),
  summaries: z.object({
    skin: z
      .object({
        concerns: z.array(concernSchema),
        skinAge: z.number().nullable(),
        overallScore: z.number().nullable(),
      })
      .nullable(),
    fitzpatrick: z.object({ fitzpatrick: z.number().nullable() }).nullable(),
    attributes: z
      .object({
        skinColor: z.string(),
        eyeColor: z.string(),
        eyeColorName: z.string(),
        lipColor: z.string(),
        eyebrowColor: z.string(),
        hairColor: z.string(),
        hairColorName: z.string(),
      })
      .nullable(),
    face_shape: z.object({ faceShape: z.string().nullable() }).nullable(),
    hair_type: z.unknown().nullable(),
  }),
  _golden: z.object({
    recordedOn: z.string(),
    captureId: z.string(),
    imageSha256: z.string(),
    stepsRun: z.array(z.string()),
    /**
     * True while nobody has checked the expected block by hand. It is filled
     * from the recording itself, which makes it a description of the run rather
     * than a label to test the run against.
     */
    expectedNeedsHumanReview: z.literal(true),
  }),
});

export type GoldenFixture = z.infer<typeof goldenFixtureSchema>;

/** The concern with the highest score, which is what the report leads on. */
export function topConcernKeyOf(summary: unknown): string | null {
  const parsed = z
    .object({ concerns: z.array(concernSchema) })
    .safeParse(summary);
  if (!parsed.success || parsed.data.concerns.length === 0) {
    return null;
  }
  const best = [...parsed.data.concerns].sort(
    (left, right) => right.uiScore - left.uiScore,
  )[0];
  if (best === undefined) {
    return null;
  }
  return best.key ?? best.providerType;
}

export interface BuildFixtureInput {
  readonly options: GoldenOptions;
  readonly imageSha256: string;
  readonly recordedOn: string;
  readonly stepsRun: readonly GoldenStep[];
  readonly summaries: Readonly<Partial<Record<AnalysisKind, unknown>>>;
}

/**
 * Turns what came back into the fixture the eval loaders read.
 *
 * Every expectation is derived from the recording, which is circular by nature,
 * so the file says so in _golden.expectedNeedsHumanReview and the runbook step
 * asks a person to confirm the values before anything is asserted against them.
 */
export function buildGoldenFixture(input: BuildFixtureInput): GoldenFixture {
  const skin = input.summaries.skin ?? null;
  const attributes = input.summaries.attributes ?? null;
  const faceShape = input.summaries.face_shape ?? null;

  const topConcernKey = topConcernKeyOf(skin);
  if (topConcernKey === null) {
    throw new GoldenRunError(
      "no_fixture",
      "The fixture needs a top concern, and the skin analysis did not produce one. The manifest was still written.",
    );
  }

  const skinToneHex = z
    .object({ skinColor: z.string() })
    .safeParse(attributes);

  const fixture = {
    id: input.options.fixtureId,
    synthetic: false as const,
    label: "Golden run, the founder's own capture",
    note:
      "Recorded once from a real Perfect Corp response against a consented selfie. " +
      "Every value here came off the wire; nothing is hand written. The Fitzpatrick and " +
      "hair type summaries are null because those two analyses were not run, which is a " +
      "budget decision recorded in docs/SUBMISSION-RUNBOOK.md, not a failure.",
    expected: {
      fitzpatrick: null,
      undertone: skinToneHex.success
        ? detectUndertone(skinToneHex.data.skinColor)
        : null,
      topConcernKey,
      skinType: null,
    },
    summaries: {
      skin: skin as GoldenFixture["summaries"]["skin"],
      fitzpatrick: null,
      attributes: attributes as GoldenFixture["summaries"]["attributes"],
      face_shape: faceShape as GoldenFixture["summaries"]["face_shape"],
      hair_type: null,
    },
    _golden: {
      recordedOn: input.recordedOn,
      captureId: input.options.captureId,
      imageSha256: input.imageSha256,
      stepsRun: [...input.stepsRun],
      expectedNeedsHumanReview: true as const,
    },
  };

  return goldenFixtureSchema.parse(fixture);
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface CallRecord {
  readonly step: GoldenStep;
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly taskId: string | null;
  readonly state: string;
  /** From the cost table, null while the table says unknown. */
  readonly tableUnits: number | null;
  /** Measured from the credit balance, null when the balance could not be read. */
  readonly measuredUnits: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** File names written under the output directory. No provider URL is kept. */
  readonly outputs: readonly string[];
  readonly error: string | null;
}

export interface GoldenRunIo {
  readonly log: (line: string) => void;
  readonly errorLog: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowIso: () => string;
  readonly readFile: (path: string) => Uint8Array;
  readonly writeFile: (path: string, bytes: Uint8Array | string) => void;
  readonly ensureDir: (path: string) => void;
  /** Returns true when the operator agreed to the plan. */
  readonly confirm: (question: string) => Promise<boolean>;
}

/** One poll every two seconds, until the provider's own task timeout. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * The credit balance, when the provider module can read it.
 *
 * getCreditBalance lands with the Perfect Corp auth work on its own branch. It
 * is looked up rather than imported so this script builds and runs either way:
 * with it, every call is priced from the real balance; without it, the cost
 * table is the only figure and the report says so.
 */
async function readBalanceUnits(): Promise<number | null> {
  let candidate: unknown;
  try {
    // A module namespace that does not carry the name can throw on the read
    // rather than answer undefined, so the probe itself is guarded.
    candidate = (perfectcorp as unknown as Record<string, unknown>)
      .getCreditBalance;
  } catch {
    return null;
  }
  if (typeof candidate !== "function") {
    return null;
  }
  try {
    const balance = (await (candidate as () => Promise<unknown>)()) as {
      readonly totalUnits?: unknown;
    };
    return typeof balance.totalUnits === "number" ? balance.totalUnits : null;
  } catch {
    // A balance read costs nothing and is not worth sinking a paid run over.
    return null;
  }
}

async function pollToTerminal(args: {
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly taskId: string;
  readonly io: GoldenRunIo;
}): Promise<TaskSnapshot> {
  const deadline = Date.now() + PERFECTCORP_TASK_TIMEOUT_MS;
  let snapshot = await getTaskSnapshot({
    endpointKey: args.endpointKey,
    taskId: args.taskId,
  });

  while (snapshot.state === "running") {
    if (Date.now() > deadline) {
      throw new GoldenRunError(
        "task_timeout",
        `The ${args.endpointKey} task was still running after the provider timeout. It may still finish and still cost its units.`,
      );
    }
    const waitSeconds = snapshot.pollingIntervalSeconds;
    await args.io.sleep(
      waitSeconds !== null && waitSeconds > 0 ? waitSeconds * 1000 : POLL_INTERVAL_MS,
    );
    snapshot = await getTaskSnapshot({
      endpointKey: args.endpointKey,
      taskId: args.taskId,
    });
  }

  if (snapshot.state !== "succeeded") {
    throw new GoldenRunError(
      "task_failed",
      `The ${args.endpointKey} task ended as ${snapshot.state}${snapshot.errorCode === null ? "" : ` (${snapshot.errorCode})`}. A failed task consumes no units.`,
    );
  }
  return snapshot;
}

function extensionFor(contentType: string): string {
  return contentType.includes("png") ? "png" : "jpg";
}

/**
 * The makeup shades for the one render, taken from the recorded tone through
 * the same palette and shade functions the makeup screen uses. Nothing here
 * chooses a colour: it reads the one the app would have offered.
 */
export interface MakeupShadeChoice {
  readonly category: string;
  readonly shadeHex: string;
  readonly shadeName: string;
}

export function makeupParamsFrom(args: {
  readonly attributesSummary: unknown;
  readonly captureId: string;
  readonly categories: readonly MakeupCategory[];
}): {
  readonly captureId: string;
  readonly categories: readonly MakeupShadeChoice[];
} | null {
  const parsed = z
    .object({
      skinColor: z.string(),
      eyeColor: z.string(),
      hairColor: z.string(),
    })
    .safeParse(args.attributesSummary);
  if (!parsed.success) {
    return null;
  }
  const undertone = detectUndertone(parsed.data.skinColor);
  if (undertone === null) {
    return null;
  }
  const palette = derivePalette({
    skinToneHex: parsed.data.skinColor,
    undertone,
    eyeColorHex: parsed.data.eyeColor,
    hairColorHex: parsed.data.hairColor,
    fitzpatrick: null,
  });
  const rows = buildMakeupCategoryViews({
    palette,
    skinToneHex: parsed.data.skinColor,
  });

  const categories: MakeupShadeChoice[] = [];
  for (const row of rows) {
    if (!args.categories.includes(row.category)) {
      continue;
    }
    const shade = row.shades[row.recommendedIndex] ?? row.shades[0];
    if (shade === undefined) {
      continue;
    }
    categories.push({
      category: row.category,
      shadeHex: shade.hex,
      shadeName: shade.name,
    });
  }

  if (categories.length === 0) {
    return null;
  }
  return { captureId: args.captureId, categories };
}

/**
 * The hairstyle request body.
 *
 * The catalog in src/lib/server/renders/hair.ts holds no template ids yet, so
 * hairstyleTaskBody refuses every style. --hairstyle-template lets the operator
 * pass one id read from the API playground, which costs nothing, and the body is
 * assembled with the field name from endpoints.ts so it stays the shape the
 * render layer will send once the catalog is filled.
 */
export function hairstyleBodyFor(args: {
  readonly fileId: string;
  readonly styleId: string;
  readonly templateId: string | null;
}): Record<string, unknown> | null {
  const templateId = args.templateId ?? hairstyleTemplateFor(args.styleId);
  if (templateId === null) {
    return null;
  }
  const endpoint = getEndpoint("hairstyleTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return { [fileField]: args.fileId, template_id: templateId };
}

interface RunState {
  spentUnits: number;
  balance: number | null;
  readonly balanceReadable: boolean;
}

/**
 * The whole run. Returns a process exit code: 0 when every planned call
 * succeeded, 1 for anything else. It never throws past this boundary, because
 * the spend report is more useful than a stack trace.
 */
export async function runGoldenRun(
  options: GoldenOptions,
  io: GoldenRunIo,
): Promise<number> {
  const plan = buildPlan(options);
  io.log(formatPlan(plan, options));
  io.log("");

  try {
    assertWithinSpend(plan, options);
  } catch (thrown) {
    io.errorLog(messageOf(thrown));
    return 1;
  }

  let imageBytes: Uint8Array;
  try {
    imageBytes = io.readFile(options.imagePath);
  } catch {
    io.errorLog(`The image at ${options.imagePath} could not be read.`);
    return 1;
  }

  const header = readImageHeader(imageBytes);
  if (header === null) {
    io.errorLog(
      "The image is not a JPEG or a PNG, which are the only formats the provider takes.",
    );
    return 1;
  }
  for (const line of describeQualityGate(header)) {
    io.log(line);
  }
  const imageProblems = checkImageAgainstPlan(header, plan);
  if (imageProblems.length > 0) {
    io.errorLog("");
    io.errorLog("The image does not satisfy the endpoints in the plan:");
    for (const problem of imageProblems) {
      io.errorLog(`  ${problem}`);
    }
    io.errorLog("Nothing was called.");
    return 1;
  }

  if (options.steps.includes("hairstyle")) {
    const preview = hairstyleBodyFor({
      fileId: "check",
      styleId: options.hairstyleStyleId,
      templateId: options.hairstyleTemplateId,
    });
    if (preview === null) {
      io.errorLog("");
      io.errorLog(
        `The hairstyle step has no provider template for "${options.hairstyleStyleId}". ` +
          "HAIRSTYLE_TEMPLATE_ID in src/lib/server/renders/hair.ts is still empty, so pass one " +
          "with --hairstyle-template after reading the catalog from the API playground, which costs nothing.",
      );
      io.errorLog("Nothing was called.");
      return 1;
    }
  }
  if (options.steps.includes("makeup") && !options.steps.includes("tone")) {
    io.errorLog("");
    io.errorLog(
      "The makeup step takes its shades from the tone step, so run tone in the same pass.",
    );
    io.errorLog("Nothing was called.");
    return 1;
  }

  io.log("");
  const agreed = options.confirm
    ? true
    : await io.confirm(
        `Spend up to ${String(plan.assumedTotalUnits)} units on this run? Type yes to go ahead: `,
      );
  if (!agreed) {
    io.log("Stopped before any call. Nothing was spent.");
    return 1;
  }

  const balanceBefore = await readBalanceUnits();
  const state: RunState = {
    spentUnits: 0,
    balance: balanceBefore,
    balanceReadable: balanceBefore !== null,
  };
  io.log(
    balanceBefore === null
      ? "The credit balance could not be read, so spend is counted from the cost table."
      : `Balance before the run: ${String(balanceBefore)} units.`,
  );

  io.ensureDir(options.outDir);
  io.ensureDir(resolve(options.outDir, "raw"));

  const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
  const records: CallRecord[] = [];
  const summaries: Partial<Record<AnalysisKind, unknown>> = {};
  let failed = false;

  try {
    const arrayBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    io.log("Uploading the selfie once. This creates no task and costs nothing.");
    const fileId = await uploadCapture({
      bytes: arrayBuffer,
      contentType: header.contentType,
      captureId: options.captureId,
    });

    for (const call of plan.calls) {
      const remaining = options.spendUnits - state.spentUnits;
      if (call.assumedUnits > remaining) {
        throw new GoldenRunError(
          "over_spend",
          `Stopping before ${call.step}: it counts as ${String(call.assumedUnits)} units and only ${String(remaining)} of the --spend ceiling is left.`,
        );
      }

      io.log("");
      io.log(`${call.step}: ${call.label}`);
      const startedAt = io.nowIso();
      const outputs: string[] = [];
      let taskId: string | null = null;

      try {
        const definition = GOLDEN_STEPS[call.step];
        if (definition.kind === "analysis") {
          const task = await startTask({
            kind: definition.analysisKind,
            fileId,
          });
          taskId = task.taskId;
          const snapshot = await pollToTerminal({
            endpointKey: call.endpointKey,
            taskId: task.taskId,
            io,
          });
          const normalized = normalize(definition.analysisKind, snapshot);
          summaries[definition.analysisKind] = normalized.summary;

          const rawName = `raw/${call.step}.json`;
          writeJson(io, resolve(options.outDir, rawName), normalized.raw);
          outputs.push(rawName);

          if (normalized.maskUrls.length > 0) {
            io.ensureDir(resolve(options.outDir, "masks"));
            const assets = await downloadResultAssets(
              normalized.maskUrls.map((mask) => mask.url),
            );
            for (const [index, asset] of assets.entries()) {
              const mask = normalized.maskUrls[index];
              if (mask === undefined) {
                continue;
              }
              const name = `masks/${mask.key}.${extensionFor(asset.contentType)}`;
              io.writeFile(
                resolve(options.outDir, name),
                new Uint8Array(asset.bytes),
              );
              outputs.push(name);
            }
          }
        } else {
          const body =
            call.step === "makeup"
              ? makeupBodyFor(fileId, summaries.attributes, options)
              : hairstyleBodyFor({
                  fileId,
                  styleId: options.hairstyleStyleId,
                  templateId: options.hairstyleTemplateId,
                });
          if (body === null) {
            throw new GoldenRunError(
              "no_request_body",
              `The ${call.step} request body could not be built from what has been recorded so far.`,
            );
          }
          const task = await createTask({
            endpointKey: call.endpointKey,
            body,
            itemCount: call.itemCount,
          });
          taskId = task.taskId;
          const snapshot = await pollToTerminal({
            endpointKey: call.endpointKey,
            taskId: task.taskId,
            io,
          });
          const urls = parseRenderUrls(snapshot);
          io.ensureDir(resolve(options.outDir, "renders"));
          const assets = await downloadResultAssets(urls);
          for (const [index, asset] of assets.entries()) {
            const name = `renders/${call.step}-${String(index + 1)}.${extensionFor(asset.contentType)}`;
            io.writeFile(
              resolve(options.outDir, name),
              new Uint8Array(asset.bytes),
            );
            outputs.push(name);
          }
        }

        const measured = await settleSpend(state, call);
        records.push({
          step: call.step,
          endpointKey: call.endpointKey,
          taskId,
          state: "succeeded",
          tableUnits: call.tableUnits,
          measuredUnits: measured,
          startedAt,
          finishedAt: io.nowIso(),
          outputs,
          error: null,
        });
        io.log(
          `  done, ${String(measured ?? call.assumedUnits)} units${measured === null ? " (from the table, not measured)" : ""}, ${String(outputs.length)} files written.`,
        );
      } catch (thrown) {
        const measured = await settleSpend(state, call, { failed: true });
        records.push({
          step: call.step,
          endpointKey: call.endpointKey,
          taskId,
          state: "failed",
          tableUnits: call.tableUnits,
          measuredUnits: measured,
          startedAt,
          finishedAt: io.nowIso(),
          outputs,
          error: messageOf(thrown),
        });
        throw thrown;
      }
    }
  } catch (thrown) {
    failed = true;
    io.errorLog("");
    io.errorLog(messageOf(thrown));
    io.errorLog("The run stopped here. No call is ever retried automatically.");
  }

  const recordedOn = io.nowIso();
  const stepsRun = records
    .filter((record) => record.state === "succeeded")
    .map((record) => record.step);

  let fixtureFile: string | null = null;
  if (summaries.skin !== undefined) {
    try {
      const fixture = buildGoldenFixture({
        options,
        imageSha256,
        recordedOn,
        stepsRun,
        summaries,
      });
      fixtureFile = `${options.fixtureId}.json`;
      writeJson(io, resolve(options.outDir, fixtureFile), fixture);
    } catch (thrown) {
      io.errorLog(`The fixture was not written: ${messageOf(thrown)}`);
      fixtureFile = null;
    }
  } else {
    io.log(
      "No skin analysis in this run, so no analyses fixture was written. The manifest still holds everything recorded.",
    );
  }

  const manifest = {
    recordedOn,
    captureId: options.captureId,
    fixtureFile,
    image: {
      sha256: imageSha256,
      contentType: header.contentType,
      width: header.width,
      height: header.height,
      byteLength: header.byteLength,
    },
    spend: {
      ceilingUnits: options.spendUnits,
      plannedUnits: plan.assumedTotalUnits,
      measured: state.balanceReadable,
      spentUnits: state.spentUnits,
      balanceBeforeUnits: balanceBefore,
      balanceAfterUnits: state.balance,
    },
    skippedAnalyses: SKIPPED_ANALYSES,
    calls: records,
  };
  writeJson(io, resolve(options.outDir, "manifest.json"), manifest);

  io.log("");
  io.log("Spend report");
  for (const record of records) {
    io.log(
      `  ${record.step}: ${record.state}, ${String(record.measuredUnits ?? record.tableUnits ?? "unknown")} units`,
    );
  }
  io.log(
    `  total: ${String(state.spentUnits)} units against a ceiling of ${String(options.spendUnits)}${state.balanceReadable ? "" : ", counted from the cost table because the balance could not be read"}.`,
  );
  io.log(`  written to: ${options.outDir}`);

  return failed ? 1 : 0;
}

function makeupBodyFor(
  fileId: string,
  attributesSummary: unknown,
  options: GoldenOptions,
): Record<string, unknown> | null {
  const params = makeupParamsFrom({
    attributesSummary,
    captureId: options.captureId,
    categories: options.makeupCategories,
  });
  if (params === null) {
    return null;
  }
  return makeupTaskBody({ fileId, params });
}

/**
 * Adds one call to the running spend. The balance is the truth when it can be
 * read; the cost table is the fallback. A failed task consumes no units, which
 * the balance reflects on its own.
 */
async function settleSpend(
  state: RunState,
  call: PlannedCall,
  options: { readonly failed?: boolean } = {},
): Promise<number | null> {
  if (!state.balanceReadable) {
    const counted = options.failed === true ? 0 : call.assumedUnits;
    state.spentUnits += counted;
    return null;
  }
  const now = await readBalanceUnits();
  if (now === null || state.balance === null) {
    const counted = options.failed === true ? 0 : call.assumedUnits;
    state.spentUnits += counted;
    return null;
  }
  const measured = Math.max(0, state.balance - now);
  state.balance = now;
  state.spentUnits += measured;
  return measured;
}

function writeJson(io: GoldenRunIo, path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertNoSecret(text);
  io.writeFile(path, text);
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message;
  }
  return String(thrown);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function realIo(): GoldenRunIo {
  return {
    log: (line) => {
      console.log(line);
    },
    errorLog: (line) => {
      console.error(line);
    },
    sleep: (ms) =>
      new Promise((done) => {
        setTimeout(done, ms);
      }),
    nowIso: () => new Date().toISOString(),
    readFile: (path) => new Uint8Array(readFileSync(path)),
    writeFile: (path, bytes) => {
      writeFileSync(path, bytes);
    },
    ensureDir: (path) => {
      mkdirSync(path, { recursive: true });
    },
    confirm: async (question) => {
      if (!process.stdin.isTTY) {
        return false;
      }
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await new Promise<string>((done) => {
          reader.question(question, done);
        });
        return answer.trim().toLowerCase() === "yes";
      } finally {
        reader.close();
      }
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const io = realIo();
  let options: GoldenOptions;
  try {
    loadEnvLocal();
    assertProviderCallsEnabled();
    options = parseArgs(argv);
  } catch (thrown) {
    io.errorLog(messageOf(thrown));
    io.errorLog(
      "Usage: npm run golden:run -- --image <path> --spend <units> [--steps skin,tone,attr] [--out <dir>] [--confirm]",
    );
    return 1;
  }
  return runGoldenRun(options, io);
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
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
