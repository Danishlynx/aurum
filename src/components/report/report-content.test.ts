import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";
import { isLexiconClean } from "@/lib/shared/lexicon";
import type { ConcernView } from "@/lib/shared/report-view";

import {
  defaultConcernKey,
  hasHeroContent,
  orderedConcerns,
  readingBlockContent,
  scoreBarPercent,
  splitSentences,
} from "./report-content";

/**
 * The report screen's own decisions, tested without a renderer.
 * Spec: docs/01-user-flow.md section F, docs/02-design-system.md ReadingBlock,
 * docs/06-safety-privacy.md "Required framing".
 */

function concern(
  key: string,
  rank: number,
  overrides: Partial<ConcernView> = {},
): ConcernView {
  return {
    key,
    label: key,
    description: "A one line plain description.",
    score: 50,
    rank,
    maskUrl: null,
    ...overrides,
  };
}

describe("splitSentences", () => {
  it("splits on a period and keeps the punctuation", () => {
    expect(splitSentences("One thing. Another thing.")).toEqual([
      "One thing.",
      "Another thing.",
    ]);
  });

  it("splits on a question mark", () => {
    expect(splitSentences("Not quite right? Pick what is true.")).toEqual([
      "Not quite right?",
      "Pick what is true.",
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(splitSentences("   ")).toEqual([]);
  });

  it("does not split a decimal or an abbreviation followed by no space", () => {
    expect(splitSentences("A 1.5 percent lactic acid.")).toEqual([
      "A 1.5 percent lactic acid.",
    ]);
  });
});

describe("readingBlockContent", () => {
  const goingWell = "Your texture and pores are in good shape.";

  it("keeps a short reading whole and adds the going well line", () => {
    const result = readingBlockContent({
      reading: "Your skin is combination. Pigmentation sits on the cheekbones.",
      goingWell,
    });
    expect(result.reading).toBe(
      "Your skin is combination. Pigmentation sits on the cheekbones.",
    );
    expect(result.goingWell).toBe(goingWell);
  });

  it("never renders more than five sentences in total", () => {
    const reading =
      "One sentence. Two sentences. Three sentences. Four sentences. Five sentences. Six sentences.";
    const result = readingBlockContent({ reading, goingWell });
    const total =
      splitSentences(result.reading).length +
      (result.goingWell === null ? 0 : splitSentences(result.goingWell).length);
    expect(total).toBe(5);
    expect(result.reading).toBe(
      "One sentence. Two sentences. Three sentences. Four sentences.",
    );
  });

  it("does not repeat the going well line when the reading already says it", () => {
    const reading = `Your skin is combination. ${goingWell}`;
    const result = readingBlockContent({ reading, goingWell });
    expect(result.goingWell).toBeNull();
    expect(result.reading).toBe(reading);
  });

  it("treats an empty going well line as nothing to add", () => {
    const result = readingBlockContent({
      reading: "Your skin is combination.",
      goingWell: "   ",
    });
    expect(result.goingWell).toBeNull();
  });

  it("keeps at least one sentence of the reading whatever the limit", () => {
    const result = readingBlockContent(
      { reading: "One sentence. Two sentences.", goingWell },
      1,
    );
    expect(result.reading).toBe("One sentence.");
  });
});

describe("the lines the report is required to carry", () => {
  it("uses the exact escalation line from docs/06-safety-privacy.md", () => {
    // The screen renders this string when ReportView.showDermatologistLine is
    // true. The decision lives on the server; this checks the sentence it maps
    // to has not drifted from the doc.
    expect(copy.report.seeSomeoneLine).toBe(
      "If something on your skin is painful, spreading, or worrying you, a dermatologist is the right person to ask.",
    );
    expect(isLexiconClean(copy.report.seeSomeoneLine)).toBe(true);
  });

  it("says the tone reading is unavailable in the doc's words", () => {
    expect(copy.report.toneUnavailable).toBe(
      "Tone reading is unavailable for this photo. Color identity will ask you to confirm your undertone.",
    );
  });
});

describe("defaultConcernKey", () => {
  it("picks the top ranked concern whatever order the list arrives in", () => {
    expect(
      defaultConcernKey([
        concern("texture", 3),
        concern("pigmentation", 1),
        concern("pores", 2),
      ]),
    ).toBe("pigmentation");
  });

  it("returns null when nothing was detected", () => {
    expect(defaultConcernKey([])).toBeNull();
  });
});

describe("hasHeroContent", () => {
  it("is true while the selfie is still stored", () => {
    expect(
      hasHeroContent({
        captureImageUrl: "https://example.supabase.co/capture.jpg",
        concerns: [concern("pigmentation", 1)],
      }),
    ).toBe(true);
  });

  it("is true when a mask survives the deleted selfie", () => {
    expect(
      hasHeroContent({
        captureImageUrl: null,
        concerns: [
          concern("pigmentation", 1, { maskUrl: "https://example.com/m.png" }),
        ],
      }),
    ).toBe(true);
  });

  it("is false once retention has removed the selfie and there is no mask", () => {
    expect(
      hasHeroContent({
        captureImageUrl: null,
        concerns: [concern("pigmentation", 1), concern("texture", 2)],
      }),
    ).toBe(false);
  });

  it("is false for a report with nothing in it at all", () => {
    expect(hasHeroContent({ captureImageUrl: null, concerns: [] })).toBe(false);
  });
});

describe("scoreBarPercent", () => {
  it("passes a score inside the scale through", () => {
    expect(scoreBarPercent(64)).toBe(64);
  });

  it("clamps a score outside the 1 to 100 scale", () => {
    expect(scoreBarPercent(140)).toBe(100);
    expect(scoreBarPercent(-3)).toBe(0);
  });

  it("rounds so the bar width is a whole percentage", () => {
    expect(scoreBarPercent(63.6)).toBe(64);
  });

  it("draws nothing for a value that is not a number", () => {
    expect(scoreBarPercent(Number.NaN)).toBe(0);
  });
});

describe("orderedConcerns", () => {
  it("orders by rank without changing the input", () => {
    const input = [concern("texture", 2), concern("pigmentation", 1)];
    expect(orderedConcerns(input).map((entry) => entry.key)).toEqual([
      "pigmentation",
      "texture",
    ]);
    expect(input.map((entry) => entry.key)).toEqual(["texture", "pigmentation"]);
  });
});
