import "server-only";

import { z } from "zod";

import {
  concernDescription,
  concernDisplayName,
  CONCERNS_REQUIRING_ESCALATION_LINE,
  isConcernKey,
  isFitzpatrickType,
  type ConcernKey,
} from "@/lib/shared/concerns";
import type {
  ConcernView,
  ReportListing,
  ReportView,
  RoutineStepView,
} from "@/lib/shared/report-view";

import { getCapture, getProfile } from "../db";
import { BUCKETS, createSignedRead } from "../db/storage";
import { groundRoutineSteps } from "../products";
import type { AppSession } from "../session";
import { getAestheticProfile, readStoredConcerns, type AestheticProfile } from "./db";
import { DEMO_FIXTURE_REPORT_VIEW } from "./demo-fixture";
import {
  buildDeterministicRoutine,
  buildFallbackReading,
  buildGoingWell,
  FALLBACK_READING_MODEL,
} from "./fallback";
import { factsFromStoredProfile, type ProfileFacts } from "./facts";
import type { RoutineStepPlan } from "./routine";
import type { Undertone } from "./undertone";

/**
 * Everything /report needs, in one object.
 *
 * docs/01-user-flow.md section F is the layout this fills. The screen is a
 * server component that calls this and renders it; it adds no data of its own.
 *
 * The reading is the only part that comes from the stored row as text. The
 * concern list, the routine, and the going well line are rebuilt from the row
 * every time, which is what keeps the product queries stable between visits and
 * lets the product cache do its job (docs/03-architecture.md, "Caching").
 */

/** The environment variable that turns on fixture mode. */
export const DEMO_FIXTURE_ENV = "AURUM_DEMO_FIXTURE";

export function isDemoFixtureMode(): boolean {
  return process.env[DEMO_FIXTURE_ENV] === "true";
}

const zonesSchema = z.object({
  t_zone: z.string().nullable().optional(),
  cheeks: z.string().nullable().optional(),
});

const approxLocationSchema = z.object({
  city: z.string(),
  lat: z.number(),
  lng: z.number(),
});

const UNDERTONES: readonly Undertone[] = ["warm", "cool", "neutral"];

/** Exported for the colour layer, which reads the same column. */
export function readUndertone(value: string | null): Undertone | null {
  if (value === null) {
    return null;
  }
  return UNDERTONES.find((entry) => entry === value) ?? null;
}

function readZones(profile: AestheticProfile): {
  tZone: string | null;
  cheeks: string | null;
} {
  const parsed = zonesSchema.safeParse(profile.skin_type_zones);
  if (!parsed.success) {
    return { tZone: null, cheeks: null };
  }
  return {
    tZone: parsed.data.t_zone ?? null,
    cheeks: parsed.data.cheeks ?? null,
  };
}

/**
 * A signed URL, or null. A mask that cannot be signed is a missing illustration,
 * never a missing report.
 */
async function signOrNull(
  bucket: (typeof BUCKETS)[keyof typeof BUCKETS],
  storagePath: string | null,
): Promise<string | null> {
  if (storagePath === null) {
    return null;
  }
  try {
    return await createSignedRead(bucket, storagePath);
  } catch {
    return null;
  }
}

/** Exported so the colour layer can rebuild the reading from the same row. */
export function toFacts(profile: AestheticProfile): ProfileFacts {
  const zones = readZones(profile);
  const fitzpatrick =
    profile.fitzpatrick !== null && isFitzpatrickType(profile.fitzpatrick)
      ? profile.fitzpatrick
      : null;

  return factsFromStoredProfile({
    captureId: profile.capture_id ?? "",
    concerns: readStoredConcerns(profile),
    zones,
    skinAge: profile.skin_age,
    fitzpatrick,
    skinToneHex: profile.skin_tone_hex,
    eyeColorHex: profile.eye_color_hex,
    hairColorHex: profile.hair_color_hex,
    undertone: readUndertone(profile.undertone),
    faceShape: profile.face_shape,
  });
}

async function toConcernViews(profile: AestheticProfile): Promise<ConcernView[]> {
  const views: ConcernView[] = [];
  for (const stored of readStoredConcerns(profile)) {
    if (!isConcernKey(stored.key)) {
      continue;
    }
    const key: ConcernKey = stored.key;
    views.push({
      key,
      label: concernDisplayName(key),
      description: concernDescription(key),
      score: stored.score,
      rank: views.length + 1,
      maskUrl: await signOrNull(BUCKETS.masks, stored.mask_path),
    });
  }
  return views;
}

export interface GroundingContext {
  readonly location: { city: string; lat: number; lng: number } | null;
  readonly gl: string;
  readonly hl: string;
}

/**
 * Where to look for products. City level only, and only when the person allowed
 * location (docs/06-safety-privacy.md). A judge session has no profiles row and
 * therefore no location.
 *
 * gl and hl mirror the defaults in src/lib/server/providers/serpapi/client.ts.
 * They are read here rather than through readSerpApiConfig because that throws
 * without a key, and the report has to render without one.
 */
export async function readGroundingContext(
  session: AppSession,
): Promise<GroundingContext> {
  const gl = process.env.SERPAPI_DEFAULT_GL;
  const hl = process.env.SERPAPI_DEFAULT_HL;
  const context: GroundingContext = {
    location: null,
    gl: typeof gl === "string" && gl.length > 0 ? gl : "in",
    hl: typeof hl === "string" && hl.length > 0 ? hl : "en",
  };

  if (session.kind !== "user") {
    return context;
  }
  const profile = await getProfile(session.id);
  if (profile === null || !profile.location_consent) {
    return context;
  }
  const parsed = approxLocationSchema.safeParse(profile.approx_location);
  if (!parsed.success) {
    return context;
  }
  return { ...context, location: parsed.data };
}

function toStepView(
  plan: RoutineStepPlan,
  product: ReportListing | null,
): RoutineStepView {
  return {
    stepName: plan.stepName,
    concernKey: plan.concernKey,
    concernLabel: plan.concernLabel,
    why: plan.why,
    productQuery: plan.productQuery,
    product,
  };
}

/**
 * The report for the signed in person or the judge session.
 *
 * Returns null when there is no profile yet, which is the "nothing to show"
 * case: the caller sends the person to capture rather than rendering an empty
 * report.
 */
export async function buildReportView(
  session: AppSession,
): Promise<ReportView | null> {
  if (isDemoFixtureMode()) {
    console.log(
      JSON.stringify({
        event: "aurum.report_view",
        source: "fixture",
        note: `${DEMO_FIXTURE_ENV} is true: the report is served from the checked in fixture and no database or provider is touched.`,
      }),
    );
    return DEMO_FIXTURE_REPORT_VIEW;
  }

  const profile = await getAestheticProfile(session.id);
  if (profile === null) {
    return null;
  }

  const facts = toFacts(profile);
  const concerns = await toConcernViews(profile);

  const storedReading = profile.reading;
  const reading =
    storedReading !== null && storedReading.length > 0
      ? storedReading
      : (buildFallbackReading(facts) ?? "");
  // A stored reading is the model's only when the row says which model wrote it
  // and that tag is not the fallback one. The prefix covers a tag written by an
  // older prompt version; the equality covers the current one.
  const readingSource: ReportView["readingSource"] =
    storedReading !== null &&
    storedReading.length > 0 &&
    profile.reading_model !== null &&
    !profile.reading_model.startsWith("fallback/") &&
    profile.reading_model !== FALLBACK_READING_MODEL
      ? "model"
      : "fallback";

  const routine = buildDeterministicRoutine(facts);
  const steps = [...routine.morning, ...routine.night];

  const context = await readGroundingContext(session);
  let listings: (ReportListing | null)[] = steps.map(() => null);
  if (steps.length > 0) {
    try {
      listings = [
        ...(await groundRoutineSteps(
          steps.map((step) => ({ productQuery: step.productQuery })),
          {
            location: context.location,
            gl: context.gl,
            hl: context.hl,
            ownerType: session.ownerType,
            ownerId: session.id,
          },
        )),
      ];
    } catch {
      // docs/03-architecture.md, "Failure modes": with no listings the routine
      // still shows the product type and the "No listing found near you yet"
      // line. It never shows an invented product.
      listings = steps.map(() => null);
    }
  }

  const morning = routine.morning.map((plan, index) =>
    toStepView(plan, listings[index] ?? null),
  );
  const night = routine.night.map((plan, index) =>
    toStepView(plan, listings[routine.morning.length + index] ?? null),
  );

  const captureImageUrl =
    profile.capture_id === null
      ? null
      : await signOrNull(
          BUCKETS.captures,
          (await getCapture(session.id, profile.capture_id))?.storage_path ?? null,
        );

  return {
    captureImageUrl,
    concerns,
    reading,
    readingSource,
    goingWell: buildGoingWell(facts),
    toneReadingAvailable: profile.skin_tone_hex !== null,
    skinTypeZones: { tZone: facts.zones.tZone, cheeks: facts.zones.cheeks },
    skinAge: profile.skin_age,
    showDermatologistLine: concerns.some((concern) =>
      CONCERNS_REQUIRING_ESCALATION_LINE.includes(concern.key as ConcernKey),
    ),
    routine: { morning, night },
  };
}
