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
  parseArgs,
  parseEnvFile,
  readImageHeader,
  runGoldenRun,
  topConcernKeyOf,
  type GoldenOptions,
  type GoldenRunIo,
} from "../../scripts/golden-run";
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
}): GoldenRunIo {
  return {
    log: (line) => args.recorder.out.push(line),
    errorLog: (line) => args.recorder.errors.push(line),
    sleep: () => Promise.resolve(),
    nowIso: () => "2026-09-02T00:00:00.000Z",
    readFile: () => args.image,
    writeFile: (path, bytes) => {
      args.recorder.written.set(path.replace(/\\/gu, "/"), bytes);
    },
    ensureDir: (path) => {
      args.recorder.dirs.push(path);
    },
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
    spendUnits: 40,
    steps: [...DEFAULT_STEPS],
    outDir: "out",
    confirm: true,
    assumeUnknownUnits: 1,
    captureId: "golden-01",
    fixtureId: "live-01",
    makeupCategories: ["lip"],
    hairstyleStyleId: "textured-crop",
    hairstyleTemplateId: null,
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

/** The skin analysis payload shape the provider schema accepts. */
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
          raw_score: 0.71,
          mask_urls: ["https://example.invalid/mask-spot.png"],
        },
        { type: "wrinkle", ui_score: 22, raw_score: 0.22 },
      ],
      skin_age: 31,
      all: { score: 80 },
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

  it("names the rows the cost table cannot price yet", () => {
    const plan = buildPlan(optionsFor({ steps: ["skin", "tone"] }));
    expect(plan.unknownCostSteps).toContain("skin");
    expect(plan.unknownCostSteps).not.toContain("tone");
  });

  it("names the endpoints that are not confirmed against the live docs", () => {
    const plan = buildPlan(optionsFor({ steps: ["tone", "makeup"] }));
    expect(plan.unverifiedSteps).toContain("tone");
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
/* The hairstyle template gap                                          */
/* ------------------------------------------------------------------ */

describe("golden-run hairstyle template", () => {
  it("has no template in the catalog yet, so the body cannot be built", () => {
    expect(
      hairstyleBodyFor({ fileId: "f", styleId: "textured-crop", templateId: null }),
    ).toBeNull();
  });

  it("builds the body from a template passed on the command line", () => {
    expect(
      hairstyleBodyFor({ fileId: "f", styleId: "textured-crop", templateId: "tpl-9" }),
    ).toEqual({ src_file_id: "f", template_id: "tpl-9" });
  });

  it("stops before the upload when hairstyle has no template", async () => {
    const recorder = makeRecorder();
    const code = await runGoldenRun(
      optionsFor({ steps: ["hairstyle"], hairstyleTemplateId: null }),
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

  it("says it is not synthetic and flags the expectations for review", async () => {
    const recorder = await runFullPass();
    const golden = fixtureFrom(recorder) as {
      readonly synthetic: boolean;
      readonly _golden: { readonly expectedNeedsHumanReview: boolean };
    };
    expect(golden.synthetic).toBe(false);
    expect(golden._golden.expectedNeedsHumanReview).toBe(true);
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
