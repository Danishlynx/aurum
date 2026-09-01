/**
 * The shape /report reads. One object, built on the server, consumed by a server
 * component. Nothing here does I/O, imports a provider, or touches the database.
 *
 * This file is the contract between three pieces of Layer 1:
 *   1. the profile builder (src/lib/server/profile/report-view.ts) fills it,
 *   2. the product grounding layer (src/lib/server/products) fills the listings,
 *   3. the report screen renders it and adds no data of its own.
 *
 * Spec: docs/01-user-flow.md section F (layout, states), docs/03-architecture.md
 * (request flow step 6), docs/06-safety-privacy.md (required framing, grounding
 * and honesty).
 *
 * Two rules the types themselves enforce:
 * - A product is a ReportListing or it is null. There is no half listing, so a
 *   step with no real listing can only render the "No listing found near you
 *   yet" state (docs/06-safety-privacy.md, "Grounding and honesty").
 * - A concern always carries its label and description, so no screen has to look
 *   copy up by key and no screen can invent a name.
 */

import { copy, formatSkinAge } from "./copy";

/**
 * One product listing, normalized from SerpApi. Present only when a real
 * listing came back with a URL and a price. Prices are shown exactly as
 * returned, never converted and never estimated.
 */
export type ReportListing = {
  title: string;
  priceText: string;
  priceValue: number | null;
  currency: string | null;
  url: string;
  imageUrl: string | null;
  store: string | null;
  distanceText: string | null;
};

/**
 * One row of the routine. docs/01-user-flow.md section F item 5: "step name, the
 * concern it addresses, one sentence of why, and a product card".
 *
 * productQuery is kept on the row because the empty state still names what to
 * look for, and because the same query is the product cache key.
 */
export type RoutineStepView = {
  stepName: string;
  concernKey: string;
  concernLabel: string;
  why: string;
  productQuery: string;
  product: ReportListing | null;
};

/** One row of the concern list, already ranked tone first. */
export type ConcernView = {
  key: string;
  label: string;
  description: string;
  /**
   * 1 to 100 as the provider reports it. docs/02-design-system.md: "A concern
   * score is a thin bar with the number in Sand small beside it, never a large
   * display figure."
   */
  score: number;
  /** 1 based, after the tone first ranking in src/lib/shared/concerns.ts. */
  rank: number;
  /** Short lived signed URL for the mask image, or null when there is none. */
  maskUrl: string | null;
};

export type ReportView = {
  /** Signed URL for the original selfie, null once retention has deleted it. */
  captureImageUrl: string | null;
  concerns: ConcernView[];
  reading: string;
  /** Where the reading came from. "fallback" means the deterministic text. */
  readingSource: "model" | "fallback";
  goingWell: string;
  /**
   * False when the attributes analysis did not return a tone, which is the
   * partial state in docs/01-user-flow.md section F.
   */
  toneReadingAvailable: boolean;
  skinTypeZones: { tZone: string | null; cheeks: string | null };
  skinAge: number | null;
  /**
   * True when redness or blemishes are among the detected concerns, which is
   * when docs/06-safety-privacy.md requires the escalation line once on the
   * report. The screen renders copy.report.seeSomeoneLine; this is the decision.
   *
   * Added to the shared contract by the profile builder because the decision is
   * about the analysis, not about the layout, and the screen must not have to
   * re read the concern list to make a safety call.
   */
  showDermatologistLine: boolean;
  routine: { morning: RoutineStepView[]; night: RoutineStepView[] };
};

/**
 * The skin age line, or null when there is no estimate.
 *
 * The number and the framing sentence docs/06-safety-privacy.md requires are
 * produced together by copy.formatSkinAge, so a screen cannot render one without
 * the other.
 */
export function reportSkinAgeLine(view: ReportView): string | null {
  return view.skinAge === null ? null : formatSkinAge(view.skinAge);
}

/** The escalation line when it applies, null when it does not. */
export function reportDermatologistLine(view: ReportView): string | null {
  return view.showDermatologistLine ? copy.report.seeSomeoneLine : null;
}

/** True when at least one routine step has a real listing to show. */
export function hasAnyListing(view: ReportView): boolean {
  return [...view.routine.morning, ...view.routine.night].some(
    (step) => step.product !== null,
  );
}
