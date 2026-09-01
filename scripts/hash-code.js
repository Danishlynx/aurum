#!/usr/bin/env node
/**
 * Prints a bcrypt hash of the judge access code so it can be pasted into
 * JUDGE_ACCESS_CODE_HASH. Referenced from .env.example.
 *
 * Usage: node scripts/hash-code.js "your-code"
 *
 * The code is read from argv and never written anywhere by this script. Copy
 * the printed hash into .env.local and into the Vercel project settings, keep
 * the plain code out of git, and hand the plain code to the judges on the
 * Devpost page. Rotating the code means running this again and replacing the
 * env value: existing sessions keep working until they expire.
 */

const ROUNDS = 12;

const USAGE = [
  'Usage: node scripts/hash-code.js "your-code"',
  "Pass the judge access code as the first argument, in quotes.",
].join("\n");

const MIN_LENGTH = 8;

async function main() {
  const code = process.argv[2];

  if (typeof code !== "string" || code.trim().length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (code.length < MIN_LENGTH) {
    console.error(
      `The access code must be at least ${MIN_LENGTH} characters. Got ${code.length}.`,
    );
    process.exitCode = 1;
    return;
  }

  const bcrypt = await import("bcryptjs");
  console.log(bcrypt.hashSync(code, ROUNDS));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
