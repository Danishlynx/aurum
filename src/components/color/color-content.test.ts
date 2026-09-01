import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";

import {
  adjusterOpensAutomatically,
  chunkIntoRows,
  DECIDES_ROWS,
  isRowOpen,
  undertoneLabel,
  UNDERTONE_OPTIONS,
  WEAR_SWATCHES_PER_ROW,
} from "./color-content";

describe("undertoneLabel", () => {
  it("names the detected undertone the way docs/01 section G item 1 does", () => {
    expect(undertoneLabel("warm")).toBe(copy.color.undertoneWarm);
    expect(undertoneLabel("cool")).toBe(copy.color.undertoneCool);
    expect(undertoneLabel("neutral")).toBe(copy.color.undertoneNeutral);
  });

  it("asks for a confirmation when the tone reading did not come back", () => {
    expect(undertoneLabel(null)).toBe(copy.color.confirmUndertone);
  });
});

describe("adjusterOpensAutomatically", () => {
  it("opens only when the undertone is unknown", () => {
    expect(adjusterOpensAutomatically(null)).toBe(true);
    expect(adjusterOpensAutomatically("warm")).toBe(false);
  });
});

describe("UNDERTONE_OPTIONS", () => {
  it("offers warm, cool, and neutral, each with its one line test", () => {
    expect(UNDERTONE_OPTIONS.map((option) => option.undertone)).toEqual([
      "warm",
      "cool",
      "neutral",
    ]);
    for (const option of UNDERTONE_OPTIONS) {
      expect(option.name.length).toBeGreaterThan(0);
      expect(option.test.length).toBeGreaterThan(0);
    }
  });
});

describe("chunkIntoRows", () => {
  it("fills rows in order and leaves the last one short", () => {
    expect(chunkIntoRows([1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8],
    ]);
  });

  it("returns no rows for no colors", () => {
    expect(chunkIntoRows([], WEAR_SWATCHES_PER_ROW)).toEqual([]);
  });

  it("never divides by a row size below one", () => {
    expect(chunkIntoRows([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("isRowOpen", () => {
  it("is true only for the row holding the open swatch", () => {
    expect(isRowOpen({ row: 1, column: 2 }, 1)).toBe(true);
    expect(isRowOpen({ row: 1, column: 2 }, 0)).toBe(false);
    expect(isRowOpen(null, 0)).toBe(false);
  });
});

describe("DECIDES_ROWS", () => {
  it("links makeup, hair, and looks with the lines from docs/01 section G", () => {
    expect(DECIDES_ROWS.map((row) => row.href)).toEqual([
      "/makeup",
      "/hair",
      "/looks",
    ]);
    expect(DECIDES_ROWS.map((row) => row.line)).toEqual([
      copy.color.decidesMakeup,
      copy.color.decidesHair,
      copy.color.decidesLooks,
    ]);
  });
});
