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

import {
  FACE_ATTRIBUTES_REQUESTED,
  analysisTaskBody,
  normalize,
  planFor,
} from "@/lib/server/jobs/analysis";
import { perfectCorpUnits } from "@/lib/server/credits/costs";
import { isProviderError } from "@/lib/server/providers/errors";
import {
  normalizeTaskState,
  parseFacialColorTonesResult,
  readFaceShape,
  readSkinAnalysis,
  skinAnalysisResultSchema,
  skinTypeZoneFor,
  skinTypeZoneLabel,
  taskFailureCode,
  taskStatusResponseSchema,
  type TaskSnapshot,
} from "@/lib/server/providers/perfectcorp";
import { PERFECTCORP_ENDPOINTS } from "@/lib/server/providers/perfectcorp/endpoints";
import {
  FACE_ATTRIBUTE_NAMES,
  FACE_SHAPE_VALUES,
  faceAttributesResultSchema,
  facialColorTonesResultSchema,
} from "@/lib/server/providers/perfectcorp/schemas";
import {
  readAttributesSummary,
  readFaceShapeSummary,
  readSkinSummary,
} from "@/lib/server/profile/summaries";
import { deriveSkinType, skinTypeFromZones } from "@/lib/server/profile/skin-type";
import { classifyContrast } from "@/lib/shared/palette";
import {
  FACE_SHAPE_UNKNOWN_LINE,
  HAIR_FACE_SHAPES,
  faceShapeLine,
  hairStylesFor,
  normalizeFaceShape,
} from "@/lib/shared/hair-rules";
import {
  VERIFIED_SD_SKIN_CONCERN_TYPES,
  isNonConcernOutputType,
  mapProviderConcern,
  rankConcernsToneFirst,
} from "@/lib/shared/concerns";

import {
  loadFaceAttrStatus,
  loadSkinAnalysisStatus,
  readFaceAttrStatusText,
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

/* ------------------------------------------------------------------ */
/* The skin tone result, and the fields it may not be able to fill      */
/* ------------------------------------------------------------------ */

/**
 * The same failure as the envelope above, one endpoint over.
 *
 * A live skin tone analysis succeeded, was charged 20 units, and was thrown
 * away: facialColorTonesResultSchema declared every colour z.string(), that
 * photo returned nothing readable for color.hair_color and color.hair_color_name,
 * and the parse failed on the whole result. The jobs runner logged
 * aurum.analysis_unreadable with exactly those two issue paths and closed the
 * analysis, so the capture lost its skin tone, its undertone, and the palette
 * built on them, over two fields the report does not need.
 *
 * The rule this block holds: a result the provider charged for is kept for
 * whatever it did carry. Only a missing skin_color is a failure, because that is
 * the field the call is bought for.
 */
describe("a skin tone result with fields the engine could not fill", () => {
  const READABLE = {
    skin_color: "#997357",
    eye_color: "#0f0b0f",
    eye_color_name: "Brown",
    lip_color: "#b57f7f",
    eyebrow_color: "#3e3834",
  } as const;

  function toneSnapshot(color: Record<string, unknown>): TaskSnapshot {
    return {
      endpointKey: "facialColorTones",
      taskId: "charged-and-partial",
      state: "succeeded",
      results: { color },
      errorCode: null,
      pollingIntervalSeconds: null,
    };
  }

  /** The two shapes the live failure could have had. Both are read the same. */
  const PARTIAL = [
    {
      name: "hair fields null",
      color: { ...READABLE, hair_color: null, hair_color_name: null },
    },
    {
      name: "hair fields absent",
      color: { ...READABLE },
    },
  ] as const;

  it.each(PARTIAL)("parses a result with $name", ({ color }) => {
    const parsed = facialColorTonesResultSchema.safeParse({ color });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.color.skin_color).toBe(READABLE.skin_color);
    expect(parsed.data?.color.hair_color ?? null).toBeNull();
    expect(parsed.data?.color.hair_color_name ?? null).toBeNull();
  });

  it.each(PARTIAL)("normalizes a result with $name into a summary", ({ color }) => {
    const normalized = normalize("attributes", toneSnapshot(color));
    expect(normalized.summary).toMatchObject({
      skinColor: READABLE.skin_color,
      eyeColor: READABLE.eye_color,
      hairColor: null,
      hairColorName: null,
    });
    // The keys are always there, whatever came back, so the stored shape does
    // not change with the photo.
    expect(Object.keys(normalized.summary as object).sort()).toEqual([
      "eyeColor",
      "eyeColorName",
      "eyebrowColor",
      "hairColor",
      "hairColorName",
      "lipColor",
      "skinColor",
    ]);
  });

  it.each(PARTIAL)("hands the profile layer the tone it did get, with $name", ({ color }) => {
    const normalized = normalize("attributes", toneSnapshot(color));
    const read = readAttributesSummary(normalized.summary);
    expect(read).not.toBeNull();
    expect(read?.skinToneHex).toBe("#997357");
    expect(read?.eyeColorHex).toBe("#0f0b0f");
    expect(read?.hairColorHex).toBeNull();
  });

  it("still builds a palette, because unknown hair is medium contrast", () => {
    const normalized = normalize("attributes", toneSnapshot(PARTIAL[0].color));
    const read = readAttributesSummary(normalized.summary);
    expect(
      classifyContrast({
        skinToneHex: read?.skinToneHex ?? "",
        eyeColorHex: read?.eyeColorHex ?? null,
        hairColorHex: read?.hairColorHex ?? null,
      }),
    ).not.toBeNull();
    // Nothing to compare the skin against at all is medium, not low.
    expect(
      classifyContrast({
        skinToneHex: "#997357",
        eyeColorHex: null,
        hairColorHex: null,
      }),
    ).toBe("medium");
  });

  it("keeps a colour it cannot read at all, rather than the result", () => {
    // Not a shape anyone has seen. It becomes null and the rest survives, which
    // is the point: the units are already spent either way.
    const parsed = facialColorTonesResultSchema.safeParse({
      color: { ...READABLE, hair_color: { r: 12 }, hair_color_name: 7 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.color.hair_color).toBeNull();
    expect(parsed.data?.color.skin_color).toBe(READABLE.skin_color);
  });

  it("fails only when the skin colour itself is missing", () => {
    const withoutSkin = { ...READABLE } as Record<string, unknown>;
    delete withoutSkin.skin_color;
    expect(
      facialColorTonesResultSchema.safeParse({ color: withoutSkin }).success,
    ).toBe(false);

    let thrown: unknown = null;
    try {
      parseFacialColorTonesResult(toneSnapshot(withoutSkin));
    } catch (error) {
      thrown = error;
    }
    expect(isProviderError(thrown)).toBe(true);
    expect(isProviderError(thrown) ? thrown.issuePaths : []).toEqual([
      "color.skin_color",
    ]);
  });

  it("no longer fails on the two fields the live result lost", () => {
    for (const entry of PARTIAL) {
      expect(() =>
        parseFacialColorTonesResult(toneSnapshot(entry.color)),
      ).not.toThrow();
    }
  });
});

describe("the skin tone analysis cost", () => {
  it("is the 20 units the discarded result was charged", () => {
    expect(PERFECTCORP_ENDPOINTS.facialColorTones.unitCost).toEqual({
      kind: "fixed",
      units: 20,
    });
  });
});

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

/* ------------------------------------------------------------------ */
/* The face attribute analysis                                         */
/* ------------------------------------------------------------------ */

/**
 * The third recorded body, and the one that fixes /hair.
 *
 * Two separate mistakes were live at once, and only one of them cost a credit:
 *
 * 1. The request sent dst_actions, which is the skin analyzer's word for its
 *    selection. This endpoint calls it features and rejects a body without it,
 *    so no face shape task ever existed, and every person was told their face
 *    shape was not read from their photo.
 * 2. The result schema looked for the shape at results.faceShape,
 *    results.face_shape, and results.attributes.faceShape. It is at
 *    results.faceshape. So the first task that did get created would have been
 *    charged, parsed, and produced a null face shape anyway.
 *
 * Everything below runs against evals/fixtures/perfectcorp/face-attr-status.json,
 * recorded 2026-09-03 for 10 units. No key, no network, no credit.
 */
describe("the face attribute analysis body the app sends", () => {
  const body = analysisTaskBody("face_shape", "file-123");

  it("names the selection features, which is the field this endpoint has", () => {
    expect(body).toEqual({
      src_file_id: "file-123",
      features: ["faceShape"],
      face_angle_strictness_level: "high",
    });
  });

  it("never sends dst_actions, which is what the 400 was", () => {
    // "features is required but wasn't included in your request." was the whole
    // bug, and it answered for free every time.
    expect(body).not.toHaveProperty("dst_actions");
  });

  it("asks for one feature, which is the cheapest tier", () => {
    expect(FACE_ATTRIBUTES_REQUESTED).toEqual(["faceShape"]);
    expect(planFor("face_shape").itemCount).toBe(1);
    expect(planFor("face_shape").units).toBe(10);
  });

  it("spells the feature the way the enum does", () => {
    // The snake case answers "0 is not one of the accepted values.", naming the
    // index in the array rather than the field.
    expect(FACE_ATTRIBUTE_NAMES).toContain("faceShape");
    expect(FACE_ATTRIBUTE_NAMES).not.toContain("face_shape");
  });

  it("uses the file id field the endpoint table records", () => {
    expect(PERFECTCORP_ENDPOINTS.faceAttributes.sourceFileFields[0]).toBe(
      "src_file_id",
    );
  });
});

describe("the recorded face attribute response", () => {
  it("carries nothing that had to be sanitized out", () => {
    expect(findLeaks(readFaceAttrStatusText())).toEqual([]);
  });

  it("comes back in the same envelope as every other task", () => {
    const parsed = taskStatusResponseSchema.parse(loadFaceAttrStatus());
    expect(parsed.status).toBe(200);
    expect(parsed.data.task_status).toBe("success");
    expect(parsed.data.error).toBeNull();
    expect(taskFailureCode(parsed.data)).toBeNull();
    expect(normalizeTaskState(parsed.data.task_status)).toBe("succeeded");
  });

  it("puts the face shape at results.faceshape, all lower case", () => {
    const parsed = taskStatusResponseSchema.parse(loadFaceAttrStatus());
    const result = faceAttributesResultSchema.parse(parsed.data.results);
    expect(result.faceshape).toBe("InvTriangle");
    expect(readFaceShape(result)).toBe("InvTriangle");
  });

  it("reports the quality of the frame it worked from", () => {
    const parsed = taskStatusResponseSchema.parse(loadFaceAttrStatus());
    const result = faceAttributesResultSchema.parse(parsed.data.results);
    expect(result.face_quality?.has_face).toBe(true);
    expect(result.face_quality?.faceangle).toBe("good");
  });

  it("keeps a charged result that answered nothing, rather than throwing it away", () => {
    // The tone endpoint's lesson, applied before it costs anything here: a task
    // the engine succeeded at is charged whether or not it filled a field.
    expect(faceAttributesResultSchema.safeParse({}).success).toBe(true);
    expect(
      faceAttributesResultSchema.safeParse({ faceshape: null }).success,
    ).toBe(true);
    expect(readFaceShape({ faceshape: null })).toBeNull();
    // "Unknown" is one of the nine values, and it is not a shape.
    expect(readFaceShape({ faceshape: "Unknown" })).toBeNull();
    expect(readFaceShape({ faceshape: "  " })).toBeNull();
  });
});

describe("normalize over the recorded face attribute body", () => {
  function faceAttrSnapshot(): TaskSnapshot {
    const parsed = taskStatusResponseSchema.parse(loadFaceAttrStatus());
    return {
      endpointKey: "faceAttributes",
      taskId: "recorded-response",
      state: "succeeded",
      results: parsed.data.results,
      errorCode: null,
      pollingIntervalSeconds: null,
    };
  }

  const normalized = normalize("face_shape", faceAttrSnapshot());

  it("summarizes the provider's own word, unchanged", () => {
    expect(normalized.summary).toEqual({ faceShape: "InvTriangle" });
    expect(normalized.maskUrls).toEqual([]);
  });

  it("hands the profile layer a face shape it reads back", () => {
    expect(readFaceShapeSummary(normalized.summary)).toBe("InvTriangle");
  });

  it("reaches /hair as a shape with its own styles, not the unknown line", () => {
    /*
     * The whole point of the ten units. InvTriangle is an inverted triangle: a
     * wider forehead narrowing to a pointed chin, which is the heart row.
     */
    const stored = readFaceShapeSummary(normalized.summary);
    const shape = normalizeFaceShape(stored);
    expect(shape).toBe("heart");

    const line = faceShapeLine(shape);
    expect(line).not.toBe(FACE_SHAPE_UNKNOWN_LINE);
    expect(line).toContain("Your face shape reads as heart.");

    const styles = hairStylesFor({ faceShape: shape, hairType: null });
    expect(styles).toHaveLength(4);
    expect(styles.map((style) => style.id)).toEqual([
      "chin-length-bob",
      "side-parted-lob",
      "soft-layers-collarbone",
      "curtain-fringe",
    ]);
  });
});

describe("the face shape vocabulary", () => {
  it("maps every value the engine can answer", () => {
    const mapped = Object.fromEntries(
      FACE_SHAPE_VALUES.map((value) => [value, normalizeFaceShape(value)]),
    );
    expect(mapped).toEqual({
      Triangle: "triangle",
      Diamond: "diamond",
      Heart: "heart",
      InvTriangle: "heart",
      Oblong: "oblong",
      Oval: "oval",
      Round: "round",
      Square: "square",
      Unknown: null,
    });
  });

  it("leaves no row of the rules table unreachable from the API", () => {
    // Every shape the table writes advice for is a shape a real response can
    // produce. A row nothing can reach is advice nobody will ever be given.
    const reachable = new Set(
      FACE_SHAPE_VALUES.map((value) => normalizeFaceShape(value)).filter(
        (shape) => shape !== null,
      ),
    );
    expect([...reachable].sort()).toEqual([...HAIR_FACE_SHAPES].sort());
  });

  it("answers null for a value the provider has not sent before", () => {
    expect(normalizeFaceShape("Pentagon")).toBeNull();
    expect(normalizeFaceShape(null)).toBeNull();
    expect(faceShapeLine(normalizeFaceShape("Pentagon"))).toBe(
      FACE_SHAPE_UNKNOWN_LINE,
    );
  });
});

describe("the face attribute analysis cost", () => {
  it("is the 10 units the live task was charged", () => {
    expect(PERFECTCORP_ENDPOINTS.faceAttributes.unitCost).toEqual({
      kind: "tiered",
      countedBy: "attributes requested",
      tiers: [
        { upTo: 5, units: 10 },
        { upTo: 14, units: 20 },
        { upTo: 28, units: 30 },
      ],
    });
    expect(perfectCorpUnits("faceAttributes", 1)).toBe(10);
  });

  it("is confirmed, so the client no longer refuses to call it", () => {
    const verification = PERFECTCORP_ENDPOINTS.faceAttributes.verification;
    expect(verification.state).toBe("confirmed");
    expect(verification.checkedOn).toBe("2026-09-03");
    expect(verification.note).toContain("features");
    expect(verification.note).toContain("408 to 398");
  });
});
