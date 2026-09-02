import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the two credit spending scripts.
 *
 * This is not an eval suite. It lives under evals/ only because that is where
 * vitest.config.mts looks (src and evals, nothing else), and it is deliberately
 * not in eval:smoke. It runs on npm run test with every provider function
 * mocked, so it spends nothing and reaches no network.
 *
 * What it is here to prove, in the order the money is at risk:
 *
 * 1. The plan arithmetic matches the provider cost table.
 * 2. A plan over --spend aborts before the first call.
 * 3. Nothing runs without a confirmation.
 * 4. The fixture that gets written has the shape the eval loaders read.
 * 5. A failure stops the run instead of moving to the next paid call.
 * 6. record-serpapi refuses a plan over --max.
 */

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React server environment. The mock replaces that marker package and nothing
 * else, so the real planning, normalizing, and shade code runs here exactly as
 * it does on the server.
 */
vi.mock("server-only", () => ({}));

/**
 * Only the four provider functions that touch the network are replaced. The
 * cost table, the endpoint registry, and every parser stay real, because the
 * arithmetic under test is theirs.
 */
vi.mock("@/lib/server/providers/perfectcorp", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/server/providers/perfectcorp")
  >("@/lib/server/providers/perfectcorp");
  return {
    ...actual,
    uploadImages: vi.fn(),
    uploadImage: vi.fn(),
    createTask: vi.fn(),
    getTaskSnapshot: vi.fn(),
    downloadResultAssets: vi.fn(),
    /**
     * The free credit balance reader lands with the Perfect Corp auth work on
     * its own branch, so it is not on this module today. The script probes for
     * it rather than importing it, and this entry is what lets both paths be
     * tested: it rejects by default, which is the branch that runs today, and
     * one test resolves it to exercise the measured spend.
     */
    getCreditBalance: vi.fn(),
  };
});

vi.mock("@/lib/server/providers/serpapi/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/server/providers/serpapi/client")
  >("@/lib/server/providers/serpapi/client");
  return {
    ...actual,
    serpApiSearch: vi.fn(),
    isSerpApiConfigured: vi.fn(() => true),
    readSerpApiConfig: vi.fn(() => ({
      apiKey: "not-a-real-key",
      defaultGl: "in",
      defaultHl: "en",
    })),
  };
});

import { loadAnalysisFixtures } from "../fixtures/analyses";
import * as perfectcorpModule from "@/lib/server/providers/perfectcorp";
import {
  createTask,
  getTaskSnapshot,
  downloadResultAssets,
  uploadImage,
  unitsForCall,
} from "@/lib/server/providers/perfectcorp";
import { serpApiSearch } from "@/lib/server/providers/serpapi/client";
import {
  MAKEUP_INTENSITY,
  makeupTaskBody,
} from "@/lib/server/renders/makeup";

import {
  DEFAULT_STEPS,
  GOLDEN_STEP_KEYS,
  GoldenRunError,
  assertNoSecret,
  assertProviderCallsEnabled,
  assertWithinSpend,
  buildGoldenFixture,
  buildPlan,
  checkImageAgainstPlan,
  formatPlan,
  goldenFixtureSchema,
  hairstyleBodyFor,
  buildIngestManifest,
  localMaskFileFor,
  makeupParamsFrom,
  mergeCallRecords,
  parseArgs,
  parseEnvFile,
  parseShadeOverrides,
  readImageHeader,
  readPreviousManifest,
  runGoldenRun,
  runSkinIngest,
  topConcernKeyOf,
  topPresenceLines,
  type GoldenOptions,
  type GoldenRunIo,
} from "../../scripts/golden-run";
import { loadSkinAnalysisStatus } from "../fixtures/perfectcorp";
import {
  DEFAULT_MAX_SEARCHES,
  assertWithinMax,
  collectQueries,
  parseRecordArgs,
  runRecordSerpApi,
  slugFor,
  stripResponse,
  type RecordIo,
} from "../../scripts/record-serpapi";

/* ------------------------------------------------------------------ */
/* Doubles                                                             */
/* ------------------------------------------------------------------ */

interface Recorder {
  readonly out: string[];
  readonly errors: string[];
  readonly written: Map<string, string | Uint8Array>;
  readonly dirs: string[];
}

function makeIo(args: {
  readonly recorder: Recorder;
  readonly image: Uint8Array;
  readonly confirmAnswer?: boolean;
  /** Files the ingest tests put on the fake disk, keyed by forward slash path. */
  readonly files?: ReadonlyMap<string, Uint8Array | string>;
}): GoldenRunIo {
  const key = (path: string): string => path.replace(/\\/gu, "/");
  const files = args.files ?? new Map<string, Uint8Array | string>();
  const find = (path: string): Uint8Array | string | undefined => {
    const wanted = key(path);
    for (const [name, value] of files) {
      if (wanted === name || wanted.endsWith(`/${name}`)) {
        return value;
      }
    }
    return undefined;
  };
  return {
    log: (line) => args.recorder.out.push(line),
    errorLog: (line) => args.recorder.errors.push(line),
    sleep: () => Promise.resolve(),
    nowIso: () => "2026-09-02T00:00:00.000Z",
    readFile: (path) => {
      const found = find(path);
      if (found === undefined) {
        return args.image;
      }
      return typeof found === "string" ? new TextEncoder().encode(found) : found;
    },
    writeFile: (path, bytes) => {
      args.recorder.written.set(key(path), bytes);
    },
    ensureDir: (path) => {
      args.recorder.dirs.push(path);
    },
    exists: (path) => find(path) !== undefined,
    confirm: () => Promise.resolve(args.confirmAnswer ?? true),
  };
}

function makeRecorder(): Recorder {
  return { out: [], errors: [], written: new Map(), dirs: [] };
}

/** A one by one JPEG, enough for the header reader and nothing else. */
function jpegBytes(width: number, height: number, padTo = 4096): Uint8Array {
  const head = [
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // length 17
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
  ];
  const bytes = new Uint8Array(Math.max(padTo, head.length));
  bytes.set(head, 0);
  return bytes;
}

function pngBytes(width: number, height: number, padTo = 4096): Uint8Array {
  const bytes = new Uint8Array(Math.max(padTo, 24));
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function optionsFor(overrides: Partial<GoldenOptions> = {}): GoldenOptions {
  return {
    imagePath: "selfie.jpg",
    /*
     * Above the 46 units the three default steps now come to (skin 16, tone 20,
     * attr 10). It was 40 while skin analysis was unpriced and counted as one.
     */
    spendUnits: 60,
    steps: [...DEFAULT_STEPS],
    outDir: "out",
    confirm: true,
    assumeUnknownUnits: 1,
    captureId: "golden-01",
    fixtureId: "live-01",
    makeupCategories: ["lip"],
    makeupShades: {},
    renderLabel: null,
    hairstyleStyleId: "textured-crop",
    hairstyleTemplateId: null,
    ingestSkinPath: null,
    ...overrides,
  };
}

/**
 * The credit balance reader, reached through the namespace because it is not on
 * the module's type today. See the note in the mock factory above.
 */
const creditBalanceMock = (
  perfectcorpModule as unknown as Record<string, ReturnType<typeof vi.fn>>
).getCreditBalance;

/**
 * The skin analysis payload, in the shape the live API really sends.
 *
 * It used to be a guess: two scored entries plus skin_age and all as siblings
 * of output. The recorded response says otherwise, so this now mirrors it:
 * every value lives inside output, "all" and "skin_age" carry their number
 * under "score", and skin_type repeats per zone with no score at all.
 */
function skinSnapshot() {
  return {
    endpointKey: "skinAnalysis" as const,
    taskId: "task-skin",
    state: "succeeded" as const,
    results: {
      output: [
        {
          type: "age_spot",
          ui_score: 71,
          raw_score: 71.4,
          mask_urls: ["https://example.invalid/mask-spot.png"],
          url: null,
        },
        { type: "wrinkle", ui_score: 22, raw_score: 22.3, url: null },
        {
          type: "skin_type",
          region: "t_zone",
          skin_type: "Normal",
          mask_urls: ["https://example.invalid/mask-zone.png"],
          url: null,
        },
        { type: "all", score: 80, url: null },
        { type: "skin_age", score: 31, url: null },
      ],
    },
    errorCode: null,
    pollingIntervalSeconds: null,
  };
}

function toneSnapshot() {
  return {
    endpointKey: "facialColorTones" as const,
    taskId: "task-tone",
    state: "succeeded" as const,
    results: {
      color: {
        skin_color: "#6b4a2f",
        eye_color: "#3b2b22",
        eye_color_name: "brown",
        lip_color: "#8a4a44",
        eyebrow_color: "#20180f",
        hair_color: "#1e1613",
        hair_color_name: "black",
      },
    },
    errorCode: null,
    pollingIntervalSeconds: null,
  };
}

function attrSnapshot() {
  return {
    endpointKey: "faceAttributes" as const,
    taskId: "task-attr",
    state: "succeeded" as const,
    results: { faceShape: "Oval" },
    errorCode: null,
    pollingIntervalSeconds: null,
  };
}

beforeEach(() => {
  vi.mocked(uploadImage).mockReset();
  vi.mocked(createTask).mockReset();
  vi.mocked(getTaskSnapshot).mockReset();
  vi.mocked(downloadResultAssets).mockReset();
  vi.mocked(serpApiSearch).mockReset();
  creditBalanceMock.mockReset();
  // The branch that runs today: no credit endpoint, so spend is counted from
  // the cost table.
  creditBalanceMock.mockRejectedValue(new Error("no credit endpoint here"));

  vi.mocked(uploadImage).mockResolvedValue({
    fileId: "file-1",
    fileName: "golden-01.jpg",
    contentType: "image/jpeg",
  });
  vi.mocked(downloadResultAssets).mockResolvedValue([
    {
      sourceUrl: "https://example.invalid/mask-spot.png",
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: "image/png",
    },
  ]);
});

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

describe("golden-run arguments", () => {
  it("requires an image and a spend ceiling", () => {
    expect(() => parseArgs(["--spend", "40"])).toThrow(/--image is required/u);
    expect(() => parseArgs(["--image", "a.jpg"])).toThrow(/--spend is required/u);
  });

  it("defaults to the three analyses and refuses an unknown step", () => {
    const parsed = parseArgs(["--image", "a.jpg", "--spend", "40"]);
    expect(parsed.steps).toEqual(["skin", "tone", "attr"]);
    expect(() =>
      parseArgs(["--image", "a.jpg", "--spend", "40", "--steps", "skin,fitzpatrick"]),
    ).toThrow(/does not know fitzpatrick/u);
  });

  it("orders steps by the catalog, not by typing order, and drops repeats", () => {
    const parsed = parseArgs([
      "--image",
      "a.jpg",
      "--spend",
      "40",
      "--steps",
      "makeup,skin,skin,tone",
    ]);
    expect(parsed.steps).toEqual(["skin", "tone", "makeup"]);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    expect(() =>
      parseArgs(["--image", "a.jpg", "--spend", "40", "--spendd", "99"]),
    ).toThrow(/Unknown argument/u);
  });

  it("refuses a spend that is not a whole number above zero", () => {
    expect(() => parseArgs(["--image", "a.jpg", "--spend", "0"])).toThrow(
      /whole number above zero/u,
    );
    expect(() => parseArgs(["--image", "a.jpg", "--spend", "4.5"])).toThrow(
      /whole number above zero/u,
    );
  });
});

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

describe("golden-run plan arithmetic", () => {
  it("prices every call from the provider cost table", () => {
    const plan = buildPlan(optionsFor({ steps: ["skin", "tone", "attr"] }));
    const byStep = new Map(plan.calls.map((call) => [call.step, call]));

    expect(byStep.get("tone")?.endpointKey).toBe("facialColorTones");
    expect(byStep.get("tone")?.tableUnits).toBe(unitsForCall("facialColorTones", 1));
    expect(byStep.get("attr")?.endpointKey).toBe("faceAttributes");
    expect(byStep.get("attr")?.tableUnits).toBe(unitsForCall("faceAttributes", 1));
    expect(byStep.get("skin")?.endpointKey).toBe("skinAnalysis");
    // Measured live on 2026-09-02: one task took the balance from 40 to 24.
    expect(byStep.get("skin")?.tableUnits).toBe(16);
  });

  it("adds up to the sum of the rows, with the unknown row counted as assumed", () => {
    const options = optionsFor({
      steps: ["skin", "tone", "attr"],
      assumeUnknownUnits: 5,
    });
    const plan = buildPlan(options);
    const expected = plan.calls.reduce((sum, call) => sum + call.assumedUnits, 0);
    expect(plan.assumedTotalUnits).toBe(expected);
    for (const call of plan.calls) {
      expect(call.assumedUnits).toBe(call.tableUnits ?? 5);
    }
  });

  it("has no unpriced row left among the steps it can run", () => {
    /*
     * skin was the one unpriced step until 2026-09-02, when one live task
     * measured it at 16 units. Every golden step is now priced from the table,
     * so the plan names nothing. The mechanism that reports an unpriced row is
     * still exercised by the assumed units test above.
     */
    const plan = buildPlan(optionsFor({ steps: GOLDEN_STEP_KEYS }));
    expect(plan.unknownCostSteps).toEqual([]);
    expect(unitsForCall("skinAnalysis")).toBe(16);
  });

  it("names the endpoints that are not confirmed against the live docs", () => {
    /*
     * "attr" is the face attributes path, which nothing has called yet. "tone"
     * used to be on this list and came off it: the golden run created a task at
     * /s2s/v2.0/task/skin-tone-analysis, it succeeded and measured 20 units, and
     * a path a real task ran on is not an inference any more.
     */
    const plan = buildPlan(optionsFor({ steps: ["attr", "tone", "makeup"] }));
    expect(plan.unverifiedSteps).toContain("attr");
    expect(plan.unverifiedSteps).not.toContain("tone");
    expect(plan.unverifiedSteps).not.toContain("makeup");
  });

  it("prices the renders at the documented 1 and 2 units", () => {
    const plan = buildPlan(optionsFor({ steps: ["makeup", "hairstyle"] }));
    const byStep = new Map(plan.calls.map((call) => [call.step, call]));
    expect(byStep.get("makeup")?.tableUnits).toBe(1);
    expect(byStep.get("hairstyle")?.tableUnits).toBe(2);
    expect(plan.assumedTotalUnits).toBe(3);
  });

  it("prints the upload as free and every call with its cost", () => {
    const options = optionsFor({ steps: ["skin", "tone"] });
    const text = formatPlan(buildPlan(options), options);
    expect(text).toContain("Free, no task is created");
    expect(text).toContain("facialColorTones 20 units");
    expect(text).toContain("Deliberately not run:");
    expect(text).toContain("fitzpatrick");
    expect(text).toContain("hairType");
  });

  it("covers every step in the catalog", () => {
    const plan = buildPlan(optionsFor({ steps: GOLDEN_STEP_KEYS }));
    expect(plan.calls).toHaveLength(GOLDEN_STEP_KEYS.length);
  });
});

describe("golden-run spend ceiling", () => {
  it("passes a plan that fits", () => {
    const options = optionsFor({ steps: ["makeup"], spendUnits: 1 });
    expect(() => assertWithinSpend(buildPlan(options), options)).not.toThrow();
  });

  it("aborts a plan that does not fit", () => {
    const options = optionsFor({ steps: ["tone"], spendUnits: 19 });
    expect(() => assertWithinSpend(buildPlan(options), options)).toThrow(
      GoldenRunError,
    );
    expect(() => assertWithinSpend(buildPlan(options), options)).toThrow(
      /comes to 20 units and --spend is 19/u,
    );
  });

  it("makes no provider call at all when the plan is over the ceiling", async () => {
    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["tone", "attr"], spendUnits: 5 }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    expect(code).toBe(1);
    expect(vi.mocked(uploadImage)).not.toHaveBeenCalled();
    expect(vi.mocked(createTask)).not.toHaveBeenCalled();
    expect(recorder.errors.join("\n")).toMatch(/Nothing was called/u);
  });
});

/* ------------------------------------------------------------------ */
/* The confirmation gate                                               */
/* ------------------------------------------------------------------ */

describe("golden-run confirmation", () => {
  it("spends nothing when the operator does not agree", async () => {
    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ confirm: false, steps: ["tone"] }),
      makeIo({
        recorder,
        image: jpegBytes(1024, 1024),
        confirmAnswer: false,
      }),
    );
    expect(code).toBe(1);
    expect(vi.mocked(uploadImage)).not.toHaveBeenCalled();
    expect(recorder.out.join("\n")).toMatch(/Nothing was spent/u);
  });

  it("runs when --confirm was passed, without asking", async () => {
    vi.mocked(getTaskSnapshot).mockResolvedValue(toneSnapshot());
    vi.mocked(createTask).mockResolvedValue({
      endpointKey: "facialColorTones",
      taskId: "task-tone",
      unitsReserved: 20,
    });
    const recorder = makeRecorder();
    const io = makeIo({ recorder, image: jpegBytes(1024, 1024) });
    const confirmSpy = vi.spyOn(io, "confirm");

    await runGoldenRun(optionsFor({ steps: ["tone"], confirm: true }), io);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* The image gate                                                      */
/* ------------------------------------------------------------------ */

describe("golden-run image checks", () => {
  it("reads the size out of a JPEG frame header", () => {
    expect(readImageHeader(jpegBytes(1024, 768))).toMatchObject({
      contentType: "image/jpeg",
      width: 1024,
      height: 768,
    });
  });

  it("reads the size out of a PNG IHDR", () => {
    expect(readImageHeader(pngBytes(800, 1200))).toMatchObject({
      contentType: "image/png",
      width: 800,
      height: 1200,
    });
  });

  it("returns null for anything that is not a JPEG or a PNG", () => {
    expect(readImageHeader(new Uint8Array(64))).toBeNull();
  });

  it("catches a frame too large for the hairstyle endpoint before it is sent", () => {
    const plan = buildPlan(optionsFor({ steps: ["hairstyle"] }));
    const problems = checkImageAgainstPlan(
      { contentType: "image/jpeg", width: 2048, height: 2048, byteLength: 1000 },
      plan,
    );
    expect(problems.join(" ")).toMatch(/hairstyleTryOn takes a long side of at most 1024/u);
  });

  it("catches a PNG sent to an endpoint that only takes JPEG", () => {
    const plan = buildPlan(optionsFor({ steps: ["tone"] }));
    const problems = checkImageAgainstPlan(
      { contentType: "image/png", width: 1024, height: 1024, byteLength: 1000 },
      plan,
    );
    expect(problems.join(" ")).toMatch(/facialColorTones takes image\/jpeg/u);
  });

  it("refuses to call anything when the image fails the size check", async () => {
    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["hairstyle"], hairstyleTemplateId: "t-1" }),
      makeIo({ recorder, image: jpegBytes(4000, 4000) }),
    );
    expect(code).toBe(1);
    expect(vi.mocked(uploadImage)).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Chosen shades, and keeping a re render beside the first                */
/* ------------------------------------------------------------------ */

describe("golden-run shade overrides", () => {
  it("reads category=#RRGGBB pairs and upper cases the hex", () => {
    expect(parseShadeOverrides("lip=#9c5a44,blush=#C98A6E")).toEqual({
      lip: "#9C5A44",
      blush: "#C98A6E",
    });
  });

  it("refuses a category it does not know", () => {
    expect(() => parseShadeOverrides("eyebrow=#000000")).toThrow(GoldenRunError);
  });

  it("refuses anything that is not a six digit hex colour", () => {
    expect(() => parseShadeOverrides("lip=terracotta")).toThrow(GoldenRunError);
    expect(() => parseShadeOverrides("lip=#ABC")).toThrow(GoldenRunError);
  });

  it("refuses a pair with no equals sign, rather than dropping it", () => {
    expect(() => parseShadeOverrides("lip")).toThrow(GoldenRunError);
  });

  /*
   * The override has to reach the body, and it has to take the hex as its name.
   * Keeping the derived name would label a terracotta "True red" in the manifest.
   */
  it("sends the chosen shade instead of the derived one, named for what it is", () => {
    const params = makeupParamsFrom({
      attributesSummary: {
        skinColor: "#997357",
        eyeColor: "#0f0b0f",
        hairColor: "#FAF0BE",
      },
      captureId: "golden-01",
      categories: ["lip", "blush"],
      overrides: { lip: "#9C5A44" },
    });
    const lip = params?.categories.find((entry) => entry.category === "lip");
    const blush = params?.categories.find((entry) => entry.category === "blush");
    expect(lip).toEqual({
      category: "lip",
      shadeHex: "#9C5A44",
      shadeName: "#9C5A44",
    });
    // The row with no override still comes from the palette.
    expect(blush?.shadeHex).not.toBe("#9C5A44");
    expect(blush?.shadeName.length).toBeGreaterThan(0);
  });
});

/*
 * The strengths that produced a wearable render, pinned.
 *
 * The first paid render went out at 100 across the board and came back as stage
 * makeup: hard magenta discs and a flat red lip. These two numbers are the ones
 * a second unit bought, so a regression back towards 100 should fail here rather
 * than on a face.
 */
describe("makeup body strength", () => {
  const bodyFor = (category: string, shadeHex: string) =>
    makeupTaskBody({
      fileId: "f",
      params: { captureId: "c", categories: [{ category, shadeHex, shadeName: "n" }] },
    }) as { effects: { palettes: { colorIntensity: number }[] }[] };

  it("sends the tuned strength for lip and blush", () => {
    expect(bodyFor("lip", "#9C5A44").effects[0].palettes[0].colorIntensity).toBe(30);
    expect(bodyFor("blush", "#C98A6E").effects[0].palettes[0].colorIntensity).toBe(22);
  });

  it("falls back to the default for rows no render has tuned", () => {
    expect(MAKEUP_INTENSITY).toBe(35);
    expect(bodyFor("eye", "#6B4F3A").effects[0].palettes[0].colorIntensity).toBe(
      MAKEUP_INTENSITY,
    );
  });

  it("upper cases the hex, which is the form the provider documents", () => {
    expect(bodyFor("lip", "#9c5a44").effects[0].palettes[0]).toMatchObject({
      color: "#9C5A44",
    });
  });
});

describe("golden-run manifest merge", () => {
  const record = (
    step: string,
    renderLabel: string | null,
    units: number,
  ): never =>
    ({
      step,
      renderLabel,
      endpointKey: "makeupTryOn",
      taskId: "t",
      state: "succeeded",
      tableUnits: units,
      measuredUnits: units,
      startedAt: "now",
      finishedAt: "now",
      outputs: [],
      error: null,
    }) as never;

  it("keeps the calls a previous run recorded", () => {
    const merged = mergeCallRecords(
      { calls: [{ step: "tone", taskId: "old" }] },
      [record("makeup", null, 1)],
    );
    expect(merged).toHaveLength(2);
  });

  it("replaces an unlabelled step run again, rather than doubling it", () => {
    const merged = mergeCallRecords(
      { calls: [{ step: "makeup", taskId: "old" }] },
      [record("makeup", null, 1)],
    );
    expect(merged).toHaveLength(1);
    expect((merged[0] as { taskId: string }).taskId).toBe("t");
  });

  /*
   * A labelled pass is a second take kept next to the first, so the earlier
   * render keeps its record and the spend it accounts for is not erased.
   */
  it("keeps an unlabelled render beside a labelled re render", () => {
    const merged = mergeCallRecords(
      { calls: [{ step: "makeup", taskId: "first" }] },
      [record("makeup", "natural", 1)],
    );
    expect(merged).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* The hairstyle template                                              */
/* ------------------------------------------------------------------ */

describe("golden-run hairstyle template", () => {
  it("falls back to the catalog when no template is passed", () => {
    expect(
      hairstyleBodyFor({ fileId: "f", styleId: "textured-crop", templateId: null }),
    ).toEqual({ src_file_id: "f", template_id: "male_textured_crop" });
  });

  it("prefers a template passed on the command line over the catalog", () => {
    expect(
      hairstyleBodyFor({ fileId: "f", styleId: "textured-crop", templateId: "tpl-9" }),
    ).toEqual({ src_file_id: "f", template_id: "tpl-9" });
  });

  it("stops before the upload when the style id is not in the catalog", async () => {
    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({
        steps: ["hairstyle"],
        hairstyleStyleId: "not-a-style",
        hairstyleTemplateId: null,
      }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    expect(code).toBe(1);
    expect(vi.mocked(uploadImage)).not.toHaveBeenCalled();
    expect(recorder.errors.join("\n")).toMatch(/--hairstyle-template/u);
  });
});

/* ------------------------------------------------------------------ */
/* Stop on failure                                                     */
/* ------------------------------------------------------------------ */

describe("golden-run stop on failure", () => {
  it("stops at the first failed call and never starts the next paid one", async () => {
    vi.mocked(createTask)
      .mockResolvedValueOnce({
        endpointKey: "skinAnalysis",
        taskId: "task-skin",
        unitsReserved: null,
      })
      .mockResolvedValueOnce({
        endpointKey: "facialColorTones",
        taskId: "task-tone",
        unitsReserved: 20,
      });
    vi.mocked(getTaskSnapshot).mockResolvedValue({
      endpointKey: "skinAnalysis",
      taskId: "task-skin",
      state: "failed",
      results: undefined,
      errorCode: "InternalError",
      pollingIntervalSeconds: null,
    });

    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["skin", "tone", "attr"] }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );

    expect(code).toBe(1);
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
    expect(recorder.errors.join("\n")).toMatch(/retried automatically/u);
  });

  it("never retries a call that threw", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("network down"));
    const recorder = makeRecorder();
    await runGoldenRun(
      optionsFor({ steps: ["tone"] }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
  });

  it("still writes a manifest that says what was spent before the failure", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("network down"));
    const recorder = makeRecorder();
    await runGoldenRun(
      optionsFor({ steps: ["tone"], outDir: "out" }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    const manifestPath = [...recorder.written.keys()].find((path) =>
      path.endsWith("manifest.json"),
    );
    expect(manifestPath).toBeDefined();
    const manifest = JSON.parse(
      String(recorder.written.get(manifestPath ?? "")),
    ) as { readonly calls: ReadonlyArray<{ readonly state: string }> };
    expect(manifest.calls[0]?.state).toBe("failed");
  });

  it("stops before a call that would cross the ceiling mid run", async () => {
    vi.mocked(createTask).mockResolvedValue({
      endpointKey: "facialColorTones",
      taskId: "task-tone",
      unitsReserved: 20,
    });
    vi.mocked(getTaskSnapshot).mockResolvedValue(toneSnapshot());

    /*
     * The plan fits (tone 20 plus attr 10 is 30, under the ceiling of 40), so
     * assertWithinSpend passes. Then the balance says the first call really
     * cost 35, which is what the cost table cannot know. The guard before the
     * second call is the only thing left, and this is what it is for.
     */
    creditBalanceMock
      .mockReset()
      .mockResolvedValueOnce({ totalUnits: 40, grants: [] })
      .mockResolvedValueOnce({ totalUnits: 5, grants: [] });

    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["tone", "attr"], spendUnits: 40 }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    expect(code).toBe(1);
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
    expect(recorder.errors.join("\n")).toMatch(/Stopping before attr/u);
  });

  it("prices a call from the balance when the balance can be read", async () => {
    vi.mocked(createTask).mockResolvedValue({
      endpointKey: "facialColorTones",
      taskId: "task-tone",
      unitsReserved: 20,
    });
    vi.mocked(getTaskSnapshot).mockResolvedValue(toneSnapshot());
    creditBalanceMock
      .mockReset()
      .mockResolvedValueOnce({ totalUnits: 40, grants: [] })
      .mockResolvedValueOnce({ totalUnits: 18, grants: [] });

    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["tone"], spendUnits: 40 }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    expect(code).toBe(0);

    const manifestPath = [...recorder.written.keys()].find((path) =>
      path.endsWith("manifest.json"),
    );
    const manifest = JSON.parse(
      String(recorder.written.get(manifestPath ?? "")),
    ) as {
      readonly spend: {
        readonly measured: boolean;
        readonly spentUnits: number;
        readonly balanceAfterUnits: number;
      };
      readonly calls: ReadonlyArray<{ readonly measuredUnits: number }>;
    };
    expect(manifest.spend.measured).toBe(true);
    expect(manifest.spend.spentUnits).toBe(22);
    expect(manifest.spend.balanceAfterUnits).toBe(18);
    expect(manifest.calls[0]?.measuredUnits).toBe(22);
  });
});

/* ------------------------------------------------------------------ */
/* The fixture                                                         */
/* ------------------------------------------------------------------ */

describe("golden-run fixture", () => {
  async function runFullPass(): Promise<Recorder> {
    vi.mocked(createTask)
      .mockResolvedValueOnce({
        endpointKey: "skinAnalysis",
        taskId: "task-skin",
        unitsReserved: null,
      })
      .mockResolvedValueOnce({
        endpointKey: "facialColorTones",
        taskId: "task-tone",
        unitsReserved: 20,
      })
      .mockResolvedValueOnce({
        endpointKey: "faceAttributes",
        taskId: "task-attr",
        unitsReserved: 10,
      });
    vi.mocked(getTaskSnapshot)
      .mockResolvedValueOnce(skinSnapshot())
      .mockResolvedValueOnce(toneSnapshot())
      .mockResolvedValueOnce(attrSnapshot());

    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["skin", "tone", "attr"], outDir: "out" }),
      makeIo({ recorder, image: jpegBytes(1024, 1024) }),
    );
    expect(code).toBe(0);
    return recorder;
  }

  function fixtureFrom(recorder: Recorder): unknown {
    const path = [...recorder.written.keys()].find((name) =>
      name.endsWith("live-01.json"),
    );
    expect(path).toBeDefined();
    return JSON.parse(String(recorder.written.get(path ?? "")));
  }

  it("writes a fixture that parses against its own schema", async () => {
    const recorder = await runFullPass();
    expect(() => goldenFixtureSchema.parse(fixtureFrom(recorder))).not.toThrow();
  });

  it("carries the same keys as the hand written analyses fixtures", async () => {
    const recorder = await runFullPass();
    const golden = fixtureFrom(recorder) as Record<string, unknown>;
    const synthetic = loadAnalysisFixtures()[0];
    expect(synthetic).toBeDefined();

    const goldenKeys = Object.keys(golden)
      .filter((key) => key !== "_golden")
      .sort();
    expect(goldenKeys).toEqual(Object.keys(synthetic ?? {}).sort());

    expect(Object.keys(golden.expected as object).sort()).toEqual(
      Object.keys((synthetic ?? { expected: {} }).expected).sort(),
    );
    expect(Object.keys(golden.summaries as object).sort()).toEqual(
      Object.keys((synthetic ?? { summaries: {} }).summaries).sort(),
    );
  });

  it("says it is not synthetic, and no longer asks for the expectations to be reviewed", async () => {
    const recorder = await runFullPass();
    const golden = fixtureFrom(recorder) as {
      readonly synthetic: boolean;
      readonly _golden: Record<string, unknown>;
    };
    expect(golden.synthetic).toBe(false);
    /*
     * The flag existed because the expected block was derived through a
     * normalizer that read the provider's scale backwards, so the top concern
     * was whatever the face was doing best. With the inversion in place the
     * derivation is the same one the app runs, so the block is an assertion
     * rather than a description of a run.
     */
    expect(golden._golden.expectedNeedsHumanReview).toBeUndefined();
    expect(Object.keys(golden._golden).sort()).toEqual([
      "captureId",
      "imageSha256",
      "recordedOn",
      "stepsRun",
    ]);
  });

  it("leaves fitzpatrick and hair type null, because neither was run", async () => {
    const recorder = await runFullPass();
    const golden = fixtureFrom(recorder) as {
      readonly summaries: Record<string, unknown>;
      readonly expected: Record<string, unknown>;
    };
    expect(golden.summaries.fitzpatrick).toBeNull();
    expect(golden.summaries.hair_type).toBeNull();
    expect(golden.expected.fitzpatrick).toBeNull();
  });

  it("carries the normalized skin summary the profile layer reads", async () => {
    const recorder = await runFullPass();
    const golden = fixtureFrom(recorder) as {
      readonly summaries: {
        readonly skin: { readonly concerns: readonly unknown[]; readonly skinAge: number };
      };
      readonly expected: { readonly topConcernKey: string };
    };
    expect(golden.summaries.skin.concerns).toHaveLength(2);
    expect(golden.summaries.skin.skinAge).toBe(31);
    expect(golden.expected.topConcernKey.length).toBeGreaterThan(0);
  });

  it("writes the masks and the raw responses next to the fixture", async () => {
    const recorder = await runFullPass();
    const written = [...recorder.written.keys()];
    expect(written.some((path) => path.includes("/raw/skin.json"))).toBe(true);
    expect(written.some((path) => path.includes("/masks/"))).toBe(true);
  });

  it("reads the top concern by score, not by order", () => {
    expect(
      topConcernKeyOf({
        concerns: [
          { providerType: "a", key: "acne", uiScore: 10, rawScore: 0.1 },
          { providerType: "b", key: "pigmentation", uiScore: 90, rawScore: 0.9 },
        ],
      }),
    ).toBe("pigmentation");
  });

  it("never leads on a quality concern, however high its level", () => {
    /*
     * moisture and radiance carry a level, not a problem. A radiant, well
     * hydrated face would otherwise be told that radiance is the thing to work
     * on, which is what the recorded face produced before this rule existed.
     */
    expect(
      topConcernKeyOf({
        concerns: [
          { providerType: "radiance", key: "radiance", uiScore: 82, rawScore: 83 },
          { providerType: "moisture", key: "moisture", uiScore: 77, rawScore: 68 },
          { providerType: "dark_circle_v2", key: "dark_circles", uiScore: 30, rawScore: 64 },
        ],
      }),
    ).toBe("dark_circles");
  });

  it("breaks a tie on the key, so the same response always names the same concern", () => {
    const concerns = [
      { providerType: "firmness", key: "firmness", uiScore: 25, rawScore: 68 },
      { providerType: "droopy_lower_eyelid", key: "eyelid_droop", uiScore: 25, rawScore: 67 },
    ];
    expect(topConcernKeyOf({ concerns })).toBe("eyelid_droop");
    expect(topConcernKeyOf({ concerns: [...concerns].reverse() })).toBe("eyelid_droop");
  });

  it("refuses to build a fixture with no skin analysis behind it", () => {
    expect(() =>
      buildGoldenFixture({
        options: optionsFor(),
        imageSha256: "a".repeat(64),
        recordedOn: "2026-09-02T00:00:00.000Z",
        stepsRun: ["tone"],
        summaries: { attributes: {} },
      }),
    ).toThrow(GoldenRunError);
  });
});

/* ------------------------------------------------------------------ */
/* Ingest, which spends nothing                                        */
/* ------------------------------------------------------------------ */

describe("golden-run ingest", () => {
  const SOURCE = "in/skin/result.json";
  const IMAGE = jpegBytes(1024, 1024);
  const IMAGE_SHA = createHash("sha256").update(IMAGE).digest("hex");

  function ingestFiles(
    extra: ReadonlyArray<readonly [string, string | Uint8Array]> = [],
  ): Map<string, Uint8Array | string> {
    return new Map<string, Uint8Array | string>([
      [SOURCE, JSON.stringify(loadSkinAnalysisStatus())],
      ...extra,
    ]);
  }

  function ingestOptions(): GoldenOptions {
    return optionsFor({ ingestSkinPath: SOURCE, outDir: "out", steps: ["skin"] });
  }

  function writtenPath(recorder: Recorder, suffix: string): string | undefined {
    return [...recorder.written.keys()].find((path) => path.endsWith(suffix));
  }

  it("takes --ingest-skin without a spend ceiling", () => {
    const parsed = parseArgs(["--ingest-skin", SOURCE, "--image", "a.jpg"]);
    expect(parsed.ingestSkinPath).toBe(SOURCE);
    expect(parsed.spendUnits).toBe(0);
  });

  it("still requires a spend ceiling for a run that can spend", () => {
    expect(() => parseArgs(["--image", "a.jpg"])).toThrow(/--spend is required/u);
  });

  it("calls no provider function at all", () => {
    const recorder = makeRecorder();
    const code = runSkinIngest(
      ingestOptions(),
      makeIo({ recorder, image: IMAGE, files: ingestFiles() }),
    );
    expect(code).toBe(0);
    expect(vi.mocked(uploadImage)).not.toHaveBeenCalled();
    expect(vi.mocked(createTask)).not.toHaveBeenCalled();
    expect(vi.mocked(getTaskSnapshot)).not.toHaveBeenCalled();
    expect(vi.mocked(downloadResultAssets)).not.toHaveBeenCalled();
    expect(creditBalanceMock).not.toHaveBeenCalled();
  });

  it("writes the analyses fixture, the raw response, and the manifest", () => {
    const recorder = makeRecorder();
    runSkinIngest(
      ingestOptions(),
      makeIo({ recorder, image: IMAGE, files: ingestFiles() }),
    );

    const fixturePath = writtenPath(recorder, "live-01.json");
    expect(fixturePath).toBeDefined();
    expect(() =>
      goldenFixtureSchema.parse(
        JSON.parse(String(recorder.written.get(fixturePath ?? ""))),
      ),
    ).not.toThrow();
    expect(writtenPath(recorder, "/raw/skin.json")).toBeDefined();
    expect(writtenPath(recorder, "manifest.json")).toBeDefined();
  });

  it("carries the real reading into the fixture", () => {
    const recorder = makeRecorder();
    runSkinIngest(
      ingestOptions(),
      makeIo({ recorder, image: IMAGE, files: ingestFiles() }),
    );
    const fixture = JSON.parse(
      String(recorder.written.get(writtenPath(recorder, "live-01.json") ?? "")),
    ) as {
      readonly synthetic: boolean;
      readonly summaries: {
        readonly skin: {
          readonly concerns: readonly unknown[];
          readonly skinAge: number;
          readonly overallScore: number;
          readonly skinTypeZones: {
            readonly tZone: string | null;
            readonly cheeks: string | null;
          } | null;
        };
      };
      readonly _golden: { readonly stepsRun: readonly string[] };
    };

    expect(fixture.synthetic).toBe(false);
    expect(fixture.summaries.skin.concerns).toHaveLength(15);
    expect(fixture.summaries.skin.skinAge).toBe(28);
    expect(fixture.summaries.skin.overallScore).toBe(85.4);
    // The provider's own zones survive into the fixture, so the demo profile
    // reads them instead of deriving a skin type from oiliness and moisture.
    expect(fixture.summaries.skin.skinTypeZones).toEqual({
      tZone: "balanced",
      cheeks: "balanced",
    });
    expect(fixture._golden.stepsRun).toEqual(["skin"]);
  });

  it("copies the masks saved beside the response and names the ones that were not", () => {
    const recorder = makeRecorder();
    const io = makeIo({
      recorder,
      image: IMAGE,
      files: ingestFiles([
        ["in/skin/eye_bag-0.png", new Uint8Array([1, 2, 3])],
        ["in/skin/dark_circle_v2-0.png", new Uint8Array([4, 5, 6])],
      ]),
    });
    runSkinIngest(ingestOptions(), io);

    expect(writtenPath(recorder, "/masks/eye_bags.png")).toBeDefined();
    expect(writtenPath(recorder, "/masks/dark_circles.png")).toBeDefined();
    expect(writtenPath(recorder, "/masks/texture.png")).toBeUndefined();
    expect(recorder.out.join("\n")).toMatch(/No saved mask file for/u);
  });

  it("records the skin step as succeeded with the units it really cost", () => {
    const recorder = makeRecorder();
    runSkinIngest(
      ingestOptions(),
      makeIo({ recorder, image: IMAGE, files: ingestFiles() }),
    );
    const manifest = JSON.parse(
      String(recorder.written.get(writtenPath(recorder, "manifest.json") ?? "")),
    ) as {
      readonly fixtureFile: string;
      readonly calls: ReadonlyArray<{
        readonly step: string;
        readonly state: string;
        readonly measuredUnits: number;
        readonly outputs: readonly string[];
      }>;
      readonly ingest: { readonly units: number; readonly sourceFile: string };
    };

    expect(manifest.fixtureFile).toBe("live-01.json");
    expect(manifest.calls).toHaveLength(1);
    expect(manifest.calls[0]?.step).toBe("skin");
    expect(manifest.calls[0]?.state).toBe("succeeded");
    expect(manifest.calls[0]?.measuredUnits).toBe(16);
    expect(manifest.calls[0]?.outputs).toContain("raw/skin.json");
    expect(manifest.ingest.units).toBe(16);
    expect(manifest.ingest.sourceFile).toBe(SOURCE);
  });

  it("refuses when the manifest in the output folder names a different selfie", () => {
    const recorder = makeRecorder();
    const code = runSkinIngest(
      ingestOptions(),
      makeIo({
        recorder,
        image: IMAGE,
        files: ingestFiles([
          [
            "manifest.json",
            JSON.stringify({
              recordedOn: "2026-09-02T09:17:41.749Z",
              image: { sha256: "b".repeat(64) },
              calls: [],
            }),
          ],
        ]),
      }),
    );
    expect(code).toBe(1);
    expect(recorder.errors.join("\n")).toMatch(/different selfie/u);
    expect(recorder.written.size).toBe(0);
  });

  it("keeps the paid run's own spend record and its task id", () => {
    const recorder = makeRecorder();
    runSkinIngest(
      ingestOptions(),
      makeIo({
        recorder,
        image: IMAGE,
        files: ingestFiles([
          [
            "manifest.json",
            JSON.stringify({
              recordedOn: "2026-09-02T09:17:41.749Z",
              image: { sha256: IMAGE_SHA },
              spend: {
                measured: true,
                spentUnits: 16,
                balanceBeforeUnits: 40,
                balanceAfterUnits: 24,
              },
              calls: [
                {
                  step: "skin",
                  state: "failed",
                  taskId: "task-that-was-charged",
                  measuredUnits: 16,
                  outputs: [],
                },
              ],
            }),
          ],
        ]),
      }),
    );
    const manifest = JSON.parse(
      String(recorder.written.get(writtenPath(recorder, "manifest.json") ?? "")),
    ) as {
      readonly recordedOn: string;
      readonly spend: { readonly balanceAfterUnits: number };
      readonly calls: ReadonlyArray<{
        readonly state: string;
        readonly taskId: string;
      }>;
    };
    expect(manifest.recordedOn).toBe("2026-09-02T09:17:41.749Z");
    expect(manifest.spend.balanceAfterUnits).toBe(24);
    expect(manifest.calls).toHaveLength(1);
    expect(manifest.calls[0]?.state).toBe("succeeded");
    expect(manifest.calls[0]?.taskId).toBe("task-that-was-charged");
  });

  it("refuses a saved response whose task did not succeed", () => {
    const recorder = makeRecorder();
    const code = runSkinIngest(
      ingestOptions(),
      makeIo({
        recorder,
        image: IMAGE,
        files: new Map<string, Uint8Array | string>([
          [
            SOURCE,
            JSON.stringify({
              status: 200,
              data: { error: "InternalError", task_status: "error" },
            }),
          ],
        ]),
      }),
    );
    expect(code).toBe(1);
    expect(recorder.errors.join("\n")).toMatch(/no result to ingest/u);
    expect(recorder.written.size).toBe(0);
  });

  it("refuses a file that is not a task status envelope", () => {
    const recorder = makeRecorder();
    const code = runSkinIngest(
      ingestOptions(),
      makeIo({
        recorder,
        image: IMAGE,
        files: new Map<string, Uint8Array | string>([[SOURCE, '{"nope":true}']]),
      }),
    );
    expect(code).toBe(1);
    expect(recorder.written.size).toBe(0);
  });

  it("reads a previous manifest back, and shrugs at a missing one", () => {
    const recorder = makeRecorder();
    const io = makeIo({ recorder, image: IMAGE, files: ingestFiles() });
    expect(readPreviousManifest(io, "out")).toBeNull();
  });

  it("prints the top concerns the way the report will order them", () => {
    const recorder = makeRecorder();
    runSkinIngest(
      ingestOptions(),
      makeIo({ recorder, image: IMAGE, files: ingestFiles() }),
    );
    const printed = recorder.out.join("\n");
    /*
     * Deduped, so the two eyelid rows appear once, and with no quality concern
     * in sight even though radiance is the highest number in the summary.
     */
    expect(printed).toMatch(/dark_circles 30 \(provider dark_circle_v2 ui 70\)/u);
    expect(printed).toMatch(/eyelid_droop 25 \(provider droopy_lower_eyelid ui 75\)/u);
    expect(printed).not.toMatch(/droopy_upper_eyelid/u);
    expect(printed).not.toMatch(/radiance/u);
  });

  it("keeps one line per concern and skips the qualities", () => {
    expect(
      topPresenceLines(
        {
          concerns: [
            { providerType: "radiance", key: "radiance", uiScore: 82, rawScore: 83 },
            { providerType: "droopy_upper_eyelid", key: "eyelid_droop", uiScore: 21, rawScore: 75 },
            { providerType: "droopy_lower_eyelid", key: "eyelid_droop", uiScore: 25, rawScore: 67 },
            { providerType: "dark_circle_v2", key: "dark_circles", uiScore: 30, rawScore: 64 },
          ],
        },
        5,
      ),
    ).toEqual([
      "dark_circles 30 (provider dark_circle_v2 ui unknown)",
      "eyelid_droop 25 (provider droopy_lower_eyelid ui unknown)",
    ]);
  });

  it("finds a saved mask by provider type and extension", () => {
    const recorder = makeRecorder();
    const io = makeIo({
      recorder,
      image: IMAGE,
      files: new Map<string, Uint8Array | string>([
        ["in/skin/acne-0.png", new Uint8Array([1])],
      ]),
    });
    expect(
      localMaskFileFor({ io, directory: "in/skin", providerType: "acne" }),
    ).toBe("in/skin/acne-0.png");
    expect(
      localMaskFileFor({ io, directory: "in/skin", providerType: "wrinkle" }),
    ).toBeNull();
  });

  it("replaces the skin call rather than adding a second one", () => {
    const manifest = buildIngestManifest({
      previous: {
        recordedOn: "2026-09-02T09:17:41.749Z",
        calls: [
          { step: "skin", state: "failed", taskId: "t-1", outputs: [] },
          { step: "tone", state: "succeeded", taskId: "t-2", outputs: [] },
        ],
      },
      options: ingestOptions(),
      recordedOn: "2026-09-02T09:17:41.749Z",
      ingestedAt: "2026-09-03T00:00:00.000Z",
      image: {
        contentType: "image/jpeg",
        width: 767,
        height: 1024,
        byteLength: 98567,
      },
      imageSha256: "a".repeat(64),
      taskId: "t-1",
      units: 16,
      outputs: ["raw/skin.json"],
      fixtureFile: "live-01.json",
      sourcePath: SOURCE,
    });
    const calls = manifest.calls as ReadonlyArray<{ readonly step: string }>;
    expect(calls.map((call) => call.step)).toEqual(["skin", "tone"]);
  });
});

/* ------------------------------------------------------------------ */
/* Environment and secrets                                             */
/* ------------------------------------------------------------------ */

describe("golden-run environment handling", () => {
  it("parses a .env file without tripping on comments or quotes", () => {
    const parsed = parseEnvFile(
      ['# a comment', 'A=one', 'B="two"', "C='three'", "", "D=four=five"].join("\n"),
    );
    expect(parsed).toEqual({ A: "one", B: "two", C: "three", D: "four=five" });
  });

  it("refuses to run unless the kill switch says true in as many words", () => {
    expect(() => assertProviderCallsEnabled({})).toThrow(/PROVIDER_CALLS_ENABLED/u);
    expect(() =>
      assertProviderCallsEnabled({ PROVIDER_CALLS_ENABLED: "1" }),
    ).toThrow(/PROVIDER_CALLS_ENABLED/u);
    expect(() =>
      assertProviderCallsEnabled({ PROVIDER_CALLS_ENABLED: "true" }),
    ).not.toThrow();
  });

  it("refuses to write text carrying a key value, and names only the variable", () => {
    const env = { PERFECTCORP_API_KEY: "abcdefghijkl-secret" };
    expect(() => assertNoSecret("nothing here", env)).not.toThrow();
    try {
      assertNoSecret("token abcdefghijkl-secret inside", env);
      throw new Error("expected a refusal");
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("PERFECTCORP_API_KEY");
      expect(message).not.toContain("abcdefghijkl-secret");
    }
  });
});

/* ------------------------------------------------------------------ */
/* record-serpapi                                                      */
/* ------------------------------------------------------------------ */

describe("record-serpapi", () => {
  function recordIo(recorder: Recorder, confirmAnswer = true): RecordIo {
    return {
      log: (line) => recorder.out.push(line),
      errorLog: (line) => recorder.errors.push(line),
      nowIso: () => "2026-09-02T00:00:00.000Z",
      writeFile: (path, bytes) => {
        recorder.written.set(path.replace(/\\/gu, "/"), bytes);
      },
      ensureDir: (path) => recorder.dirs.push(path),
      confirm: () => Promise.resolve(confirmAnswer),
    };
  }

  it("defaults to a ceiling of twelve searches", () => {
    expect(parseRecordArgs([]).max).toBe(DEFAULT_MAX_SEARCHES);
    expect(parseRecordArgs(["--max", "3"]).max).toBe(3);
  });

  it("collects the demo routine queries and the shop the gap queries", () => {
    const queries = collectQueries();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((entry) => entry.source === "routine")).toBe(true);
    expect(new Set(queries.map((entry) => entry.query)).size).toBe(queries.length);
  });

  it("aborts a plan over --max", () => {
    const queries = collectQueries();
    expect(() =>
      assertWithinMax(queries, parseRecordArgs(["--max", "1"])),
    ).toThrow(/--max is 1/u);
  });

  it("runs no search at all when the plan is over --max", async () => {
    const recorder = makeRecorder();
    const code = await runRecordSerpApi(
      parseRecordArgs(["--max", "1", "--confirm"]),
      recordIo(recorder),
    );
    expect(code).toBe(1);
    expect(vi.mocked(serpApiSearch)).not.toHaveBeenCalled();
    expect(recorder.errors.join("\n")).toMatch(/Nothing was searched/u);
  });

  it("runs no search when the operator does not agree", async () => {
    const recorder = makeRecorder();
    const code = await runRecordSerpApi(
      parseRecordArgs(["--max", "50"]),
      recordIo(recorder, false),
    );
    expect(code).toBe(1);
    expect(vi.mocked(serpApiSearch)).not.toHaveBeenCalled();
  });

  it("runs one search per query and writes one file each", async () => {
    vi.mocked(serpApiSearch).mockResolvedValue({
      search_metadata: { id: "abc", status: "Success", raw_html_file: "drop me" },
      search_parameters: { api_key: "should not survive" },
      shopping_results: [{ title: "A cleanser", extracted_price: 9 }],
    });
    const recorder = makeRecorder();
    const code = await runRecordSerpApi(
      parseRecordArgs(["--max", "50", "--confirm"]),
      recordIo(recorder),
    );
    const queries = collectQueries();

    expect(code).toBe(0);
    expect(vi.mocked(serpApiSearch)).toHaveBeenCalledTimes(queries.length);
    expect(recorder.written.size).toBe(queries.length + 1);
  });

  it("stops at the first failed search", async () => {
    vi.mocked(serpApiSearch).mockRejectedValue(new Error("quota exhausted"));
    const recorder = makeRecorder();
    const code = await runRecordSerpApi(
      parseRecordArgs(["--max", "50", "--confirm"]),
      recordIo(recorder),
    );
    expect(code).toBe(1);
    expect(vi.mocked(serpApiSearch)).toHaveBeenCalledTimes(1);
  });

  it("strips the account fields the fixture README forbids", () => {
    const stripped = stripResponse({
      search_metadata: { id: "abc", status: "Success", json_endpoint: "x" },
      search_parameters: { q: "a", api_key: "secret" },
      serpapi_pagination: { next: "x" },
      shopping_results: [{ title: "t", serpapi_product_api: "x", api_key: "secret" }],
    }) as Record<string, unknown>;

    expect(stripped.search_parameters).toBeUndefined();
    expect(stripped.serpapi_pagination).toBeUndefined();
    expect(stripped.search_metadata).toEqual({ id: "abc", status: "Success" });
    expect(JSON.stringify(stripped)).not.toContain("secret");
    expect(JSON.stringify(stripped)).not.toContain("serpapi_product_api");
  });

  it("names a file after its query", () => {
    expect(slugFor("niacinamide serum for uneven tone")).toBe(
      "niacinamide-serum-for-uneven-tone",
    );
  });
});
