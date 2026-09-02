import { describe, expect, it, vi } from "vitest";

/**
 * The Perfect Corp task status envelope, tested against the response the live
 * API actually sent.
 *
 * Why this suite exists. On 2026-09-02 the first live skin analysis task
 * succeeded, was charged 16 units, and was recorded as failed, because
 * taskStatusResponseSchema declared `error: z.string().optional()` and the real
 * body carries `"error": null`. zod's optional accepts undefined and rejects
 * null, so the poll threw invalid_response on a task that had worked.
 *
 * Everything below runs against evals/fixtures/perfectcorp/skin-analysis-status.json,
 * which is that body with every signed URL replaced. No key, no network, no
 * credit.
 */

vi.mock("server-only", () => ({}));

import { normalize } from "@/lib/server/jobs/analysis";
import {
  normalizeTaskState,
  readSkinAnalysis,
  skinAnalysisResultSchema,
  skinTypeZoneFor,
  skinTypeZoneLabel,
  taskFailureCode,
  taskStatusResponseSchema,
  type TaskSnapshot,
} from "@/lib/server/providers/perfectcorp";
import { PERFECTCORP_ENDPOINTS } from "@/lib/server/providers/perfectcorp/endpoints";
import { readSkinSummary } from "@/lib/server/profile/summaries";
import { deriveSkinType, skinTypeFromZones } from "@/lib/server/profile/skin-type";
import {
  VERIFIED_SD_SKIN_CONCERN_TYPES,
  isNonConcernOutputType,
  mapProviderConcern,
  rankConcernsToneFirst,
} from "@/lib/shared/concerns";

import {
  loadSkinAnalysisStatus,
  readSkinAnalysisStatusText,
} from "../fixtures/perfectcorp";
import {
  findLeaks,
  sanitizeProviderJson,
  sanitizeFileText,
  DEFAULT_URL_REPLACEMENT,
} from "../../scripts/sanitize-perfectcorp-fixture";

/* ------------------------------------------------------------------ */
/* The fixture itself                                                  */
/* ------------------------------------------------------------------ */

describe("the recorded response fixture", () => {
  it("carries no signed URL, no bucket, and no provider host", () => {
    expect(findLeaks(readSkinAnalysisStatusText())).toEqual([]);
  });

  it("replaced every mask URL with the same harmless placeholder", () => {
    const text = readSkinAnalysisStatusText();
    const urls = text.match(/https?:\/\/[^"]+/gu) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set([DEFAULT_URL_REPLACEMENT]));
  });

  it("rewrites URLs and nothing else", () => {
    expect(
      sanitizeProviderJson({
        ui_score: 80,
        type: "eye_bag",
        url: null,
        mask_urls: ["https://bucket.example.com/a.png?X-Amz-Signature=abc"],
      }),
    ).toEqual({
      ui_score: 80,
      type: "eye_bag",
      url: null,
      mask_urls: [DEFAULT_URL_REPLACEMENT],
    });
  });

  it("refuses to produce text that still carries a signed URL", () => {
    expect(() =>
      sanitizeFileText('{"note":"see https://x.amazonaws.com/a"}', "not-a-url"),
    ).toThrow(/still carries/u);
  });
});

/* ------------------------------------------------------------------ */
/* The envelope                                                        */
/* ------------------------------------------------------------------ */

describe("taskStatusResponseSchema against the real body", () => {
  it("parses the response that used to be rejected", () => {
    const parsed = taskStatusResponseSchema.safeParse(loadSkinAnalysisStatus());
    expect(parsed.success).toBe(true);
  });

  it("accepts a null error, which is what a successful task sends", () => {
    const parsed = taskStatusResponseSchema.parse({
      status: 200,
      data: { error: null, task_status: "success", results: { output: [] } },
    });
    expect(parsed.data.error).toBeNull();
    expect(normalizeTaskState(parsed.data.task_status)).toBe("succeeded");
  });

  it("still accepts an absent error and a string error", () => {
    expect(
      taskStatusResponseSchema.safeParse({
        status: 200,
        data: { task_status: "running" },
      }).success,
    ).toBe(true);
    expect(
      taskStatusResponseSchema.safeParse({
        status: 200,
        data: { task_status: "error", error: "InternalError", error_code: 500 },
      }).success,
    ).toBe(true);
  });

  it("reads task_status from inside data, beside error and results", () => {
    const parsed = taskStatusResponseSchema.parse(loadSkinAnalysisStatus());
    expect(parsed.data.task_status).toBe("success");
    expect(parsed.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* A refused task                                                      */
/* ------------------------------------------------------------------ */

/**
 * The other half of the envelope. A task that fails carries its identifier in
 * data.error, which is where every refusal read on 2026-09-02 was:
 * error_face_angle_rightward and error_face_not_forward_facing from the skin
 * tone analysis, error_no_face from a frame with nobody in it. A failed task is
 * charged nothing, so what these bodies decide is only what the person is told.
 */
describe("taskFailureCode over a refused task body", () => {
  function refusal(code: string) {
    return taskStatusResponseSchema.parse({
      status: 200,
      data: { error: code, error_code: null, results: null, task_status: "error" },
    });
  }

  it("reads the refusal out of data.error", () => {
    for (const code of [
      "error_face_angle_rightward",
      "error_face_not_forward_facing",
      "error_no_face",
    ]) {
      const parsed = refusal(code);
      expect(normalizeTaskState(parsed.data.task_status)).toBe("failed");
      expect(taskFailureCode(parsed.data)).toBe(code);
    }
  });

  it("prefers the code the mapping can read over a bare number", () => {
    // The shape that would lose the useful half if error_code were read first.
    expect(
      taskFailureCode({ error: "error_no_face", error_code: 1005 }),
    ).toBe("error_no_face");
  });

  it("still reads a numeric code when that is all there is", () => {
    expect(taskFailureCode({ error: null, error_code: 500 })).toBe("500");
    expect(taskFailureCode({ error: "", error_code: "E123" })).toBe("E123");
  });

  it("returns null for the successful task, where both fields are null", () => {
    const parsed = taskStatusResponseSchema.parse(loadSkinAnalysisStatus());
    expect(parsed.data.error).toBeNull();
    expect(taskFailureCode(parsed.data)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The skin analysis payload                                           */
/* ------------------------------------------------------------------ */

function realResult() {
  const parsed = taskStatusResponseSchema.parse(loadSkinAnalysisStatus());
  return skinAnalysisResultSchema.parse(parsed.data.results);
}

describe("skinAnalysisResultSchema against the real output list", () => {
  it("parses an output list that mixes scored and unscored entries", () => {
    expect(realResult().output).toHaveLength(21);
  });

  it("keeps the entries that carry no ui_score at all", () => {
    const types = realResult().output.map((entry) => entry.type);
    expect(types).toContain("all");
    expect(types).toContain("skin_age");
    expect(types).toContain("resize_image");
    expect(types.filter((type) => type === "skin_type")).toHaveLength(3);
  });
});

describe("readSkinAnalysis", () => {
  const reading = readSkinAnalysis(realResult());

  it("reads only the scored concerns as concerns", () => {
    expect(reading.concerns.map((entry) => entry.type)).toEqual([
      ...VERIFIED_SD_SKIN_CONCERN_TYPES,
    ]);
  });

  it("takes skin age and the overall score from their own entries", () => {
    expect(reading.skinAge).toBe(28);
    expect(reading.overallScore).toBe(85.4);
  });

  it("reads skin type once per zone and translates the word", () => {
    expect(reading.skinTypeZones.map((zone) => zone.region)).toEqual([
      "whole",
      "t_zone",
      "u_zone",
    ]);
    expect(skinTypeZoneFor(reading, "t_zone")).toEqual({
      region: "t_zone",
      value: "Normal",
      label: "balanced",
    });
    expect(skinTypeZoneLabel("Oily")).toBe("oily");
    expect(skinTypeZoneLabel("Dry")).toBe("dry");
    // A word we have no label for sends the report back to its derived zones.
    expect(skinTypeZoneLabel("Sensitive")).toBeNull();
    expect(skinTypeZoneLabel(null)).toBeNull();
  });

  it("keeps the resized frame out of the concern list", () => {
    expect(reading.resizedImageUrl).toBe(DEFAULT_URL_REPLACEMENT);
    expect(reading.concerns.some((entry) => entry.type === "resize_image")).toBe(false);
  });

  it("carries the provider scores through unrounded", () => {
    const eyeBag = reading.concerns.find((entry) => entry.type === "eye_bag");
    expect(eyeBag?.uiScore).toBe(80);
    expect(eyeBag?.rawScore).toBeCloseTo(78.3895, 3);
  });
});

/* ------------------------------------------------------------------ */
/* The name mapping                                                    */
/* ------------------------------------------------------------------ */

describe("the concern name mapping against the live names", () => {
  it("maps every scored type the live response returned", () => {
    const unmapped = VERIFIED_SD_SKIN_CONCERN_TYPES.filter(
      (type) => mapProviderConcern(type) === null,
    );
    expect(unmapped).toEqual([]);
  });

  it("maps the two names that used to fall through", () => {
    expect(mapProviderConcern("dark_circle_v2")).toBe("dark_circles");
    expect(mapProviderConcern("droopy_lower_eyelid")).toBe("eyelid_droop");
  });

  it("sends both eyelids to one concern", () => {
    expect(mapProviderConcern("droopy_upper_eyelid")).toBe(
      mapProviderConcern("droopy_lower_eyelid"),
    );
  });

  it("tells a non concern output apart from a name it could not map", () => {
    for (const type of ["all", "skin_age", "skin_type", "resize_image"]) {
      expect(isNonConcernOutputType(type)).toBe(true);
      expect(mapProviderConcern(type)).toBeNull();
    }
    expect(isNonConcernOutputType("hydration_index_v2")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The normalizer, end to end over the real body                       */
/* ------------------------------------------------------------------ */

function realSnapshot(): TaskSnapshot {
  const parsed = taskStatusResponseSchema.parse(loadSkinAnalysisStatus());
  return {
    endpointKey: "skinAnalysis",
    taskId: "recorded-response",
    state: "succeeded",
    results: parsed.data.results,
    errorCode: null,
    pollingIntervalSeconds: null,
  };
}

describe("normalize over the real body", () => {
  const normalized = normalize("skin", realSnapshot());
  const summary = normalized.summary as unknown as {
    readonly concerns: ReadonlyArray<{
      readonly providerType: string;
      readonly key: string | null;
      readonly uiScore: number;
      readonly providerUiScore: number;
      readonly rawScore: number;
    }>;
    readonly skinAge: number | null;
    readonly overallScore: number | null;
    readonly skinTypeZones: { readonly tZone: string | null; readonly cheeks: string | null } | null;
  };

  it("produces one concern per scored entry, and no others", () => {
    expect(summary.concerns).toHaveLength(VERIFIED_SD_SKIN_CONCERN_TYPES.length);
    expect(summary.concerns.every((entry) => entry.key !== null)).toBe(true);
  });

  it("inverts the provider's condition score into a presence score", () => {
    const byKey = new Map(summary.concerns.map((entry) => [entry.key, entry]));

    /*
     * The provider says redness 99, meaning almost none of it. Read as presence
     * that has to become almost nothing, or the report leads on the clearest
     * skin on the face and tells the person to treat it.
     */
    expect(byKey.get("redness")?.providerUiScore).toBe(99);
    expect(byKey.get("redness")?.uiScore).toBe(1);
    expect(byKey.get("acne")?.uiScore).toBe(1);
    expect(byKey.get("oiliness")?.uiScore).toBe(1);

    // The lowest condition score on this face is its most present concern.
    expect(byKey.get("dark_circles")?.providerUiScore).toBe(70);
    expect(byKey.get("dark_circles")?.uiScore).toBe(30);

    // The provider's own figure is kept beside ours, never overwritten.
    for (const entry of summary.concerns) {
      expect(typeof entry.providerUiScore).toBe("number");
    }
  });

  it("leaves the two quality concerns on the provider's scale", () => {
    const byKey = new Map(summary.concerns.map((entry) => [entry.key, entry]));
    /*
     * moisture is read as hydration by src/lib/server/profile/skin-type.ts
     * ("below 45 means dry cheeks"), so inverting it would call this well
     * hydrated face dry. radiance reads the same way.
     */
    expect(byKey.get("moisture")?.uiScore).toBe(77);
    expect(byKey.get("moisture")?.providerUiScore).toBe(77);
    expect(byKey.get("radiance")?.uiScore).toBe(82);
  });

  it("ranks the face the way the report will show it", () => {
    /*
     * Through the real path, not a sort written for the test: readSkinSummary
     * drops the qualities and rankConcernsToneFirst dedupes the two eyelid rows
     * to the more present one, exactly as the report does.
     */
    const read = readSkinSummary(normalized.summary);
    const ranked = rankConcernsToneFirst(
      (read?.concerns ?? []).map((concern) => ({
        key: concern.key,
        score: concern.score,
      })),
      null,
    );
    expect(ranked.slice(0, 5).map((entry) => [entry.key, entry.score])).toEqual([
      ["dark_circles", 30],
      ["eyelid_droop", 25],
      ["firmness", 25],
      ["eye_bags", 20],
      ["tear_trough", 20],
    ]);
    // The clearest skin on the face ends up last, which is the whole point.
    expect(ranked.slice(-3).map((entry) => entry.key).sort()).toEqual([
      "acne",
      "oiliness",
      "redness",
    ]);
  });

  it("stores a mask for every one of the top ranked concerns it can", () => {
    const read = readSkinSummary(normalized.summary);
    const ranked = rankConcernsToneFirst(
      (read?.concerns ?? []).map((concern) => ({
        key: concern.key,
        score: concern.score,
      })),
      null,
    );
    const stored = normalized.maskUrls.map((mask) => mask.key);
    expect(stored).toEqual(ranked.slice(0, stored.length).map((entry) => entry.key));
  });

  it("fills skin age and the overall score, which used to come back null", () => {
    expect(summary.skinAge).toBe(28);
    expect(summary.overallScore).toBe(85.4);
  });

  it("fills the skin type zones from the provider instead of deriving them", () => {
    expect(summary.skinTypeZones).toEqual({ tZone: "balanced", cheeks: "balanced" });
  });

  it("stores the masks of the most present concerns, in that order", () => {
    /*
     * Provider order used to decide this, which spent the first five slots on
     * eye bags, tear trough, redness, oiliness and pores, two of them at a
     * presence of 1, and left the most present concern on the face without a
     * mask at all. The report's toggles sit on the concern rows, so the masks
     * follow the same order the rows do.
     */
    expect(normalized.maskUrls.map((mask) => mask.key)).toEqual([
      "dark_circles",
      "eyelid_droop",
      "firmness",
      "eye_bags",
      "tear_trough",
      "dark_spots",
      "pores",
      "wrinkles",
    ]);
  });

  it("stores one mask per concern key, and keeps the more present eyelid", () => {
    const keys = normalized.maskUrls.map((mask) => mask.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeLessThanOrEqual(8);
    /*
     * Both eyelids map to eyelid_droop. The lower lid is at a presence of 25
     * against the upper lid's 21, so the lower one takes the single slot.
     */
    const eyelid = normalized.maskUrls.find((mask) => mask.key === "eyelid_droop");
    expect(eyelid?.providerType).toBe("droopy_lower_eyelid");
  });

  it("drops the clearest concerns rather than the worst ones", () => {
    const keys = normalized.maskUrls.map((mask) => mask.key);
    for (const clear of ["redness", "oiliness", "acne", "texture"]) {
      expect(keys).not.toContain(clear);
    }
  });

  it("hands the profile layer a summary it can read back", () => {
    const read = readSkinSummary(normalized.summary);
    expect(read).not.toBeNull();
    expect(read?.unmappedNames).toEqual([]);
    expect(read?.skinAge).toBe(28);
    expect(read?.overallScore).toBe(85);
    expect(read?.zonesFromProvider).toEqual({ tZone: "balanced", cheeks: "balanced" });
    // moisture and radiance are read as qualities, not as concerns to rank.
    expect(read?.qualities.map((entry) => entry.key).sort()).toEqual([
      "moisture",
      "radiance",
    ]);
  });

  it("gives the profile layer a skin type that matches what the provider said", () => {
    const read = readSkinSummary(normalized.summary);
    expect(read).not.toBeNull();
    /*
     * The provider called all three zones Normal. The derived fallback now
     * agrees with it, which it did not before: oiliness came through at 99 and
     * the rule read that as an oily T zone, when 99 on the provider's scale
     * means no oiliness at all. Inverted it is 1, and moisture is untouched at
     * 77, so the face reads balanced either way.
     */
    expect(
      deriveSkinType({
        concerns: read?.concerns ?? [],
        qualities: read?.qualities ?? [],
      })?.label,
    ).toBe("balanced");
    expect(
      skinTypeFromZones(
        read?.zonesFromProvider?.tZone ?? null,
        read?.zonesFromProvider?.cheeks ?? null,
      )?.label,
    ).toBe("balanced");
  });
});

/* ------------------------------------------------------------------ */
/* The measured cost                                                   */
/* ------------------------------------------------------------------ */

describe("the skin analysis cost", () => {
  it("is the 16 units the live task was charged", () => {
    expect(PERFECTCORP_ENDPOINTS.skinAnalysis.unitCost).toEqual({
      kind: "fixed",
      units: 16,
    });
  });

  it("records where the figure came from", () => {
    const note = PERFECTCORP_ENDPOINTS.skinAnalysis.verification.note;
    expect(note).toContain("16 units");
    expect(PERFECTCORP_ENDPOINTS.skinAnalysis.verification.checkedOn).toBe(
      "2026-09-02",
    );
  });
});
