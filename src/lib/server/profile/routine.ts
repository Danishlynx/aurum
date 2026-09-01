import "server-only";

import {
  concernDisplayName,
  type ConcernKey,
} from "@/lib/shared/concerns";
import { buildProductQuery } from "@/lib/server/providers/serpapi";

import type { SkinTypeReading } from "./skin-type";

/**
 * The rules routine: ranked concerns in, a small ordered routine out.
 *
 * docs/09-build-order-and-demo.md, Layer 1: "Routine rows with product queries".
 * docs/03-architecture.md, "Failure modes": when the Claude call fails the app
 * still shows a routine, built from the ranked concerns alone.
 *
 * Shape, fixed rather than generated:
 *   morning  cleanser, the step for the top concern, moisturizer, sunscreen
 *   night    cleanser, the step for the next concern, moisturizer
 *
 * Why the shape is fixed: a routine that changes wording between two visits
 * changes its product queries too, and a changed query is a product cache miss
 * and another SerpApi search (docs/03-architecture.md, "Caching"). Deterministic
 * steps mean the same person sees the same queries every time and the cache
 * does its job.
 *
 * The ingredient names and the one line reasons below are a catalog, in the
 * sense src/lib/shared/copy.ts uses the word: values that belong to the logic
 * that produces them, like palette colour names. Every one of them is run
 * through the banned lexicon by the eval suite. Every reason says what an
 * ingredient is for and none of them promises a result
 * (docs/06-safety-privacy.md, "Grounding and honesty").
 */

export const ROUTINE_PERIODS = ["morning", "night"] as const;
export type RoutinePeriod = (typeof ROUTINE_PERIODS)[number];

export interface RoutineStepPlan {
  readonly period: RoutinePeriod;
  readonly stepName: string;
  readonly concernKey: ConcernKey;
  readonly concernLabel: string;
  readonly why: string;
  readonly productQuery: string;
}

interface TargetedStep {
  /** The product type, which is also the first part of the search query. */
  readonly productType: string;
  readonly why: string;
  /** True when the step belongs at night rather than in the morning. */
  readonly nightOnly?: boolean;
}

/**
 * One targeted step per concern. Indexed by ConcernKey so a new concern cannot
 * be added without deciding what the routine does about it.
 */
const TARGETED: Readonly<Record<ConcernKey, TargetedStep>> = {
  pigmentation: {
    productType: "niacinamide serum",
    why: "Niacinamide is used for the look of gathered color.",
  },
  uneven_tone: {
    productType: "vitamin C serum",
    why: "Vitamin C is used in the morning for the look of even color.",
  },
  dark_spots: {
    productType: "alpha arbutin serum",
    why: "Alpha arbutin is used for the look of older marks.",
  },
  texture: {
    productType: "lactic acid exfoliant",
    why: "A gentle acid is used a few nights a week for the look of a smoother surface.",
    nightOnly: true,
  },
  pores: {
    productType: "salicylic acid serum",
    why: "Salicylic acid is used to keep pores looking clear.",
  },
  oiliness: {
    productType: "niacinamide serum",
    why: "Niacinamide is used where skin carries shine through the day.",
  },
  moisture: {
    productType: "hyaluronic acid serum",
    why: "Hyaluronic acid is used to hold water at the surface.",
  },
  acne: {
    productType: "salicylic acid gel",
    why: "Salicylic acid is used on the areas where marks come and go.",
  },
  redness: {
    productType: "centella soothing serum",
    why: "Centella is used where the surface reads warm and pink.",
  },
  radiance: {
    productType: "vitamin C serum",
    why: "Vitamin C is used in the morning for the light the surface gives back.",
  },
  firmness: {
    productType: "peptide serum",
    why: "Peptides are used for the look of a taut surface.",
  },
  wrinkles: {
    productType: "retinol serum",
    why: "Retinol is used at night for the look of fine lines.",
    nightOnly: true,
  },
  dark_circles: {
    productType: "caffeine eye serum",
    why: "Caffeine is used around the eye area for the look of shadows.",
  },
  eye_bags: {
    productType: "caffeine eye serum",
    why: "Caffeine is used around the eye area for the look of puffiness.",
  },
  tear_trough: {
    productType: "hydrating eye cream",
    why: "An eye cream is used to soften the look of the hollow under the eye.",
  },
  eyelid_droop: {
    productType: "hydrating eye cream",
    why: "An eye cream is used to keep the lid area comfortable.",
  },
};

const CLEANSER_BY_SKIN_TYPE: Readonly<Record<string, string>> = {
  oily: "gel cleanser",
  combination: "gel cleanser",
  dry: "cream cleanser",
  balanced: "gentle cleanser",
};

const MOISTURIZER_BY_SKIN_TYPE: Readonly<Record<string, string>> = {
  oily: "oil free gel moisturizer",
  combination: "light gel cream moisturizer",
  dry: "rich cream moisturizer",
  balanced: "light cream moisturizer",
};

const CLEANSER_WHY = "A cleanser sets a clean surface for the steps that follow.";
const MOISTURIZER_WHY = "A moisturizer holds water at the surface after the steps before it.";
const SUNSCREEN_WHY = "Sunscreen is used every morning, and it matters most for tone.";
const SUNSCREEN_TYPE = "broad spectrum sunscreen";

/** The words a query uses for the skin type when the analysis did not give one. */
export const ANY_SKIN_TYPE = "all skin types";

function queryFor(args: {
  readonly productType: string;
  readonly concernKey: ConcernKey;
  readonly skinType: string;
}): string {
  return buildProductQuery({
    kind: "skincare",
    ingredientOrType: args.productType,
    concern: concernDisplayName(args.concernKey).toLowerCase(),
    skinType: args.skinType,
  });
}

function step(args: {
  readonly period: RoutinePeriod;
  readonly productType: string;
  readonly concernKey: ConcernKey;
  readonly why: string;
  readonly skinType: string;
}): RoutineStepPlan {
  return {
    period: args.period,
    stepName: args.productType,
    concernKey: args.concernKey,
    concernLabel: concernDisplayName(args.concernKey),
    why: args.why,
    productQuery: queryFor({
      productType: args.productType,
      concernKey: args.concernKey,
      skinType: args.skinType,
    }),
  };
}

export interface RoutineInput {
  /** Ranked tone first. The first entry is the top concern. */
  readonly rankedKeys: readonly ConcernKey[];
  /** Keys that exist in the analysis but do not rank, for example moisture. */
  readonly qualityKeys: readonly ConcernKey[];
  readonly skinType: SkinTypeReading | null;
}

export interface RoutinePlan {
  readonly morning: readonly RoutineStepPlan[];
  readonly night: readonly RoutineStepPlan[];
}

/**
 * The concern a step points at when the step is not the targeted one. It has to
 * be a key the analysis actually returned, so the routine tag on the report
 * ("for pigmentation") always names something the person can see in the list.
 */
function pick(
  preferred: readonly ConcernKey[],
  available: ReadonlySet<ConcernKey>,
  fallback: ConcernKey,
): ConcernKey {
  for (const key of preferred) {
    if (available.has(key)) {
      return key;
    }
  }
  return fallback;
}

/**
 * The deterministic routine. Seven steps, always in the same order, always with
 * the same product queries for the same input.
 */
export function buildRoutine(input: RoutineInput): RoutinePlan {
  const top = input.rankedKeys[0] ?? null;
  if (top === null) {
    return { morning: [], night: [] };
  }
  const second = input.rankedKeys[1] ?? top;

  const available = new Set<ConcernKey>([...input.rankedKeys, ...input.qualityKeys]);
  const skinTypeLabel = input.skinType?.label ?? null;
  const skinTypeForQuery = skinTypeLabel ?? ANY_SKIN_TYPE;

  const cleanserType =
    (skinTypeLabel === null ? undefined : CLEANSER_BY_SKIN_TYPE[skinTypeLabel]) ??
    "gentle cleanser";
  const moisturizerType =
    (skinTypeLabel === null ? undefined : MOISTURIZER_BY_SKIN_TYPE[skinTypeLabel]) ??
    "light cream moisturizer";

  const cleanserConcern = pick(["oiliness", "texture", "acne"], available, top);
  const moisturizerConcern = pick(["moisture", "texture"], available, top);
  const sunscreenConcern = pick(
    ["pigmentation", "uneven_tone", "dark_spots"],
    available,
    top,
  );

  // A step marked nightOnly never lands in the morning, so a person whose top
  // concern is texture gets the acid at night and their next concern by day.
  const morningTargetKey =
    input.rankedKeys.find((key) => TARGETED[key].nightOnly !== true) ?? top;
  const nightTargetKey = second;

  const morning: RoutineStepPlan[] = [
    step({
      period: "morning",
      productType: cleanserType,
      concernKey: cleanserConcern,
      why: CLEANSER_WHY,
      skinType: skinTypeForQuery,
    }),
    step({
      period: "morning",
      productType: TARGETED[morningTargetKey].productType,
      concernKey: morningTargetKey,
      why: TARGETED[morningTargetKey].why,
      skinType: skinTypeForQuery,
    }),
    step({
      period: "morning",
      productType: moisturizerType,
      concernKey: moisturizerConcern,
      why: MOISTURIZER_WHY,
      skinType: skinTypeForQuery,
    }),
    step({
      period: "morning",
      productType: SUNSCREEN_TYPE,
      concernKey: sunscreenConcern,
      why: SUNSCREEN_WHY,
      skinType: skinTypeForQuery,
    }),
  ];

  const night: RoutineStepPlan[] = [
    step({
      period: "night",
      productType: cleanserType,
      concernKey: cleanserConcern,
      why: CLEANSER_WHY,
      skinType: skinTypeForQuery,
    }),
    step({
      period: "night",
      productType: TARGETED[nightTargetKey].productType,
      concernKey: nightTargetKey,
      why: TARGETED[nightTargetKey].why,
      skinType: skinTypeForQuery,
    }),
    step({
      period: "night",
      productType: moisturizerType,
      concernKey: moisturizerConcern,
      why: MOISTURIZER_WHY,
      skinType: skinTypeForQuery,
    }),
  ];

  return { morning, night };
}

/** Every step in one list, morning first. */
export function flattenRoutine(plan: RoutinePlan): RoutineStepPlan[] {
  return [...plan.morning, ...plan.night];
}

/** Every string a person reads in the routine, for the lexicon eval. */
export function routineStrings(): string[] {
  const values: string[] = [
    CLEANSER_WHY,
    MOISTURIZER_WHY,
    SUNSCREEN_WHY,
    SUNSCREEN_TYPE,
    ...Object.values(CLEANSER_BY_SKIN_TYPE),
    ...Object.values(MOISTURIZER_BY_SKIN_TYPE),
  ];
  for (const entry of Object.values(TARGETED)) {
    values.push(entry.productType, entry.why);
  }
  return values;
}
