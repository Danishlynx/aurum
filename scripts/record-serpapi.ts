/**
 * Records the SerpApi responses the demo profile is served from.
 *
 * docs/07-payments-and-judge-mode.md: "Product listings for the demo are
 * recorded responses so they never depend on live quota." This script is how
 * those recordings are made, without a person copying JSON out of a browser
 * tab.
 *
 * It writes straight into src/lib/server/profile/recorded-listings, which is
 * where the demo profile reads them from: the fixture report, the fixture
 * looks, and the product_cache rows scripts/seed-demo.ts writes all go through
 * the loader in that folder. So a re recording is picked up with no second
 * edit, and there is no stale copy anywhere to disagree with it.
 *
 * What it searches for is not typed in here. It is read from the demo profile
 * itself: the routine steps the report would ground, and the gap queries the
 * looks screen would run for the two saved occasions, built by the same
 * functions the live screens use. So what gets recorded is exactly what the
 * demo would have asked for.
 *
 * The guard rails match the golden run: a plan first, a typed confirmation or
 * --confirm, a hard ceiling on the number of searches, one search at a time,
 * and a stop on the first failure. SerpApi bills per search, so the count is
 * the spend.
 *
 * Run it:
 *
 *     npm run golden:serpapi -- --max 12
 *
 * Documented in docs/SUBMISSION-RUNBOOK.md, section A14.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { DEMO_FIXTURE_PALETTE, DEMO_FIXTURE_REPORT_VIEW } from "@/lib/server/profile/demo-fixture";
import {
  DEMO_FIXTURE_LOOKS,
  DEMO_FIXTURE_SAVED_OCCASIONS,
} from "@/lib/server/profile/demo-fixture-looks";
import { gapQueryFor, paletteColorFor } from "@/lib/server/looks/gaps";
import {
  isSerpApiConfigured,
  readSerpApiConfig,
  serpApiSearch,
} from "@/lib/server/providers/serpapi/client";

import {
  GoldenRunError,
  assertNoSecret,
  assertProviderCallsEnabled,
  loadEnvLocal,
  realIo,
  type GoldenRunIo,
} from "./golden-run";

export type RecordIo = Pick<
  GoldenRunIo,
  "log" | "errorLog" | "nowIso" | "writeFile" | "ensureDir" | "confirm"
>;

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface RecordOptions {
  /** The hard ceiling on searches. SerpApi bills per search. */
  readonly max: number;
  readonly outDir: string;
  readonly confirm: boolean;
  /** City level location, when the recording should carry one. */
  readonly location: string | null;
  readonly gl: string | null;
  readonly hl: string | null;
  /** How many listings to ask for per search. */
  readonly limit: number;
}

export const DEFAULT_MAX_SEARCHES = 12;
/**
 * Where the demo profile reads its listings from, so a recording lands ready to
 * serve. See src/lib/server/profile/recorded-listings/README.md for why that is
 * under src rather than under evals.
 */
export const DEFAULT_RECORD_OUT_DIR = "src/lib/server/profile/recorded-listings";
const DEFAULT_LIMIT = 10;

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

export function parseRecordArgs(argv: readonly string[]): RecordOptions {
  let max = DEFAULT_MAX_SEARCHES;
  let outDir = DEFAULT_RECORD_OUT_DIR;
  let confirm = false;
  let location: string | null = null;
  let gl: string | null = null;
  let hl: string | null = null;
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--max":
        max = positiveInteger(flag, requireValue(flag, argv[index + 1]));
        index += 1;
        break;
      case "--out":
        outDir = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--confirm":
        confirm = true;
        break;
      case "--location":
        location = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--gl":
        gl = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--hl":
        hl = requireValue(flag, argv[index + 1]);
        index += 1;
        break;
      case "--limit":
        limit = positiveInteger(flag, requireValue(flag, argv[index + 1]));
        index += 1;
        break;
      default:
        throw new GoldenRunError("bad_argument", `Unknown argument ${String(flag)}.`);
    }
  }

  return { max, outDir, confirm, location, gl, hl, limit };
}

/* ------------------------------------------------------------------ */
/* What to search for                                                  */
/* ------------------------------------------------------------------ */

export interface RecordedQuery {
  readonly source: "routine" | "gap";
  /** Where it came from, for the manifest: a routine step or a missing piece. */
  readonly label: string;
  readonly query: string;
}

/**
 * The routine queries the demo report would ground, morning then night, in
 * screen order. buildDeterministicRoutine already produced them, so nothing is
 * rewritten here.
 */
export function routineQueries(): RecordedQuery[] {
  const view = DEMO_FIXTURE_REPORT_VIEW;
  const steps = [...view.routine.morning, ...view.routine.night];
  return steps
    .filter((step) => step.productQuery.trim().length > 0)
    .map((step) => ({
      source: "routine" as const,
      label: step.stepName,
      query: step.productQuery,
    }));
}

/**
 * The shop the gap queries for the two saved occasions, built by the same
 * gapQueryFor and paletteColorFor the looks screen calls, over the same demo
 * palette. A gap whose query cannot be built honestly is left out, exactly as
 * the screen leaves it out.
 */
export function gapQueries(): RecordedQuery[] {
  const found: RecordedQuery[] = [];
  for (const occasion of DEMO_FIXTURE_SAVED_OCCASIONS) {
    const view = DEMO_FIXTURE_LOOKS[occasion];
    for (const look of view.looks) {
      for (const [index, gap] of look.gaps.entries()) {
        const query = gapQueryFor({
          colorName: paletteColorFor(DEMO_FIXTURE_PALETTE, index),
          garmentType: gap.type,
          occasion,
        });
        if (query !== null) {
          found.push({
            source: "gap",
            label: `${occasion}: ${gap.type}`,
            query,
          });
        }
      }
    }
  }
  return found;
}

/** Every query, routine first, with duplicates dropped on the query text. */
export function collectQueries(): RecordedQuery[] {
  const seen = new Set<string>();
  const collected: RecordedQuery[] = [];
  for (const entry of [...routineQueries(), ...gapQueries()]) {
    if (seen.has(entry.query)) {
      continue;
    }
    seen.add(entry.query);
    collected.push(entry);
  }
  return collected;
}

/** The one arithmetic check between the plan and the quota. */
export function assertWithinMax(
  queries: readonly RecordedQuery[],
  options: RecordOptions,
): void {
  if (queries.length > options.max) {
    throw new GoldenRunError(
      "over_max",
      `The plan is ${String(queries.length)} searches and --max is ${String(options.max)}. ` +
        "Nothing was searched. Raise --max if the quota covers it.",
    );
  }
}

export function formatRecordPlan(
  queries: readonly RecordedQuery[],
  options: RecordOptions,
): string {
  const lines: string[] = [];
  lines.push("SerpApi recording plan");
  lines.push(`Output: ${options.outDir}`);
  lines.push(`Engine: google_shopping, ${String(options.limit)} listings per search.`);
  lines.push("");
  for (const [index, entry] of queries.entries()) {
    lines.push(`  ${String(index + 1)}. [${entry.source}] ${entry.label}: ${entry.query}`);
  }
  lines.push("");
  lines.push(
    `Planned searches: ${String(queries.length)} against --max ${String(options.max)}. One search is one unit of quota.`,
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Writing a response down                                             */
/* ------------------------------------------------------------------ */

export function slugFor(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug.length === 0 ? "query" : slug;
}

/**
 * Strips a response down to what may be committed, per
 * evals/fixtures/listings/README.md: no search_parameters, no serpapi_ account
 * fields anywhere, no api_key anywhere, and search_metadata cut to id and
 * status. What is left is the result payload the normalizer reads.
 */
export function stripResponse(body: unknown): unknown {
  const cleaned = stripKeys(body);
  if (typeof cleaned !== "object" || cleaned === null || Array.isArray(cleaned)) {
    return cleaned;
  }
  const record = { ...(cleaned as Record<string, unknown>) };
  delete record.search_parameters;

  const metadata = record.search_metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const source = metadata as Record<string, unknown>;
    record.search_metadata = {
      id: source.id ?? null,
      status: source.status ?? null,
    };
  }
  return record;
}

const STRIPPED_KEY = /^(serpapi_|api_key$)/u;

function stripKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (STRIPPED_KEY.test(key)) {
      continue;
    }
    out[key] = stripKeys(entry);
  }
  return out;
}

/** How many shopping results came back, for the manifest. */
export function countShoppingResults(body: unknown): number {
  const parsed = z
    .object({ shopping_results: z.array(z.unknown()).optional() })
    .safeParse(body);
  return parsed.success ? (parsed.data.shopping_results?.length ?? 0) : 0;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface RecordedEntry {
  readonly source: string;
  readonly label: string;
  readonly query: string;
  readonly engine: string;
  readonly file: string;
  readonly resultCount: number;
}

export async function runRecordSerpApi(
  options: RecordOptions,
  io: RecordIo,
): Promise<number> {
  const queries = collectQueries();
  io.log(formatRecordPlan(queries, options));
  io.log("");

  try {
    assertWithinMax(queries, options);
  } catch (thrown) {
    io.errorLog(messageOf(thrown));
    return 1;
  }

  if (queries.length === 0) {
    io.errorLog("The demo profile produced no queries, so there is nothing to record.");
    return 1;
  }

  if (!isSerpApiConfigured()) {
    io.errorLog("SERPAPI_API_KEY is not set, so no search was run.");
    return 1;
  }

  const agreed = options.confirm
    ? true
    : await io.confirm(
        `Run ${String(queries.length)} live searches? Type yes to go ahead: `,
      );
  if (!agreed) {
    io.log("Stopped before any search. No quota was used.");
    return 1;
  }

  const config = readSerpApiConfig();
  const gl = options.gl ?? config.defaultGl;
  const hl = options.hl ?? config.defaultHl;

  io.ensureDir(options.outDir);

  const recorded: RecordedEntry[] = [];
  let searchesRun = 0;
  let failed = false;

  for (const [index, entry] of queries.entries()) {
    if (searchesRun >= options.max) {
      io.errorLog(`Stopping: --max ${String(options.max)} searches has been reached.`);
      failed = true;
      break;
    }

    io.log(`  ${String(index + 1)}. ${entry.query}`);
    try {
      const body: unknown = await serpApiSearch({
        engineKey: "shopping",
        schema: z.unknown(),
        params: {
          q: entry.query,
          gl,
          hl,
          location: options.location ?? undefined,
          num: options.limit,
        },
      });
      searchesRun += 1;

      const stripped = stripResponse(body);
      const file = `${String(index + 1).padStart(2, "0")}-${slugFor(entry.query)}.json`;
      const text = `${JSON.stringify(stripped, null, 2)}\n`;
      assertNoSecret(text);
      io.writeFile(resolve(options.outDir, file), text);

      recorded.push({
        source: entry.source,
        label: entry.label,
        query: entry.query,
        engine: "google_shopping",
        file,
        resultCount: countShoppingResults(stripped),
      });
      io.log(`     ${String(recorded[recorded.length - 1]?.resultCount ?? 0)} results, saved as ${file}`);
    } catch (thrown) {
      searchesRun += 1;
      failed = true;
      io.errorLog("");
      io.errorLog(messageOf(thrown));
      io.errorLog("The run stopped here. No search is ever retried automatically.");
      break;
    }
  }

  const manifest = {
    recordedOn: io.nowIso(),
    synthetic: false,
    note:
      "Recorded once against the live engine by scripts/record-serpapi.ts. " +
      "search_parameters, the serpapi account fields, and everything in search_metadata " +
      "except id and status were stripped before writing, per evals/fixtures/listings/README.md.",
    gl,
    hl,
    location: options.location,
    limit: options.limit,
    searchesRun,
    entries: recorded,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSecret(manifestText);
  io.writeFile(resolve(options.outDir, "manifest.json"), manifestText);

  io.log("");
  io.log(
    `Searches run: ${String(searchesRun)} of a ceiling of ${String(options.max)}. Files written to ${options.outDir}.`,
  );
  return failed ? 1 : 0;
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message;
  }
  return String(thrown);
}

export async function main(argv: readonly string[]): Promise<number> {
  const io = realIo();
  let options: RecordOptions;
  try {
    loadEnvLocal();
    assertProviderCallsEnabled();
    options = parseRecordArgs(argv);
  } catch (thrown) {
    io.errorLog(messageOf(thrown));
    io.errorLog(
      "Usage: npm run golden:serpapi -- [--max 12] [--out <dir>] [--location <city>] [--confirm]",
    );
    return 1;
  }
  return runRecordSerpApi(options, io);
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
