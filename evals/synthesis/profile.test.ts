import { describe, expect, it, vi } from "vitest";

/** See the note in synthesis.test.ts: this replaces the server-only marker. */
vi.mock("server-only", () => ({}));

import { fixtureAnalyses, findFixture } from "../fixtures/analyses";
import { findReadingProblems } from "@/lib/server/profile/checks";
import { decideBuild } from "@/lib/server/profile/build";
import type { AestheticProfile } from "@/lib/server/profile/db";
import {
  DEMO_FIXTURE_CONCERNS,
  DEMO_FIXTURE_READING,
  DEMO_FIXTURE_REPORT_VIEW,
} from "@/lib/server/profile/demo-fixture";
import { buildFallbackNarrative, FALLBACK_READING_MODEL } from "@/lib/server/profile/fallback";
import { readProfileFacts, type ProfileFacts } from "@/lib/server/profile/facts";
import { deriveSkinType, skinTypeFromZones } from "@/lib/server/profile/skin-type";
import {
  runProfileSynthesis,
  type SynthesisRunOptions,
} from "@/lib/server/profile/synthesis";
import { detectUndertone, hueOf } from "@/lib/server/profile/undertone";
import { concernDisplayName } from "@/lib/shared/concerns";
import { checkLexicon, REQUIRED_SKIN_AGE_FRAMING } from "@/lib/shared/lexicon";
import { reportDermatologistLine, reportSkinAgeLine } from "@/lib/shared/report-view";
import type { SynthesisOutput } from "@/lib/prompts/synthesis";
import type { SynthesisCallResult } from "@/lib/server/providers/anthropic";

/**
 * eval:synthesis, second half: the pipeline around the reading rather than the
 * reading itself.
 *
 * docs/06-safety-privacy.md, "Regeneration and fallback", is the behaviour under
 * test: generate, check, regenerate once with the problems listed, then fall
 * back to the deterministic text. Every path is exercised with an injected model
 * call, so the whole file runs with no ANTHROPIC_API_KEY, no network, and no
 * database.
 */

const A09 = findFixture("a09");

function factsFor(id: string): ProfileFacts {
  const fixture = findFixture(id);
  const captureId = `capture-${id}`;
  return readProfileFacts({
    captureId,
    analyses: fixtureAnalyses(fixture, { captureId }),
  });
}

const FACTS = factsFor(A09.id);

/** The injected model call, typed from the option the pipeline exposes. */
type SynthesisCall = NonNullable<SynthesisRunOptions["call"]>;

function modelResult(output: SynthesisOutput): SynthesisCallResult {
  return {
    value: output,
    model: "claude-sonnet-5",
    usage: { inputTokens: 900, outputTokens: 300 },
    attempts: 1,
    promptVersion: "synthesis-v2",
    readingModel: "claude-sonnet-5/synthesis-v2",
  };
}

const CLEAN_OUTPUT: SynthesisOutput = {
  reading: DEMO_FIXTURE_READING,
  top_concern_key: "pigmentation",
  top_concern_location: "cheekbones",
  going_well: "Your texture and pores are in good shape.",
  routine: [
    {
      period: "morning",
      step_name: "gel cleanser",
      concern_key: "oiliness",
      why: "A gel cleanser lifts oil without stripping the surface.",
      product_query: "gel cleanser for oiliness combination",
    },
    {
      period: "morning",
      step_name: "niacinamide serum",
      concern_key: "pigmentation",
      why: "Niacinamide is used for the look of gathered color.",
      product_query: "niacinamide serum for pigmentation combination",
    },
    {
      period: "morning",
      step_name: "broad spectrum sunscreen",
      concern_key: "pigmentation",
      why: "Sunscreen is used every morning, and it matters most for tone.",
      product_query: "broad spectrum sunscreen for pigmentation combination",
    },
    {
      period: "night",
      step_name: "alpha arbutin serum",
      concern_key: "dark_spots",
      why: "Alpha arbutin is used for the look of older marks.",
      product_query: "alpha arbutin serum for dark spots combination",
    },
  ],
};

/** Two rule breaks at once: a banned judgment word and an exclamation mark. */
const DIRTY_OUTPUT: SynthesisOutput = {
  ...CLEAN_OUTPUT,
  reading:
    "Your skin is combination: oilier through the T zone, drier on the cheeks. " +
    "Pigmentation on the cheekbones is the main thing to work on, and this routine will cure it. " +
    "Your texture is flawless.",
};

describe("eval:synthesis, the pipeline", () => {
  it("uses the model answer when it passes every check", async () => {
    const call = vi.fn(async () => modelResult(CLEAN_OUTPUT));
    const result = await runProfileSynthesis(FACTS, { call });

    expect(result.outcome).toBe("model");
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.narrative?.reading).toBe(DEMO_FIXTURE_READING);
    expect(result.narrative?.source).toBe("model");
    expect(result.narrative?.readingModel).toBe("claude-sonnet-5/synthesis-v2");
  });

  it("regenerates once with the problems listed, then uses the second answer", async () => {
    const call = vi
      .fn<SynthesisCall>()
      .mockResolvedValueOnce(modelResult(DIRTY_OUTPUT))
      .mockResolvedValueOnce(modelResult(CLEAN_OUTPUT));

    const result = await runProfileSynthesis(FACTS, { call });

    expect(result.outcome).toBe("model_after_retry");
    expect(call).toHaveBeenCalledTimes(2);

    const secondOptions = call.mock.calls[1]?.[1];
    const listed = secondOptions?.lexiconViolations ?? [];
    expect(listed.join(" ")).toContain("cure");
    expect(listed.join(" ")).toContain("flawless");
    expect(result.narrative?.reading).toBe(DEMO_FIXTURE_READING);
  });

  it("falls back to the deterministic reading when the second answer also fails", async () => {
    const call = vi.fn(async () => modelResult(DIRTY_OUTPUT));
    const result = await runProfileSynthesis(FACTS, { call });

    expect(result.outcome).toBe("fallback_checks_failed");
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.narrative?.source).toBe("fallback");
    expect(result.narrative?.readingModel).toBe(FALLBACK_READING_MODEL);
    expect(result.narrative?.reading).toBe(buildFallbackNarrative(FACTS)?.reading);
    expect(checkLexicon(result.narrative?.reading ?? "")).toEqual([]);
  });

  it("falls back when the provider call throws, and never rethrows", async () => {
    const call = vi.fn(async () => {
      throw new Error("the provider is down");
    });
    const result = await runProfileSynthesis(FACTS, { call });

    expect(result.outcome).toBe("fallback_provider_error");
    expect(result.narrative?.source).toBe("fallback");
  });

  it("calls nothing when the kill switch is off", async () => {
    const call = vi.fn(async () => modelResult(CLEAN_OUTPUT));
    const previous = process.env.PROVIDER_CALLS_ENABLED;
    process.env.PROVIDER_CALLS_ENABLED = "false";
    try {
      const result = await runProfileSynthesis(FACTS, { call });
      expect(result.outcome).toBe("fallback_kill_switch");
      expect(call).not.toHaveBeenCalled();
      expect(result.narrative?.source).toBe("fallback");
    } finally {
      if (previous === undefined) {
        delete process.env.PROVIDER_CALLS_ENABLED;
      } else {
        process.env.PROVIDER_CALLS_ENABLED = previous;
      }
    }
  });

  it("calls nothing when there is no key, and says so rather than inventing one", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runProfileSynthesis(FACTS);
      expect(result.outcome).toBe("fallback_not_configured");
      expect(result.narrative?.source).toBe("fallback");
    } finally {
      if (previous !== undefined) {
        process.env.ANTHROPIC_API_KEY = previous;
      }
    }
  });
});

describe("eval:synthesis, the derivations the reading stands on", () => {
  it("reads skin type from oiliness and moisture, and says nothing without them", () => {
    expect(
      deriveSkinType({
        concerns: [{ key: "oiliness", score: 70, region: null }],
        qualities: [{ key: "moisture", score: 30, region: null }],
      })?.label,
    ).toBe("combination");
    expect(
      deriveSkinType({
        concerns: [{ key: "oiliness", score: 70, region: null }],
        qualities: [{ key: "moisture", score: 60, region: null }],
      })?.label,
    ).toBe("oily");
    expect(
      deriveSkinType({
        concerns: [{ key: "oiliness", score: 20, region: null }],
        qualities: [{ key: "moisture", score: 20, region: null }],
      })?.label,
    ).toBe("dry");
    expect(
      deriveSkinType({
        concerns: [{ key: "oiliness", score: 40, region: null }],
        qualities: [{ key: "moisture", score: 60, region: null }],
      })?.label,
    ).toBe("balanced");
    expect(deriveSkinType({ concerns: [], qualities: [] })).toBeNull();
  });

  it("reads the same skin type back out of the two stored zones", () => {
    expect(skinTypeFromZones("oily", "dry")?.label).toBe("combination");
    expect(skinTypeFromZones("oily", "oily")?.label).toBe("oily");
    expect(skinTypeFromZones("dry", "dry")?.label).toBe("dry");
    expect(skinTypeFromZones("balanced", "balanced")?.label).toBe("balanced");
    expect(skinTypeFromZones(null, null)).toBeNull();
    expect(skinTypeFromZones("nonsense", null)).toBeNull();
  });

  it("detects an undertone from the tone hex, and none without one", () => {
    expect(detectUndertone("#f2d2a9")).toBe("warm");
    expect(detectUndertone("#f0d5cf")).toBe("cool");
    expect(detectUndertone("#4f3b30")).toBe("neutral");
    expect(detectUndertone(null)).toBeNull();
    expect(detectUndertone("not a hex")).toBe("neutral");
    expect(hueOf("#808080")).toBeNull();
  });
});

describe("eval:synthesis, the rebuild decision", () => {
  const base: AestheticProfile = {
    user_id: "owner-a09",
    capture_id: "capture-a09",
    skin_type_zones: { t_zone: "oily", cheeks: "dry" },
    concerns: DEMO_FIXTURE_CONCERNS.map((concern) => ({ ...concern })),
    skin_age: 31,
    fitzpatrick: 5,
    skin_tone_hex: "#6b4a2f",
    undertone: "warm",
    undertone_source: "detected",
    eye_color_hex: "#3b2b22",
    hair_color_hex: "#1e1613",
    face_shape: "Oval",
    hair_type: null,
    saved_hair_style_id: null,
    saved_hair_color_name: null,
    season: null,
    palette: null,
    reading: DEMO_FIXTURE_READING,
    reading_model: "claude-sonnet-5/synthesis-v2",
    version: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };

  it("does nothing when the row already matches the analyses", () => {
    expect(decideBuild({ existing: base, facts: FACTS })).toEqual({
      build: false,
      regenerateReading: false,
    });
  });

  it("builds and writes a reading when there is no row yet", () => {
    expect(decideBuild({ existing: null, facts: FACTS })).toEqual({
      build: true,
      regenerateReading: true,
    });
  });

  it("writes a reading again when the Fitzpatrick type arrives late", () => {
    const withoutType: AestheticProfile = { ...base, fitzpatrick: null };
    expect(decideBuild({ existing: withoutType, facts: FACTS }).regenerateReading).toBe(
      true,
    );
  });

  it("updates the row without a new reading when only the face shape arrives", () => {
    const withoutShape: AestheticProfile = { ...base, face_shape: null };
    expect(decideBuild({ existing: withoutShape, facts: FACTS })).toEqual({
      build: true,
      regenerateReading: false,
    });
  });

  it("writes a reading again when the row holds none", () => {
    const withoutReading: AestheticProfile = { ...base, reading: null };
    expect(decideBuild({ existing: withoutReading, facts: FACTS }).regenerateReading).toBe(
      true,
    );
  });

  it("rebuilds everything for a different capture", () => {
    const otherCapture: AestheticProfile = { ...base, capture_id: "capture-a01" };
    expect(decideBuild({ existing: otherCapture, facts: FACTS })).toEqual({
      build: true,
      regenerateReading: true,
    });
  });
});

describe("eval:synthesis, the demo fixture", () => {
  it("matches the ranking the a09 analysis set produces", () => {
    const ranked = FACTS.ranked.map((concern) => ({
      key: concern.key,
      score: concern.score,
      rank: concern.rank,
    }));
    expect(ranked).toEqual(
      DEMO_FIXTURE_CONCERNS.map((concern) => ({
        key: concern.key,
        score: concern.score,
        rank: concern.rank,
      })),
    );
  });

  it("passes every hard check the generated readings have to pass", () => {
    const problems = findReadingProblems(DEMO_FIXTURE_REPORT_VIEW.reading, {
      topConcernName: concernDisplayName("pigmentation"),
    });
    expect(problems).toEqual([]);
  });

  it("shows no product, because no listing has ever been fetched for it", () => {
    const steps = [
      ...DEMO_FIXTURE_REPORT_VIEW.routine.morning,
      ...DEMO_FIXTURE_REPORT_VIEW.routine.night,
    ];
    expect(steps).toHaveLength(7);
    for (const step of steps) {
      expect(step.product).toBeNull();
      expect(step.productQuery.length).toBeGreaterThan(0);
    }
  });

  it("carries the required framing for the skin age and the dermatologist line", () => {
    const skinAgeLine = reportSkinAgeLine(DEMO_FIXTURE_REPORT_VIEW);
    expect(skinAgeLine).toContain(REQUIRED_SKIN_AGE_FRAMING);
    expect(skinAgeLine).toContain("31");
    // Redness is one of the concerns, so the escalation line is required once.
    expect(DEMO_FIXTURE_REPORT_VIEW.showDermatologistLine).toBe(true);
    expect(reportDermatologistLine(DEMO_FIXTURE_REPORT_VIEW)).toContain(
      "dermatologist",
    );
  });

  it("says the reading was not written by a model, because it was not", () => {
    expect(DEMO_FIXTURE_REPORT_VIEW.readingSource).toBe("fallback");
  });
});

describe("eval:synthesis, fixture mode", () => {
  it("answers from the fixture without a database and logs that it did", async () => {
    const { buildReportView, isDemoFixtureMode } = await import(
      "@/lib/server/profile/report-view"
    );

    const previous = process.env.AURUM_DEMO_FIXTURE;
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    process.env.AURUM_DEMO_FIXTURE = "true";

    try {
      expect(isDemoFixtureMode()).toBe(true);
      // No Supabase configuration exists in this run, so any query would throw.
      const view = await buildReportView({
        kind: "user",
        id: "demo-fixture",
        ownerType: "user",
      });
      expect(view).toBe(DEMO_FIXTURE_REPORT_VIEW);
      expect(logged.join(" ")).toContain("fixture");
    } finally {
      spy.mockRestore();
      if (previous === undefined) {
        delete process.env.AURUM_DEMO_FIXTURE;
      } else {
        process.env.AURUM_DEMO_FIXTURE = previous;
      }
    }
  });

  it("is off unless the environment says exactly true", async () => {
    const { isDemoFixtureMode } = await import("@/lib/server/profile/report-view");
    const previous = process.env.AURUM_DEMO_FIXTURE;
    process.env.AURUM_DEMO_FIXTURE = "1";
    try {
      expect(isDemoFixtureMode()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.AURUM_DEMO_FIXTURE;
      } else {
        process.env.AURUM_DEMO_FIXTURE = previous;
      }
    }
  });
});
