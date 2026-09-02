import { describe, expect, it } from "vitest";

import { BACK_TARGETS, backTargetFor } from "./navigation";

/**
 * The back control table, docs/02-design-system.md "Screen skeleton" and
 * docs/01-user-flow.md "Screen map".
 *
 * The reasoning for every entry and every absence is written in navigation.ts.
 * These assertions pin the two things that would quietly rot: a screen losing
 * its way back, and a screen growing one that points at a guess.
 */

describe("backTargetFor, the screens that have a way back", () => {
  it("sends the consent screen back to the landing screen", () => {
    expect(backTargetFor("/welcome")).toBe("/");
  });

  it("sends the capture screen back to consent", () => {
    expect(backTargetFor("/capture")).toBe("/welcome");
  });

  it("sends the wardrobe back to looks, the only screen that links to it", () => {
    expect(backTargetFor("/wardrobe")).toBe("/looks");
  });
});

describe("backTargetFor, the screens that deliberately have none", () => {
  /**
   * The reveal. docs/01-user-flow.md section E: the photo is uploaded and the
   * jobs are running by the time this screen is on, and it leaves for /report on
   * its own. A back control there offers to abandon a reading already paid for.
   */
  it("gives the reveal no way to be abandoned mid job", () => {
    expect(backTargetFor("/analyzing")).toBeNull();
  });

  /**
   * The five roots of the bottom navigation. A person reaches any of them
   * without having come from anywhere, so there is no screen behind them.
   */
  it("gives the bottom navigation roots no back control", () => {
    for (const root of ["/report", "/color", "/makeup", "/hair", "/looks"]) {
      expect(backTargetFor(root)).toBeNull();
    }
  });

  /** Reached from the top right of all six other (app) screens. */
  it("gives the profile no back control", () => {
    expect(backTargetFor("/profile")).toBeNull();
  });

  it("gives the public screens none", () => {
    expect(backTargetFor("/")).toBeNull();
    expect(backTargetFor("/judge")).toBeNull();
  });
});

describe("backTargetFor, paths it was not given", () => {
  it("reads a trailing slash as the same screen", () => {
    expect(backTargetFor("/capture/")).toBe("/welcome");
    expect(backTargetFor("/")).toBeNull();
  });

  it("answers an unknown path with no control rather than a guess", () => {
    expect(backTargetFor("/nothing-here")).toBeNull();
    expect(backTargetFor("/capture/extra")).toBeNull();
  });

  it("points every target at a screen that exists", () => {
    const screens = new Set([
      "/",
      "/judge",
      "/welcome",
      "/capture",
      "/analyzing",
      "/report",
      "/color",
      "/makeup",
      "/hair",
      "/wardrobe",
      "/looks",
      "/profile",
    ]);
    for (const [from, to] of Object.entries(BACK_TARGETS)) {
      expect(screens.has(from)).toBe(true);
      expect(screens.has(to)).toBe(true);
      expect(from).not.toBe(to);
    }
  });
});
