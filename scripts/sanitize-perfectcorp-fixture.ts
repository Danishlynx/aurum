/**
 * Turns a recorded Perfect Corp response into a fixture that can be committed.
 *
 * Why this exists. The one real skin analysis response we own sits under
 * evals/fixtures/golden/raw, which is gitignored, because every mask URL in it
 * is a signed S3 link that names the account's bucket, its key id, and its
 * signature, and because the masks beside it are of a real face. The schema and
 * the normalizer still have to be tested against the real shape and the real
 * numbers, so this script produces a copy with every URL replaced and nothing
 * else touched.
 *
 * What it does, exactly:
 *
 * - Every string that parses as an http or https URL becomes the replacement
 *   (https://example.invalid/mask.png by default). Nothing else is rewritten:
 *   scores, types, regions, and the envelope stay byte for byte what came back.
 * - The result is scanned before it is written. A host, a signature parameter,
 *   or a bearer looking token that survived means nothing is written at all.
 *
 * It reaches no network, needs no key, and spends nothing.
 *
 * Run it:
 *
 *     npm run fixtures:sanitize -- --in evals/fixtures/golden/raw/skin/result.json --out evals/fixtures/perfectcorp/skin-analysis-status.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_URL_REPLACEMENT = "https://example.invalid/mask.png";

export class SanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SanitizeError";
  }
}

/** True for the strings this script is here to remove. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value.trim());
}

/**
 * Replaces every http or https string anywhere in the value. Objects and arrays
 * are rebuilt rather than mutated, so the input file is never modified.
 */
export function sanitizeProviderJson(
  value: unknown,
  replacement: string = DEFAULT_URL_REPLACEMENT,
): unknown {
  if (typeof value === "string") {
    return isHttpUrl(value) ? replacement : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProviderJson(entry, replacement));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeProviderJson(entry, replacement);
    }
    return out;
  }
  return value;
}

/**
 * Anything that must never reach a committed file. The check runs over the text
 * about to be written, not over the parsed value, so a leak inside a key name
 * or a nested string is caught too.
 */
export const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  { label: "an amazonaws host", pattern: /amazonaws/iu },
  { label: "a signed URL parameter", pattern: /x-amz-/iu },
  { label: "a perfectcorp or makeupar host", pattern: /(perfectcorp|makeupar)/iu },
  { label: "an authorization header", pattern: /bearer\s+\S/iu },
  { label: "an http URL that is not example.invalid", pattern: /https?:\/\/(?!example\.invalid)/iu },
];

/** The labels of every forbidden pattern found. Empty means the text is clean. */
export function findLeaks(text: string): string[] {
  return FORBIDDEN_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.label,
  );
}

export interface SanitizeArgs {
  readonly inPath: string;
  readonly outPath: string;
  readonly replacement: string;
}

export function parseSanitizeArgs(argv: readonly string[]): SanitizeArgs {
  let inPath: string | null = null;
  let outPath: string | null = null;
  let replacement = DEFAULT_URL_REPLACEMENT;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    const need = (): string => {
      if (next === undefined || next.length === 0 || next.startsWith("--")) {
        throw new SanitizeError(`${String(flag)} needs a value.`);
      }
      return next;
    };
    if (flag === "--in") {
      inPath = need();
      index += 1;
      continue;
    }
    if (flag === "--out") {
      outPath = need();
      index += 1;
      continue;
    }
    if (flag === "--replacement") {
      replacement = need();
      index += 1;
      continue;
    }
    throw new SanitizeError(`Unknown argument ${String(flag)}.`);
  }

  if (inPath === null || outPath === null) {
    throw new SanitizeError("Both --in and --out are required.");
  }
  return { inPath, outPath, replacement };
}

export function sanitizeFileText(text: string, replacement: string): string {
  const parsed: unknown = JSON.parse(text.replace(/^﻿/u, ""));
  const clean = sanitizeProviderJson(parsed, replacement);
  const out = `${JSON.stringify(clean, null, 2)}\n`;
  const leaks = findLeaks(out);
  if (leaks.length > 0) {
    throw new SanitizeError(
      `The sanitized text still carries ${leaks.join(", ")}. Nothing was written.`,
    );
  }
  return out;
}

export function main(argv: readonly string[]): number {
  let args: SanitizeArgs;
  try {
    args = parseSanitizeArgs(argv);
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    console.error(
      "Usage: npm run fixtures:sanitize -- --in <recorded.json> --out <fixture.json> [--replacement <url>]",
    );
    return 1;
  }

  try {
    const text = sanitizeFileText(readFileSync(args.inPath, "utf8"), args.replacement);
    mkdirSync(dirname(resolve(args.outPath)), { recursive: true });
    writeFileSync(resolve(args.outPath), text, "utf8");
    console.log(`Wrote ${args.outPath} from ${args.inPath}, every URL replaced.`);
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
  process.exitCode = main(process.argv.slice(2));
}
