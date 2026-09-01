/**
 * Seeds the demo profile that judge sessions fall back to once their cap is
 * used, and that every screenshot on the Devpost page is taken from.
 *
 * Spec: docs/07-payments-and-judge-mode.md, "Demo profile". A fixture profile
 * with a consented fixture capture, its real analyses and masks, a full
 * reading, saved makeup and hair renders, a six garment wardrobe, and two saved
 * looks for "Wedding guest" and "Interview". Product listings for the demo are
 * recorded responses so they never depend on live quota.
 *
 * Run it with: npx tsx scripts/seed-demo.ts
 *
 * State: scaffold only. The fixture set does not exist yet, because recording
 * it needs the Perfect Corp provider module (docs/09-build-order-and-demo.md,
 * Layer 0: "Seed script for the demo profile, fixture capture uploaded,
 * analyses recorded once the provider module works"). This script therefore
 * validates what it can, prints the plan, and exits non zero. It writes
 * nothing.
 *
 * Consent note: the fixture face belongs to a person who gave written consent
 * for the demo. No other person's photo is ever added to the fixture set, and
 * the fixture image is committed only if that consent is on file.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

/**
 * Owner id for every demo row. The demo profile is owned by a fixed id rather
 * than by an auth user, exactly like a judge session, so the same read paths
 * serve it. Nothing in auth.users has this id, which is why the tables that
 * carry user_id have no foreign key to auth.users.
 */
export const DEMO_OWNER_ID = "00000000-0000-4000-8000-000000000001";

/** Where the recorded fixture set lives once it has been captured. */
export const FIXTURE_DIR = resolve(
  process.cwd(),
  "evals",
  "fixtures",
  "demo-profile",
);

/** Manifest describing every file in FIXTURE_DIR. */
export const MANIFEST_PATH = resolve(FIXTURE_DIR, "manifest.json");

/**
 * Only the service role can write the demo profile: the rows are owned by an id
 * that no Supabase session ever holds, so row level security denies every
 * client role by design.
 */
const seedEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

export type SeedEnv = z.infer<typeof seedEnvSchema>;

const ANALYSIS_KINDS = [
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
  "hair_type",
] as const;

const RENDER_KINDS = [
  "makeup",
  "hairstyle",
  "hair_color",
  "cloth",
  "accessory",
] as const;

/**
 * The shape evals/fixtures/demo-profile/manifest.json must have. Every path is
 * relative to FIXTURE_DIR. Image bytes live on disk, never inline in the JSON.
 *
 * TODO: record this manifest once the Perfect Corp provider module can run a
 * real capture. Until then no field below has a stand in value, because a made
 * up analysis would put invented numbers on a screen that claims to read a real
 * face.
 */
export const fixtureManifestSchema = z.object({
  capture: z.object({
    image: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    quality: z.object({
      sharpness: z.number(),
      exposure: z.number(),
      face_coverage: z.number(),
    }),
  }),
  analyses: z
    .array(
      z.object({
        kind: z.enum(ANALYSIS_KINDS),
        summary: z.string().min(1),
        masks: z.array(z.string().min(1)),
      }),
    )
    .min(1),
  aestheticProfile: z.string().min(1),
  renders: z.array(
    z.object({
      kind: z.enum(RENDER_KINDS),
      params: z.string().min(1),
      image: z.string().min(1),
    }),
  ),
  garments: z.array(
    z.object({
      image: z.string().min(1),
      classification: z.string().min(1),
    }),
  ),
  looks: z.array(
    z.object({
      occasion: z.string().min(1),
      look: z.string().min(1),
    }),
  ),
  productCache: z.array(z.string().min(1)),
});

export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export interface SeedStep {
  /** Stable id so a partial re run can start from a step. */
  readonly id: string;
  /** What the step does, in one line. */
  readonly title: string;
  /** Tables and buckets the step writes. */
  readonly writes: readonly string[];
  /** What is still missing before the step can run. */
  readonly todo: string;
}

/**
 * The order matters: storage objects go up before the rows that point at them,
 * so a failure halfway leaves an orphaned object rather than a row pointing at
 * nothing.
 */
export const SEED_PLAN: readonly SeedStep[] = [
  {
    id: "capture",
    title: "Upload the fixture selfie and insert its captures row",
    writes: ["storage:captures", "public.captures"],
    todo: "Record one consented fixture selfie, downscaled to a 1024px long edge with EXIF stripped, and its SHA 256.",
  },
  {
    id: "analyses",
    title: "Insert the five analyses rows and upload their masks",
    writes: ["storage:masks", "public.analyses"],
    todo: "Run the real Perfect Corp calls once against the fixture capture and save the validated responses and mask images.",
  },
  {
    id: "aesthetic-profile",
    title: "Insert the aesthetic profile with palette and reading",
    writes: ["public.aesthetic_profiles"],
    todo: "Derive palette with the pure function, generate the reading once, and keep the output that passed the lexicon check.",
  },
  {
    id: "renders",
    title: "Upload the saved makeup and hair renders and insert their rows",
    writes: ["storage:renders", "public.renders"],
    todo: "Record one full makeup look, one hairstyle, and one hair color render, with the params each was produced from.",
  },
  {
    id: "wardrobe",
    title: "Upload six garment photos and insert their classified rows",
    writes: ["storage:garments", "public.garments"],
    todo: "Photograph six garments that cover casual, smart, and formal, and save the classifier output for each.",
  },
  {
    id: "looks",
    title: "Insert the two saved looks",
    writes: ["public.looks"],
    todo: 'Compose and save one "Wedding guest" look and one "Interview" look with their stylist rationales.',
  },
  {
    id: "product-cache",
    title: "Insert the recorded SerpApi responses",
    writes: ["public.product_cache"],
    todo: "Record real Google Shopping and local responses for the demo routine so the demo never depends on live quota.",
  },
] as const;

function readSeedEnv(): SeedEnv {
  const parsed = seedEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Environment is not ready. Check these values in .env.local: ${missing}`,
    );
  }

  return parsed.data;
}

function loadManifest(): FixtureManifest | null {
  if (!existsSync(MANIFEST_PATH)) {
    return null;
  }

  const raw: unknown = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  return fixtureManifestSchema.parse(raw);
}

function printPlan(): void {
  console.log("Demo profile seeding plan");
  console.log(`Owner id: ${DEMO_OWNER_ID}`);
  console.log(`Fixture directory: ${FIXTURE_DIR}`);
  console.log("");

  for (const [index, step] of SEED_PLAN.entries()) {
    console.log(`${index + 1}. ${step.title}`);
    console.log(`   id: ${step.id}`);
    console.log(`   writes: ${step.writes.join(", ")}`);
    console.log(`   todo: ${step.todo}`);
  }

  console.log("");
}

function main(): number {
  const manifest = loadManifest();

  if (manifest === null) {
    printPlan();
    console.error(
      [
        "Fixtures are not available, so nothing was seeded.",
        `Expected a manifest at ${MANIFEST_PATH}.`,
        "Record the fixture set first: see docs/07-payments-and-judge-mode.md, Demo profile, and docs/09-build-order-and-demo.md, Layer 0.",
      ].join("\n"),
    );
    return 1;
  }

  const env = readSeedEnv();

  console.error(
    [
      `A manifest was found with ${String(manifest.analyses.length)} analyses, ${String(manifest.garments.length)} garments, and ${String(manifest.looks.length)} looks.`,
      `Target project: ${env.NEXT_PUBLIC_SUPABASE_URL}`,
      "The writer is not implemented yet. It needs the Supabase service role client and the storage helpers from src/lib/server, which land with Layer 0.",
      "TODO: walk SEED_PLAN in order, uploading each object before inserting the row that points at it.",
    ].join("\n"),
  );

  return 1;
}

process.exitCode = main();
