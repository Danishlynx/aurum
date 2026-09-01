import "server-only";

/**
 * The profile layer: analyses in, one aesthetic profile out, and the object the
 * report screen renders.
 *
 * Spec: docs/03-architecture.md (request flow steps 6 and 7),
 * docs/04-integrations.md (Claude API, synthesis), docs/06-safety-privacy.md
 * (cosmetic never medical, regeneration and fallback),
 * docs/09-build-order-and-demo.md (Layer 1).
 *
 * Two entry points, and nothing else outside this folder needs the rest:
 *   maybeBuildProfile   called by the jobs layer when analyses land
 *   buildReportView     called by the report screen
 */

export { decideBuild, maybeBuildProfile, storedConcernKeys } from "./build";
export type { BuildOutcome, BuildResult } from "./build";
export { getAestheticProfile, readStoredConcerns } from "./db";
export type { AestheticProfile, StoredConcern } from "./db";
export { DEMO_FIXTURE_READING, DEMO_FIXTURE_REPORT_VIEW } from "./demo-fixture";
export {
  buildFallbackNarrative,
  buildFallbackReading,
  buildGoingWell,
  FALLBACK_READING_MODEL,
} from "./fallback";
export type { ProfileNarrative } from "./fallback";
export { factsFromStoredProfile, readProfileFacts, hasCoreAnalyses } from "./facts";
export type { ProfileFacts } from "./facts";
export { buildReportView, isDemoFixtureMode, DEMO_FIXTURE_ENV } from "./report-view";
export { buildRoutine, flattenRoutine } from "./routine";
export type { RoutinePlan, RoutineStepPlan } from "./routine";
export { runProfileSynthesis } from "./synthesis";
export type { SynthesisOutcome, SynthesisRunResult } from "./synthesis";
