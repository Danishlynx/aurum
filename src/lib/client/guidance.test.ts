import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";
import { FACE_COVERAGE_MIN } from "@/lib/shared/quality";

import {
  FACE_CENTER_TOO_LOW_ABOVE,
  MOTION_STILL_AT_OR_BELOW,
  guidanceKey,
  guidanceLine,
  type LiveFrameStats,
} from "./guidance";

/**
 * The live guidance line, docs/01-user-flow.md section D: one line at a time,
 * replaced as conditions change, never stacked.
 *
 * The one added on 2026-09-03 is the eye level line. The engine refused the
 * founder's photo with error_face_angle_downward, which is a phone held at chest
 * height, and the gate cannot measure a face angle. What it can see is a face
 * that has slid into the bottom of the frame, which is what that pose looks like
 * from here.
 */

/** A frame with nothing wrong with it: lit, framed, held still. */
const GOOD: LiveFrameStats = {
  meanLuminance: 140,
  faceCoverage: 0.7,
  faceCenterY: 0.42,
  motion: 1,
};

describe("guidanceKey", () => {
  it("says the frame is ready when nothing is wrong with it", () => {
    expect(guidanceKey(GOOD)).toBe("ready");
    expect(guidanceLine(GOOD)).toBe(copy.capture.guidance.ready);
  });

  it("asks for light first, because a dark frame breaks every other measure", () => {
    expect(
      guidanceKey({ ...GOOD, meanLuminance: 20, faceCenterY: 0.9, faceCoverage: 0.1 }),
    ).toBe("light");
  });

  it("asks for the phone at eye level when the face sits low in the frame", () => {
    expect(guidanceKey({ ...GOOD, faceCenterY: 0.7 })).toBe("eyeLevel");
    expect(guidanceLine({ ...GOOD, faceCenterY: 0.7 })).toBe(
      copy.capture.guidance.eyeLevel,
    );
  });

  it("leaves a face framed where a face belongs alone", () => {
    // A person holding the phone up has their face high in the picture, which is
    // the framing the auto crop aims at. Nothing to say about it.
    for (const centerY of [0.2, 0.35, 0.42, 0.5, FACE_CENTER_TOO_LOW_ABOVE]) {
      expect(guidanceKey({ ...GOOD, faceCenterY: centerY })).toBe("ready");
    }
  });

  it("answers the height of the phone before the distance", () => {
    /*
     * Lifting the phone moves the face inside the frame as well as squaring it
     * to the lens, so asking for the distance first would ask for two
     * corrections where one will do.
     */
    expect(
      guidanceKey({ ...GOOD, faceCenterY: 0.8, faceCoverage: 0.2 }),
    ).toBe("eyeLevel");
  });

  it("still asks for the distance when the face is where it should be", () => {
    expect(
      guidanceKey({ ...GOOD, faceCoverage: FACE_COVERAGE_MIN - 0.1 }),
    ).toBe("closer");
    expect(guidanceKey({ ...GOOD, faceCoverage: null, faceCenterY: null })).toBe(
      "closer",
    );
  });

  it("asks for stillness last of the three", () => {
    expect(
      guidanceKey({ ...GOOD, motion: MOTION_STILL_AT_OR_BELOW + 1 }),
    ).toBe("hold");
    expect(guidanceKey({ ...GOOD, motion: MOTION_STILL_AT_OR_BELOW })).toBe(
      "ready",
    );
  });

  it("says nothing about the phone when there is no face to measure", () => {
    // No estimate is not an estimate of a low face. The line that helps a person
    // with nothing in the frame is the one asking them to come closer.
    expect(guidanceKey({ ...GOOD, faceCenterY: null, faceCoverage: null })).toBe(
      "closer",
    );
    const withoutTheField: LiveFrameStats = {
      meanLuminance: 140,
      faceCoverage: 0.7,
      motion: 1,
    };
    expect(guidanceKey(withoutTheField)).toBe("ready");
  });

  it("has a line for every key it can return", () => {
    const keys = [
      "light",
      "eyeLevel",
      "closer",
      "hold",
      "ready",
    ] as const;
    // Written as escapes on purpose: this file lives under src, where the em
    // dash and en dash rule is enforced on the source itself.
    const dashes = /[\u2013\u2014]/u;
    for (const key of keys) {
      expect(copy.capture.guidance[key].length).toBeGreaterThan(0);
      expect(copy.capture.guidance[key]).not.toMatch(dashes);
    }
  });
});
