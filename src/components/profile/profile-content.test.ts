import { describe, expect, it } from "vitest";

import {
  ADJUSTER_QUERY_PARAM,
  ADJUSTER_QUERY_VALUE,
  adjusterRequestedByQuery,
  COLOR_ADJUSTER_HREF,
} from "@/components/color/color-content";
import { copy } from "@/lib/shared/copy";

import {
  affordanceHref,
  affordanceLabel,
  deleteArmed,
  summaryLabelId,
  summaryValueIsMissing,
  summaryValueLine,
} from "./profile-content";

describe("affordanceHref", () => {
  it("sends Retake to the capture screen", () => {
    expect(affordanceHref("retake")).toBe("/capture");
  });

  it("sends Adjust to the color screen with the adjuster asked for", () => {
    const href = affordanceHref("adjust");
    expect(href).toBe(COLOR_ADJUSTER_HREF);
    expect(href).toContain(`${ADJUSTER_QUERY_PARAM}=${ADJUSTER_QUERY_VALUE}`);
  });

  it("gives a row without an affordance nowhere to go", () => {
    expect(affordanceHref(null)).toBeNull();
  });
});

describe("the color screen reads the link the profile writes", () => {
  it("opens the adjuster for the value the affordance carries", () => {
    const query = new URL(COLOR_ADJUSTER_HREF, "https://example.test")
      .searchParams;
    expect(
      adjusterRequestedByQuery(query.get(ADJUSTER_QUERY_PARAM) ?? undefined),
    ).toBe(true);
  });

  it("leaves the adjuster closed for anything else", () => {
    expect(adjusterRequestedByQuery(undefined)).toBe(false);
    expect(adjusterRequestedByQuery("season")).toBe(false);
  });

  it("still opens when a browser repeated the parameter", () => {
    expect(adjusterRequestedByQuery(["season", ADJUSTER_QUERY_VALUE])).toBe(
      true,
    );
  });
});

describe("affordanceLabel", () => {
  it("uses the two words docs/01 section L item 1 gives", () => {
    expect(affordanceLabel("retake")).toBe(copy.profile.retakeAffordance);
    expect(affordanceLabel("adjust")).toBe(copy.profile.adjustAffordance);
    expect(affordanceLabel(null)).toBeNull();
  });
});

describe("summaryValueLine", () => {
  it("shows the reading when there is one", () => {
    expect(summaryValueLine("Combination")).toBe("Combination");
    expect(summaryValueIsMissing("Combination")).toBe(false);
  });

  it("says the reading is missing rather than showing a placeholder", () => {
    expect(summaryValueLine(null)).toBe(copy.profile.valueUnavailable);
    expect(summaryValueIsMissing(null)).toBe(true);
    expect(summaryValueLine(null)).not.toContain("-");
  });
});

describe("summaryLabelId", () => {
  it("gives every row its own id, so an affordance can point at its label", () => {
    const keys = [
      "skin_type",
      "top_concern",
      "tone_undertone",
      "season",
      "face_shape",
      "hair_type",
    ] as const;
    const ids = keys.map(summaryLabelId);
    expect(new Set(ids).size).toBe(keys.length);
  });
});

describe("deleteArmed", () => {
  it("arms only on the exact word the person is asked to type", () => {
    expect(deleteArmed(copy.profile.deleteConfirmWord)).toBe(true);
  });

  it("stays disarmed for an empty field, other case, or stray space", () => {
    expect(deleteArmed("")).toBe(false);
    expect(deleteArmed("delete")).toBe(false);
    expect(deleteArmed("DELETE ")).toBe(false);
    expect(deleteArmed("DELETE EVERYTHING")).toBe(false);
  });
});
