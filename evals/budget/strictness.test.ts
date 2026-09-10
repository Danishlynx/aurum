import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { analysisTaskBody } from "@/lib/server/jobs/analysis";
import {
  DEFAULT_FACE_ANGLE_STRICTNESS,
  FACE_ANGLE_STRICTNESS_LEVELS,
} from "@/lib/server/providers/perfectcorp/schemas";
import {
  POSE_PITCH_MAX_DEGREES,
  POSE_PITCH_MIN_DEGREES,
  POSE_ROLL_MAX_DEGREES,
  POSE_SLACK_DEGREES,
  POSE_YAW_MAX_DEGREES,
} from "@/lib/shared/quality";

/**
 * eval:budget, the face angle tolerance the app actually asks for.
 *
 * This exists because of a silent regression that survived a whole deploy.
 *
 * On 2026-09-07 the default was moved from "high" (10 degrees on pitch, yaw and
 * roll together, which no handheld selfie reliably meets) to "flexible" (30).
 * It was moved in src/lib/server/providers/perfectcorp/index.ts, which builds
 * request bodies for the golden run script. The builder that runs when a person
 * takes a photograph is analysisTaskBody in src/lib/server/jobs/analysis.ts, and
 * it carried its own hardcoded "high". Every doc, comment, threshold and test
 * written that day said the app asks for 30 degrees. Every real capture went on
 * asking for 10, and nothing failed, because the literal agreed with nothing
 * except itself.
 *
 * The lesson is not "remember to change both". It is that a duplicated literal
 * in a request body is a place where belief and behaviour drift apart, silently,
 * in the direction that refuses photographs and costs units. So the constant is
 * asserted here against the path a person's capture really takes.
 */

const FILE_ID = "file-1234";

describe("the strictness the live capture path sends", () => {
  it("is the exported default, on every kind that gates on pose", () => {
    for (const kind of ["attributes", "face_shape"] as const) {
      const body = analysisTaskBody(kind, FILE_ID);
      expect(
        body.face_angle_strictness_level,
        `${kind} must send the shared default, not a literal of its own`,
      ).toBe(DEFAULT_FACE_ANGLE_STRICTNESS);
    }
  });

  it("is a level the provider actually publishes", () => {
    expect(FACE_ANGLE_STRICTNESS_LEVELS).toContain(
      DEFAULT_FACE_ANGLE_STRICTNESS,
    );
  });

  /**
   * The default is not merely "not high": it is the loosest the provider offers,
   * and that is a deliberate product decision. A person holding a phone at arm's
   * length spends the roll budget on the tilt of their hand before their head has
   * moved, and a refused task costs nothing, so the engine is the wrong place to
   * be strict. The client gate is where a genuinely unreadable pose is stopped.
   */
  it("is the loosest level, because the gate in front of it is the strict one", () => {
    expect(DEFAULT_FACE_ANGLE_STRICTNESS).toBe("flexible");
  });

  /**
   * And the client gate has to sit inside whatever is asked for here, or it
   * would be refusing frames the engine would have read. "flexible" is 30
   * degrees on all three axes.
   */
  it("leaves the client pose window inside it, with room to spare", () => {
    const FLEXIBLE_DEGREES = 30;
    expect(POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES).toBeLessThanOrEqual(
      FLEXIBLE_DEGREES,
    );
    expect(POSE_ROLL_MAX_DEGREES + POSE_SLACK_DEGREES).toBeLessThanOrEqual(
      FLEXIBLE_DEGREES,
    );
    expect(POSE_PITCH_MAX_DEGREES + POSE_SLACK_DEGREES).toBeLessThanOrEqual(
      FLEXIBLE_DEGREES,
    );
    expect(
      Math.abs(POSE_PITCH_MIN_DEGREES) + POSE_SLACK_DEGREES,
    ).toBeLessThanOrEqual(FLEXIBLE_DEGREES + POSE_SLACK_DEGREES);
  });

  it("sends no strictness on the kinds that do not take one", () => {
    // skin analysis has no such field, and fitzpatrick has a fixed rule with no
    // parameter. Sending one would be a body the provider did not ask for.
    for (const kind of ["skin", "fitzpatrick", "hair_type"] as const) {
      expect(
        analysisTaskBody(kind, FILE_ID).face_angle_strictness_level,
      ).toBeUndefined();
    }
  });
});
