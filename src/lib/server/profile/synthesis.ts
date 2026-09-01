import "server-only";

import type {
  SynthesisConcernInput,
  SynthesisInput,
  SynthesisOutput,
} from "@/lib/prompts/synthesis";
import { concernDisplayName, isConcernKey } from "@/lib/shared/concerns";

import { providerCallsEnabled } from "../env";
import { isAnthropicConfigured, runSynthesis } from "../providers/anthropic";
import {
  findReadingProblems,
  findSentenceProblems,
  MAX_ROUTINE_STEPS,
  MIN_ROUTINE_STEPS,
  sanitizeProductQuery,
} from "./checks";
import {
  buildDeterministicRoutine,
  buildFallbackNarrative,
  buildGoingWell,
  type ProfileNarrative,
} from "./fallback";
import { locationOf, type ProfileFacts } from "./facts";
import type { RoutineStepPlan } from "./routine";

/**
 * The synthesis pipeline: generate, check, regenerate once, fall back.
 *
 * docs/06-safety-privacy.md, "Regeneration and fallback": "A generated reading
 * that fails the lexicon check is regenerated once with the violations listed in
 * the prompt. A second failure uses the deterministic fallback built from ranked
 * concerns."
 *
 * The gate before any of that: with no ANTHROPIC_API_KEY, or with the kill
 * switch off, this never calls anything. It returns the deterministic narrative
 * and says so in the log line and in readingSource. It never invents a reading
 * and never pretends a model wrote one (docs/03-architecture.md, "Credits and
 * caps", the global kill switch).
 */

export type SynthesisOutcome =
  | "model"
  | "model_after_retry"
  | "fallback_not_configured"
  | "fallback_kill_switch"
  | "fallback_checks_failed"
  | "fallback_provider_error"
  | "fallback_no_concerns";

export interface SynthesisRunResult {
  readonly narrative: ProfileNarrative | null;
  readonly outcome: SynthesisOutcome;
  /** The checks the model output failed, for the log line. Never a person's data. */
  readonly problems: readonly string[];
  /**
   * The routine the model wrote, kept only so the decision to show the
   * deterministic one stays visible. See the note in build.ts: there is no
   * column for it, so nothing persists it.
   */
  readonly modelRoutine: readonly RoutineStepPlan[] | null;
}

/** The input the prompt takes, built from the deterministic facts. */
export function toSynthesisInput(
  facts: ProfileFacts,
  firstName: string | null,
): SynthesisInput {
  const concerns: SynthesisConcernInput[] = facts.ranked.map((concern) => ({
    key: concern.key,
    label: concernDisplayName(concern.key),
    score: concern.score,
    rank: concern.rank,
    zone: locationOf(facts, concern.key),
  }));

  const zones: Record<string, string> = {};
  if (facts.zones.tZone !== null) {
    zones.t_zone = facts.zones.tZone;
  }
  if (facts.zones.cheeks !== null) {
    zones.cheeks = facts.zones.cheeks;
  }

  return {
    firstName,
    fitzpatrick: facts.fitzpatrick,
    skinToneHex: facts.skinToneHex,
    undertone: facts.undertone,
    skinAge: facts.skinAge,
    overallScore: facts.overallScore,
    skinTypeZones: zones,
    concerns,
  };
}

/** Everything wrong with one model answer, as sentences a prompt can reuse. */
export function findSynthesisProblems(
  output: SynthesisOutput,
  facts: ProfileFacts,
): string[] {
  const problems: string[] = [];
  const top = facts.ranked[0];
  if (top === undefined) {
    return ["there are no concerns to write about"];
  }

  problems.push(
    ...findReadingProblems(output.reading, {
      topConcernName: concernDisplayName(top.key),
    }),
  );
  problems.push(...findSentenceProblems(output.going_well, "the going well line"));
  problems.push(
    ...findSentenceProblems(output.top_concern_location, "the concern location"),
  );

  if (output.top_concern_key !== top.key) {
    problems.push(
      `top_concern_key has to be "${top.key}", which is the concern ranked 1`,
    );
  }

  const known = new Set<string>(facts.ranked.map((concern) => concern.key));
  for (const quality of facts.qualities) {
    known.add(quality.key);
  }

  const steps = output.routine;
  if (steps.length < MIN_ROUTINE_STEPS || steps.length > MAX_ROUTINE_STEPS) {
    problems.push(
      `the routine has ${String(steps.length)} steps and it has to have ${String(
        MIN_ROUTINE_STEPS,
      )} to ${String(MAX_ROUTINE_STEPS)}`,
    );
  }
  if (!steps.some((step) => step.period === "morning")) {
    problems.push("the routine has no morning step");
  }
  if (!steps.some((step) => step.period === "night")) {
    problems.push("the routine has no night step");
  }

  for (const step of steps) {
    if (!known.has(step.concern_key)) {
      problems.push(
        `the routine step "${step.step_name}" points at concern_key "${step.concern_key}", which was not in the input`,
      );
    }
    problems.push(...findSentenceProblems(step.why, `the reason for "${step.step_name}"`));
    problems.push(
      ...findSentenceProblems(step.step_name, `the step name "${step.step_name}"`),
    );
    if (sanitizeProductQuery(step.product_query) === null) {
      problems.push(
        `the product query for "${step.step_name}" is empty once it is cleaned`,
      );
    }
  }

  return problems;
}

/** The model's routine, cleaned, for the record. Unknown keys are dropped. */
function toModelRoutine(output: SynthesisOutput): RoutineStepPlan[] {
  const steps: RoutineStepPlan[] = [];
  for (const step of output.routine) {
    if (!isConcernKey(step.concern_key)) {
      continue;
    }
    const query = sanitizeProductQuery(step.product_query);
    if (query === null) {
      continue;
    }
    steps.push({
      period: step.period,
      stepName: step.step_name,
      concernKey: step.concern_key,
      concernLabel: concernDisplayName(step.concern_key),
      why: step.why,
      productQuery: query,
    });
  }
  return steps;
}

function fallbackResult(
  facts: ProfileFacts,
  outcome: SynthesisOutcome,
  problems: readonly string[] = [],
): SynthesisRunResult {
  const narrative = buildFallbackNarrative(facts);
  return {
    narrative,
    outcome: narrative === null ? "fallback_no_concerns" : outcome,
    problems,
    modelRoutine: null,
  };
}

export interface SynthesisRunOptions {
  readonly firstName?: string | null;
  /**
   * The model call, injected so the pipeline can be exercised with no key.
   * Defaults to the real one.
   */
  readonly call?: typeof runSynthesis;
}

/**
 * One reading for one person.
 *
 * Worst case this makes two calls, one original and one regeneration, each of
 * which the provider module may retry once on a malformed answer. After that it
 * stops and uses the deterministic text.
 */
export async function runProfileSynthesis(
  facts: ProfileFacts,
  options: SynthesisRunOptions = {},
): Promise<SynthesisRunResult> {
  if (facts.ranked.length === 0) {
    return fallbackResult(facts, "fallback_no_concerns");
  }
  if (!providerCallsEnabled()) {
    return fallbackResult(facts, "fallback_kill_switch");
  }

  const call = options.call ?? runSynthesis;
  if (options.call === undefined && !isAnthropicConfigured()) {
    return fallbackResult(facts, "fallback_not_configured");
  }

  const input = toSynthesisInput(facts, options.firstName ?? null);
  let lastProblems: readonly string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: Awaited<ReturnType<typeof runSynthesis>>;
    try {
      result = await call(
        input,
        attempt === 1 ? undefined : { lexiconViolations: lastProblems },
      );
    } catch {
      // The typed provider error is already logged by the provider module. The
      // person still gets a report, which is the whole point of the fallback.
      return fallbackResult(facts, "fallback_provider_error", lastProblems);
    }

    const problems = findSynthesisProblems(result.value, facts);
    if (problems.length === 0) {
      const top = facts.ranked[0];
      if (top === undefined) {
        return fallbackResult(facts, "fallback_no_concerns");
      }
      return {
        narrative: {
          reading: result.value.reading,
          // The deterministic line, not the model's, even here. Only the
          // reading has a column on aesthetic_profiles, so the going well line
          // is recomputed every time the report is built. Taking the model's
          // now would mean the report showed one sentence today and a different
          // one on the next visit.
          goingWell: buildGoingWell(facts),
          topConcernKey: top.key,
          topConcernLocation: locationOf(facts, top.key),
          routine: buildDeterministicRoutine(facts),
          source: "model",
          readingModel: result.readingModel,
        },
        outcome: attempt === 1 ? "model" : "model_after_retry",
        problems: lastProblems,
        modelRoutine: toModelRoutine(result.value),
      };
    }
    lastProblems = problems;
  }

  return fallbackResult(facts, "fallback_checks_failed", lastProblems);
}
