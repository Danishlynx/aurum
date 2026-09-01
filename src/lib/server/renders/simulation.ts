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
 * CONFIRMED, from src/lib/server/providers/perfectcorp/endpoints.ts: the ten
 * concerns the engine can simulate (radiance, acne, oiliness, eye bags, dark
 * circles, spots, pores, texture, wrinkles, redness), the 0.0 to 1.0 intensity
 * scale, the image limits, and the price (4 units for 1 to 4 concerns, 6 for 5
 * to 10).
 *
 * UNVERIFIED, and this is why the endpoint entry is marked unverified and the
 * render layer refuses to call it without PERFECTCORP_ALLOW_UNVERIFIED, exactly
 * as it refuses the hair colour try on:
 *
 *   1. the request field that carries the concern to intensity map,
 *   2. the result field that carries the render URL.
 *
 * The body below follows the shape of the confirmed neighbours (a source file id
 * plus one array of items), which is a guess about field names and is recorded
 * as one rather than presented as fact.
 *
 * TODO for the human: run one skin simulation from the API playground, record
 * the request field and the result field in endpoints.ts, mark the entry
 * confirmed, and correct this body if it differs. Nothing else has to change:
 * the moment the entry is confirmed, the row on /report can render.
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
 * Nine of the ten are the same word with our underscores. The tenth is theirs:
 * the reference page calls dark spots "spots".
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
  wrinkles: "wrinkles",
  dark_circles: "dark_circles",
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
 */
export function simulationTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredSkinSimulationParams;
}): Record<string, unknown> | null {
  const simulations = args.params.concerns
    .filter(isSimulatableConcern)
    .map((concern) => ({
      concern: PROVIDER_CONCERN_TOKEN[concern],
      intensity: SIMULATION_INTENSITY,
    }));
  if (simulations.length === 0) {
    return null;
  }

  const endpoint = getEndpoint("skinSimulation");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    simulations,
  };
}
