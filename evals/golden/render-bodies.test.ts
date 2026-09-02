import { describe, expect, it, vi } from "vitest";

/**
 * The exact request body of every render the person can trigger.
 *
 * This is not an eval suite. It lives under evals/ for the same reason
 * golden-run.test.ts does: vitest.config.mts looks in src and evals, nothing
 * else. It runs on npm run test, it reaches no network, and it spends nothing.
 *
 * What it is here to hold still. Every shade tap, colour tap, garment tap, and
 * projection tap creates a real task, and a task created from a wrong body is a
 * failure the person sees as a picture that never arrived. Each body below was
 * driven through the provider's own validator on 2026-09-02, for free: a task
 * creation that is rejected costs nothing, and a src_file_id the file service
 * cannot resolve is always rejected, so a bogus file id turns a create endpoint
 * into an oracle. Two answers matter, and they are quoted on each case:
 *
 *   a detailed "... is required but wasn't included in your request."
 *                                        the body is wrong
 *   "One or more parameters in this request are invalid."
 *                                        the body is right and only the file id
 *                                        was rejected
 *
 * The credit balance was 0 units before those probes and 0 after. So these are
 * not assertions about what we think the API wants. They are assertions about
 * what it answered, and a diff that changes one of them has to answer for it.
 */

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React server environment. The mock replaces that marker package and nothing
 * else, so the real body builders run here exactly as they do on the server.
 */
vi.mock("server-only", () => ({}));

import {
  accessoryTaskBody,
  callableAccessoryCategories,
} from "@/lib/server/renders/accessory";
import {
  CLOTH_CATEGORY_OF_SLOT,
  clothCategoryForType,
  clothTaskBody,
} from "@/lib/server/renders/cloth";
import { hairColorTaskBody, hairstyleTaskBody } from "@/lib/server/renders/hair";
import { makeupTaskBody } from "@/lib/server/renders/makeup";
import { simulationTaskBody } from "@/lib/server/renders/simulation";
import { getEndpoint } from "@/lib/server/providers/perfectcorp";

const FILE_ID = "file-id-of-the-capture";
const REFERENCE_FILE_ID = "file-id-of-the-garment";
const CAPTURE_ID = "capture-1";

describe("makeup try on bodies", () => {
  /**
   * Answered "One or more parameters in this request are invalid." Dropping
   * coverageIntensity from it answers "coverageIntensity is required but wasn't
   * included in your request.", which is how we know the four palette fields are
   * the foundation branch of the union and not a guess.
   */
  it("sends the confirmed foundation effect", () => {
    const body = makeupTaskBody({
      fileId: FILE_ID,
      params: {
        captureId: CAPTURE_ID,
        categories: [
          { category: "foundation", shadeHex: "#e8c39e", shadeName: "warm sand" },
        ],
      },
    });

    expect(body).toEqual({
      src_file_id: FILE_ID,
      version: "1.0",
      effects: [
        {
          category: "foundation",
          palettes: [
            {
              color: "#E8C39E",
              colorIntensity: 35,
              coverageIntensity: 35,
              glowIntensity: 0,
            },
          ],
        },
      ],
    });
  });

  /**
   * Answered "One or more parameters in this request are invalid." The pattern
   * name is a label from the live eyeshadow catalog, whose colorNum of 1 is what
   * makes one palette entry the right number.
   */
  it("sends the confirmed eye shadow effect", () => {
    const body = makeupTaskBody({
      fileId: FILE_ID,
      params: {
        captureId: CAPTURE_ID,
        categories: [
          { category: "eye", shadeHex: "#8e5c9c", shadeName: "plum" },
        ],
      },
    });

    expect(body).toEqual({
      src_file_id: FILE_ID,
      version: "1.0",
      effects: [
        {
          category: "eye_shadow",
          pattern: { name: "1color1" },
          palettes: [{ color: "#8E5C9C", texture: "matte", colorIntensity: 35 }],
        },
      ],
    });
  });

  /**
   * All four rows in one task, which is what a saved look sends. Accepted.
   *
   * The rows arrive in the order canonicalMakeupParams sorts them into, which is
   * alphabetical by our own category name, and the effects come out in that same
   * order: the request carries a set of effects, not a sequence of steps.
   */
  it("sends all four rows in one task", () => {
    const body = makeupTaskBody({
      fileId: FILE_ID,
      params: {
        captureId: CAPTURE_ID,
        categories: [
          { category: "blush", shadeHex: "#c86b6b", shadeName: "clay" },
          { category: "eye", shadeHex: "#8e5c9c", shadeName: "plum" },
          { category: "foundation", shadeHex: "#e8c39e", shadeName: "warm sand" },
          { category: "lip", shadeHex: "#b14a4a", shadeName: "rust" },
        ],
      },
    });

    expect(body).toEqual({
      src_file_id: FILE_ID,
      version: "1.0",
      effects: [
        {
          category: "blush",
          pattern: { name: "1color1" },
          palettes: [{ color: "#C86B6B", texture: "matte", colorIntensity: 22 }],
        },
        {
          category: "eye_shadow",
          pattern: { name: "1color1" },
          palettes: [{ color: "#8E5C9C", texture: "matte", colorIntensity: 35 }],
        },
        {
          category: "foundation",
          palettes: [
            {
              color: "#E8C39E",
              colorIntensity: 35,
              coverageIntensity: 35,
              glowIntensity: 0,
            },
          ],
        },
        {
          category: "lip_color",
          shape: { name: "original" },
          style: { type: "full" },
          palettes: [{ color: "#B14A4A", texture: "matte", colorIntensity: 30 }],
        },
      ],
    });
  });
});

describe("hair try on bodies", () => {
  it("sends a template id for a hairstyle", () => {
    expect(
      hairstyleTaskBody({
        fileId: FILE_ID,
        params: { captureId: CAPTURE_ID, styleId: "blunt-bob-jaw" },
      }),
    ).toEqual({ src_file_id: FILE_ID, template_id: "female_blunt_bob" });
  });

  /**
   * Answered "One or more parameters in this request are invalid."
   *
   * The two fields this replaced are why the case exists. { mode: "full" }
   * answers "'pattern' is required and can't be null.", so the old body failed
   * outright, and a camel case colorIntensity passes validation while being
   * ignored, so the strength was going nowhere. This endpoint spells it
   * color_intensity, in snake case, unlike makeup-vto next door.
   */
  it("sends the confirmed hair colour pattern and palette", () => {
    const body = hairColorTaskBody({
      fileId: FILE_ID,
      params: {
        captureId: CAPTURE_ID,
        styleId: "blunt-bob-jaw",
        colorHex: "#4a2c1a",
        colorName: "espresso",
      },
    });

    expect(body).toEqual({
      src_file_id: FILE_ID,
      pattern: { name: "full" },
      palettes: [{ color: "#4A2C1A", color_intensity: 100 }],
    });
  });

  it("keeps the leading hash on the colour, which the endpoint requires", () => {
    const body = hairColorTaskBody({
      fileId: FILE_ID,
      params: {
        captureId: CAPTURE_ID,
        styleId: "blunt-bob-jaw",
        colorHex: "#4a2c1a",
        colorName: "espresso",
      },
    }) as { palettes: ReadonlyArray<{ color: string }> };

    // "4A2C1A" without it answers "color doesn't match the required format."
    expect(body.palettes[0].color.startsWith("#")).toBe(true);
  });
});

describe("cloth try on body", () => {
  /** Answered "One or more parameters in this request are invalid." */
  it("sends the source, the reference, and one garment category", () => {
    expect(
      clothTaskBody({
        fileId: FILE_ID,
        referenceFileId: REFERENCE_FILE_ID,
        params: {
          captureId: CAPTURE_ID,
          garmentId: "garment-1",
          garmentCategory: "upper_body",
        },
      }),
    ).toEqual({
      src_file_id: FILE_ID,
      ref_file_id: REFERENCE_FILE_ID,
      garment_category: "upper_body",
    });
  });

  /**
   * The enum the endpoint accepts, confirmed value by value. "torso" answers
   * "garment_category is not one of the accepted values.", so a slot that maps
   * to something outside this set would fail at creation.
   */
  it("maps every slot to an accepted category", () => {
    const accepted = new Set([
      "full_body",
      "lower_body",
      "upper_body",
      "shoes",
      "auto",
      "outer",
    ]);
    for (const category of Object.values(CLOTH_CATEGORY_OF_SLOT)) {
      if (category !== null) {
        expect(accepted.has(category)).toBe(true);
      }
    }
  });

  /**
   * A layer goes as "outer" and shoes go as "shoes". Both used to be sent as the
   * body part underneath them, which asks the engine to put a blazer where the
   * shirt is and a shoe where the trousers are.
   */
  it("sends a layer and a shoe as their own categories", () => {
    expect(CLOTH_CATEGORY_OF_SLOT.outerwear).toBe("outer");
    expect(CLOTH_CATEGORY_OF_SLOT.shoes).toBe("shoes");
    expect(clothCategoryForType("accessory")).toBeNull();
  });
});

describe("skin simulation body", () => {
  /**
   * Answered "One or more parameters in this request are invalid."
   *
   * The concerns are top level fields, not a list. The array shape this replaced
   * answered "Simulation intensity cannot be all zero", because an unknown field
   * is dropped and nothing was left above zero.
   */
  it("sends one top level field per concern", () => {
    expect(
      simulationTaskBody({
        fileId: FILE_ID,
        params: {
          captureId: CAPTURE_ID,
          concerns: ["dark_spots", "texture", "pores", "oiliness"],
        },
      }),
    ).toEqual({
      src_file_id: FILE_ID,
      spots: 1,
      texture: 1,
      pores: 1,
      oiliness: 1,
    });
  });

  /**
   * The two names that are singular on the endpoint and plural in our own
   * concern keys. Sending the plural lands in the same bin the array did.
   */
  it("sends wrinkle and dark_circle in the singular", () => {
    expect(
      simulationTaskBody({
        fileId: FILE_ID,
        params: {
          captureId: CAPTURE_ID,
          concerns: ["wrinkles", "dark_circles"],
        },
      }),
    ).toEqual({ src_file_id: FILE_ID, wrinkle: 1, dark_circle: 1 });
  });

  it("renders nothing when no concern can be simulated", () => {
    expect(
      simulationTaskBody({
        fileId: FILE_ID,
        params: { captureId: CAPTURE_ID, concerns: ["not_a_concern"] },
      }),
    ).toBeNull();
  });
});

describe("accessory try on body", () => {
  /**
   * Answered "One or more parameters in this request are invalid."
   *
   * Without source_info and object_infos the same request answers "source_info
   * is required but wasn't included in your request., or object_infos is
   * required but wasn't included in your request.", so the watch try on this
   * build offers would have failed on every tap.
   */
  it("sends all four fields the 2d-vto endpoints require", () => {
    expect(
      accessoryTaskBody({
        fileId: FILE_ID,
        referenceFileId: REFERENCE_FILE_ID,
        params: {
          captureId: CAPTURE_ID,
          garmentId: "garment-1",
          category: "watch",
        },
      }),
    ).toEqual({
      src_file_id: FILE_ID,
      ref_file_ids: [REFERENCE_FILE_ID],
      source_info: { name: FILE_ID },
      object_infos: [{ name: REFERENCE_FILE_ID }],
    });
  });

  /**
   * The bag endpoint is not a 2d-vto endpoint: it takes a single ref_file_id and
   * a required gender this app does not hold. Sending it the shape above would
   * be sending the wrong body, so nothing is sent at all.
   */
  it("sends nothing for the bag, whose endpoint is a different API", () => {
    expect(
      accessoryTaskBody({
        fileId: FILE_ID,
        referenceFileId: REFERENCE_FILE_ID,
        params: {
          captureId: CAPTURE_ID,
          garmentId: "garment-1",
          category: "bag",
        },
      }),
    ).toBeNull();
  });
});

describe("what the endpoint registry is allowed to call", () => {
  /** The gate every screen and the client both read. */
  const confirmed = (key: Parameters<typeof getEndpoint>[0]): boolean =>
    getEndpoint(key).verification.state === "confirmed";

  it("can call every fixed render kind", () => {
    expect(confirmed("makeupTryOn")).toBe(true);
    expect(confirmed("hairstyleTryOn")).toBe(true);
    expect(confirmed("hairColorTryOn")).toBe(true);
    expect(confirmed("clothTryOn")).toBe(true);
    expect(confirmed("skinSimulation")).toBe(true);
  });

  /**
   * The earrings and the bag stay refused: their paths are corrected and real
   * now, but their unit costs are published nowhere we can read, so the credits
   * layer has nothing true to reserve. The screens offer the callable ones only,
   * so an accessory row draws the watch or draws nothing.
   */
  it("offers the watch and nothing else", () => {
    expect(callableAccessoryCategories(confirmed)).toEqual(["watch"]);
    expect(confirmed("earringsTryOn")).toBe(false);
    expect(confirmed("bagTryOn")).toBe(false);
  });

  /**
   * Both spellings this file used to carry answer 404 NotFound. The corrected
   * ones answer 400, which is a path that exists reading a body it does not
   * like.
   */
  it("records the corrected accessory paths", () => {
    expect(getEndpoint("earringsTryOn").createPath).toBe(
      "/s2s/v2.0/task/2d-vto/earring",
    );
    expect(getEndpoint("bagTryOn").createPath).toBe("/s2s/v2.0/task/bag");
    expect(getEndpoint("watchTryOn").createPath).toBe(
      "/s2s/v2.0/task/2d-vto/watch",
    );
  });

  it("polls a render on the path it created it on", () => {
    for (const key of [
      "makeupTryOn",
      "hairstyleTryOn",
      "hairColorTryOn",
      "clothTryOn",
      "skinSimulation",
      "watchTryOn",
    ] as const) {
      const endpoint = getEndpoint(key);
      expect(endpoint.statusPathPrefix).toBe(endpoint.createPath);
    }
  });
});
