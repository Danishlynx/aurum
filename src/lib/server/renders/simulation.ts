import "server-only";

import {
  isSimulatableConcern,
  MAX_SIMULATED_CONCERNS,
  type SimulatableConcernKey,
} from "@/lib/shared/color-view";

import { getEndpoint } from "../providers/perfectcorp";
import type { StoredSkinSimulationParams } from "./params";

/**
 * The skin simulation request body: the person's own capture, with the concerns
 * the report ranked highest projected.
 *
 * The provider module owns the envelope, the task creation, and the polling.
 * This file owns the two things left: which concerns are asked for, and how they
 * are named to the provider. It is the Layer 6 twin of
 * src/lib/server/renders/hair.ts and src/lib/server/renders/cloth.ts.
 *
 * What this render is, and what it is not: docs/06-safety-privacy.md is explicit
 * that "Try on renders are labeled as previews. Skin simulation is labeled as a
 * projection." Nothing here promises a result, and the row on /report says so in
 * the person's own words (copy.report.projectionFraming). The picture is of the
 * person's own face, from their own capture, and there is no stand in image
 * anywhere in this path: with no key, an unverified endpoint, or a failed task,
 * the row falls back to copy.report.projectionUnavailable.
 *
 * CONFIRMED on 2026-09-02, and the correction is worth writing down because the
 * old body was not a wrong field name, it was the wrong shape entirely:
 *
 *     was:  { src_file_id, simulations: [{ concern, intensity }] }
 *     is:   { src_file_id, texture: 1, pores: 1, ... }
 *
 * There is no concern to intensity map. The concerns are top level fields on the
 * request itself, one per concern, each a number from 0.0 to 1.0, and at least
 * one has to be above zero. An unknown field is dropped rather than refused, so
 * the old body answered "Simulation intensity cannot be all zero": the whole
 * array went in the bin and nothing was left to simulate.
 *
 * Two of the ten names are singular where our own concern keys are plural, which
 * is exactly the kind of thing that only a probe finds: the endpoint says
 * wrinkle and dark_circle, and sending wrinkles and dark_circles lands in the
 * same bin as the array did. PROVIDER_CONCERN_TOKEN below is where that lives.
 *
 * Settled for free with the oracle the makeup and hair colour bodies were
 * settled with (src/lib/server/renders/makeup.ts): a task creation that is
 * rejected costs nothing, and a src_file_id the file service cannot resolve is
 * always rejected. The corrected body answers the generic "One or more
 * parameters in this request are invalid.", and an intensity of 5 answers
 * "texture is above the allowed maximum.", so the values are read and checked.
 * The result is data.results.url, the same single url the other renders return.
 *
 * Also confirmed, from endpoints.ts: the ten concerns the engine can simulate
 * (radiance, acne, oiliness, eye bags, dark circles, spots, pores, texture,
 * wrinkles, redness), the 0.0 to 1.0 scale, the image limits, and the price
 * (4 units for 1 to 4 concerns, 6 for 5 to 10).
 *
 * Still unwatched: what a projection looks like. Nobody has run one. The
 * endpoint is callable now, which means the row on /report draws its button, and
 * a tap on it spends 4 units.
 */

/**
 * How strongly each concern is projected, on the confirmed 0.0 to 1.0 scale.
 *
 * Full strength is the honest choice for a single picture: the row shows one
 * projection, not a slider, and a half strength projection presented without the
 * number would be a claim about degree that nothing supports.
 */
export const SIMULATION_INTENSITY = 1;

/**
 * Our concern key, in the provider's word for it.
 *
 * Three of the ten differ, and all three are recorded from the request schema
 * rather than guessed: dark spots are "spots", and wrinkles and dark circles are
 * singular, "wrinkle" and "dark_circle". A plural where the endpoint wants a
 * singular is not an error there. It is an unknown field, which is dropped, and
 * a request whose concerns were all dropped answers "Simulation intensity cannot
 * be all zero".
 */
export const PROVIDER_CONCERN_TOKEN: Readonly<
  Record<SimulatableConcernKey, string>
> = {
  dark_spots: "spots",
  texture: "texture",
  pores: "pores",
  oiliness: "oiliness",
  acne: "acne",
  redness: "redness",
  radiance: "radiance",
  wrinkles: "wrinkle",
  dark_circles: "dark_circle",
  eye_bags: "eye_bags",
};

/**
 * The concerns one projection asks for, taken from the report's own ranking.
 *
 * The order in is the tone first order the report shows
 * (src/lib/shared/concerns.ts). Anything the endpoint cannot simulate is dropped
 * rather than swapped for something it can, so the projection is a subset of
 * what the reading named and never a concern the person was not told about. The
 * result is capped at the cheaper credit tier.
 */
export function simulationConcernsFor(
  rankedConcernKeys: readonly string[],
): SimulatableConcernKey[] {
  const chosen: SimulatableConcernKey[] = [];
  for (const key of rankedConcernKeys) {
    if (!isSimulatableConcern(key) || chosen.includes(key)) {
      continue;
    }
    chosen.push(key);
    if (chosen.length === MAX_SIMULATED_CONCERNS) {
      break;
    }
  }
  return chosen;
}

/**
 * The body for one skin simulation. Returns null when no concern survived the
 * mapping, which the caller reads as "there is nothing to render" and refuses
 * before a credit is reserved.
 *
 * Null matters more here than it looks: a body with a source and no concern
 * above zero is a request the endpoint refuses anyway, so returning null costs
 * nothing and says the same thing one round trip earlier.
 */
export function simulationTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredSkinSimulationParams;
}): Record<string, unknown> | null {
  const endpoint = getEndpoint("skinSimulation");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  const body: Record<string, unknown> = { [fileField]: args.fileId };

  let asked = 0;
  for (const concern of args.params.concerns) {
    if (!isSimulatableConcern(concern)) {
      continue;
    }
    body[PROVIDER_CONCERN_TOKEN[concern]] = SIMULATION_INTENSITY;
    asked += 1;
  }
  if (asked === 0) {
    return null;
  }

  return body;
}
