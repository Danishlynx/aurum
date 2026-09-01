#!/usr/bin/env node
/**
 * Thin wrapper around the Supabase CLI so npm run db:migrate and npm run db:types
 * fail with a clear message instead of a shell error when the CLI is missing.
 */
import { spawnSync } from "node:child_process";

const MISSING =
  "supabase CLI required. Install it (https://supabase.com/docs/guides/local-development/cli/getting-started), run 'supabase login' and 'supabase link', then run this command again.";

const args = process.argv.slice(2);

const probe = spawnSync("supabase", ["--version"], {
  stdio: "ignore",
  shell: true,
});

if (probe.error !== undefined || probe.status !== 0) {
  console.error(MISSING);
  process.exit(1);
}

const run = spawnSync("supabase", args, { stdio: "inherit", shell: true });
process.exit(run.status ?? 1);
