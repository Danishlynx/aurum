import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { Analysis, AnalysisKind } from "@/lib/server/db/types";

/**
 * The 12 synthetic analysis sets, loaded and validated.
 *
 * docs/05-evals.md, eval:synthesis: "Runs the synthesis prompt over the 12
 * fixture analyses (recorded, no credits)."
 *
 * SYNTHETIC, every one of them. None of these came from a person or from a
 * provider. They are hand written to the shape src/lib/server/jobs/analysis.ts
 * stores on analyses.summary, which is the only shape the profile layer reads,
 * so they exercise that layer end to end with no key, no network, and no
 * database. See README.md in this folder.
 *
 * They are not a substitute for recorded responses. When a Perfect Corp key
 * exists, eval:consistency records real responses against real fixture faces
 * and the concern names in these files get corrected to whatever the provider
 * actually returns.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The kinds, repeated here so this loader pulls in no server only module. */
export const FIXTURE_ANALYSIS_KINDS: readonly AnalysisKind[] = [
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
  "hair_type",
];

const concernSchema = z.object({
  providerType: z.string(),
  key: z.string().nullable(),
  /**
   * Presence, 1 to 100, higher means more present. These twelve files were
   * always written that way; what changed on 2026-09-02 is that the provider
   * path now agrees, because presenceScoreFor in src/lib/shared/concerns.ts
   * inverts the provider's condition score before it reaches a summary.
   */
  uiScore: z.number(),
  /** The provider's own figure. Only a recorded fixture carries one. */
  providerUiScore: z.number().nullable().optional(),
  rawScore: z.number(),
});

const fixtureSchema = z.object({
  id: z.string(),
  synthetic: z.literal(true),
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
        /**
         * The provider's own skin type by zone. None of the twelve synthetic
         * files carry it, which is why it is optional: it arrived with the
         * first real response, on 2026-09-02, and the golden fixture written
         * from that response does carry it.
         */
        skinTypeZones: z
          .object({
            tZone: z.string().nullable(),
            cheeks: z.string().nullable(),
          })
          .nullable()
          .optional(),
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
});

export type AnalysisFixture = z.infer<typeof fixtureSchema>;

/** Every fixture, in id order. Throws when a file does not match the shape. */
export function loadAnalysisFixtures(): AnalysisFixture[] {
  const files = readdirSync(HERE)
    .filter((name) => name.endsWith(".json"))
    .sort();

  return files.map((name) => {
    const raw: unknown = JSON.parse(readFileSync(resolve(HERE, name), "utf8"));
    const parsed = fixtureSchema.safeParse(raw);
    if (!parsed.success) {
      const paths = parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ");
      throw new Error(`Fixture ${name} does not match the shape: ${paths}`);
    }
    return parsed.data;
  });
}

export function findFixture(id: string): AnalysisFixture {
  const found = loadAnalysisFixtures().find((fixture) => fixture.id === id);
  if (found === undefined) {
    throw new Error(`No analysis fixture with id ${id}`);
  }
  return found;
}

const ISO = "2026-09-01T00:00:00.000Z";

/**
 * The fixture as analyses rows, the way the jobs layer would have written them.
 * A summary of null becomes a failed analysis, which is how a partial capture
 * reaches the profile layer.
 */
export function fixtureAnalyses(
  fixture: AnalysisFixture,
  options: { readonly captureId?: string; readonly ownerId?: string } = {},
): Analysis[] {
  const captureId = options.captureId ?? `capture-${fixture.id}`;
  const ownerId = options.ownerId ?? `owner-${fixture.id}`;
  const summaries = fixture.summaries as Record<string, unknown>;

  return FIXTURE_ANALYSIS_KINDS.map((kind) => {
    const summary = summaries[kind] ?? null;
    const succeeded = summary !== null;
    return {
      id: `${fixture.id}-${kind}`,
      capture_id: captureId,
      user_id: ownerId,
      kind,
      status: succeeded ? "succeeded" : "failed",
      provider_task_id: succeeded ? `task-${fixture.id}-${kind}` : null,
      raw: null,
      summary: summary as Analysis["summary"],
      mask_paths: null,
      credits_used: succeeded ? 10 : 0,
      error: succeeded ? null : "This analysis did not run for the fixture.",
      created_at: ISO,
      updated_at: ISO,
    } satisfies Analysis;
  });
}
