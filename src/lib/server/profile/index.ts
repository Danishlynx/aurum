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
 * Seven entry points, and nothing else outside this folder needs the rest:
 *   maybeBuildProfile     called by the jobs layer when analyses land
 *   buildReportView       called by the report screen
 *   buildColorView        called by the color screen and GET /api/profile/color
 *   buildMakeupView       called by the makeup screen and GET /api/profile/makeup
 *   buildProfileView      called by the profile screen and GET /api/profile
 *   buildProfileDownload  called by GET /api/profile/download
 *   deleteEverything      called by POST /api/profile/delete
 */

export { decideBuild, maybeBuildProfile, storedConcernKeys } from "./build";
export type { BuildOutcome, BuildResult } from "./build";
export {
  buildProfileDownload,
  PROFILE_DOWNLOAD_NOTE,
  ProfileDownloadError,
  type ProfileDownloadReads,
} from "./download";
export {
  deleteEverything,
  ownedObjectsOf,
  setKeepOriginals,
  type DeletedCounts,
  type DeleteEverythingOutcome,
  type DeleteEverythingSteps,
  type KeepOriginalsOutcome,
  type OwnedObjects,
} from "./delete";
export {
  buildProfileView,
  demoFixtureProfileView,
  savedHairRow,
  savedLookRow,
  skinTypeRowValue,
  toneRowValue,
  topConcernRowValue,
  toProfileRows,
} from "./view";
export {
  buildColorView,
  confirmUndertone,
  paletteForProfile,
} from "./color";
export type { UndertoneUpdateOutcome } from "./color";
export { getAestheticProfile, readStoredConcerns } from "./db";
export type { AestheticProfile, StoredConcern } from "./db";
export {
  DEMO_FIXTURE_COLOR_VIEW,
  DEMO_FIXTURE_MAKEUP_VIEW,
  DEMO_FIXTURE_PALETTE,
  DEMO_FIXTURE_READING,
  DEMO_FIXTURE_REPORT_VIEW,
} from "./demo-fixture";
export { buildMakeupView } from "./makeup";
export type { MakeupViewOptions, ShadeSelection } from "./makeup";
export { buildMakeupCategoryViews, selectedShade } from "./shades";
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
