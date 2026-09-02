import { describe, expect, it, vi } from "vitest";

/*
 * scripts/seed-demo.ts imports modules under src/lib/server, every one of which
 * opens with import "server-only". That package throws outside a React Server
 * Component, so it is replaced here, the same way every other suite in evals
 * replaces it. The script itself runs under tsx with --conditions=react-server,
 * which resolves the same package to its empty module.
 */
vi.mock("server-only", () => ({}));

import type { BucketName } from "@/lib/server/db/storage";
import type { Insert } from "@/lib/server/db/types";
import { DEMO_OWNER_ID } from "@/lib/server/judge";
import {
  productCacheKey,
  sanitizeProductQuery,
  SHOPPING_ENGINE,
} from "@/lib/server/products";
import { cachedListingsSchema } from "@/lib/server/products/schemas";
import { DEMO_FIXTURE_WARDROBE } from "@/lib/server/profile/demo-fixture-wardrobe";
import {
  RECORDED_LISTING_RESPONSES,
  RECORDED_LISTINGS_GL,
  RECORDED_LISTINGS_HL,
  RECORDED_LISTINGS_RECORDED_ON,
} from "@/lib/server/profile/recorded-listings";
import {
  canonicalHairstyleParams,
  canonicalMakeupParams,
  paramsHash,
} from "@/lib/server/renders/params";
import {
  MAKEUP_CATEGORIES,
  makeupRenderParamsSchema,
} from "@/lib/shared/color-view";

import { makeupParamsFrom } from "../../scripts/golden-run";
import {
  ASSUMED_HAIRSTYLE_STYLE_ID,
  CAPTURE_IMAGE_CANDIDATES,
  DEMO_CAPTURE_ID,
  RECORDED_READING_FILE,
  SeedError,
  demoGarmentIdByFixtureId,
  demoUuid,
  exitCodeForReport,
  findCaptureImage,
  goldenManifestSchema,
  loadGoldenRun,
  parseArgs,
  parseEnvFile,
  runSeed,
  summaryLines,
  type FileSource,
  type GoldenInput,
  type GoldenManifest,
  type SeedObject,
  type SeedReport,
  type SeedTableName,
  type SeedWriter,
} from "../../scripts/seed-demo";

/**
 * Unit tests for the demo seed script.
 *
 * Nothing here reaches a network, a database, a provider, or .env.local. The
 * Supabase client is replaced by a recording double that implements the same
 * five operation seam the real writer implements, so what is asserted is the
 * rows and the objects the script decided to write, which is exactly what the
 * real writer would have sent.
 *
 * Placed under evals rather than beside the script because vitest.config.mts
 * collects src and evals only, and the config is not this change's to edit.
 */

// ---------------------------------------------------------------------------
// The recording writer
// ---------------------------------------------------------------------------

class RecordingWriter implements SeedWriter {
  /** Every operation in order, so the delete then insert order is assertable. */
  readonly calls: string[] = [];
  readonly rows = new Map<SeedTableName, unknown[]>();
  /** Kept apart from rows: product_cache is upserted, never owner scoped. */
  readonly productCacheRows: Insert<"product_cache">[] = [];
  readonly objects = new Map<string, SeedObject>();
  /** Set to make one insert fail, which is how the failure exit is exercised. */
  failInsertInto: SeedTableName | null = null;

  private key(bucket: BucketName, path: string): string {
    return `${bucket}|${path}`;
  }

  deleteOwnedRows(table: SeedTableName, ownerId: string): Promise<void> {
    this.calls.push(`delete ${table} ${ownerId}`);
    this.rows.set(table, []);
    return Promise.resolve();
  }

  insertRows<T extends SeedTableName>(
    table: T,
    inserted: readonly Insert<T>[],
  ): Promise<void> {
    if (this.failInsertInto === table) {
      return Promise.reject(
        new SeedError(`insert into ${table}`, "the database said no"),
      );
    }
    this.calls.push(`insert ${table} ${String(inserted.length)}`);
    this.rows.set(table, [...(this.rows.get(table) ?? []), ...inserted]);
    return Promise.resolve();
  }

  upsertProductCache(rows: readonly Insert<"product_cache">[]): Promise<void> {
    this.calls.push(`upsert product_cache ${String(rows.length)}`);
    this.productCacheRows.push(...rows);
    return Promise.resolve();
  }

  listObjects(bucket: BucketName, prefix: string): Promise<string[]> {
    const found: string[] = [];
    for (const object of this.objects.values()) {
      if (object.bucket === bucket && object.path.startsWith(`${prefix}/`)) {
        found.push(object.path);
      }
    }
    return Promise.resolve(found);
  }

  removeObjects(bucket: BucketName, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      this.calls.push(`remove ${bucket} ${path}`);
      this.objects.delete(this.key(bucket, path));
    }
    return Promise.resolve();
  }

  putObject(object: SeedObject): Promise<void> {
    this.calls.push(`put ${object.bucket} ${object.path}`);
    this.objects.set(this.key(object.bucket, object.path), object);
    return Promise.resolve();
  }

  rowsOf(table: SeedTableName): Record<string, unknown>[] {
    return (this.rows.get(table) ?? []) as Record<string, unknown>[];
  }
}

function seed(args: {
  readonly writer: SeedWriter;
  readonly golden?: GoldenInput | null;
}): Promise<SeedReport> {
  return runSeed({
    writer: args.writer,
    mode: args.golden === undefined || args.golden === null ? "fixtures" : "golden",
    golden: args.golden ?? null,
    dryRun: false,
    log: () => {
      // The tests assert on the report, not on the transcript.
    },
  });
}

// ---------------------------------------------------------------------------
// A golden run, in memory
// ---------------------------------------------------------------------------

const SKIN_SUMMARY = {
  concerns: [
    {
      providerType: "pigmentation_cheek",
      key: "pigmentation",
      uiScore: 71,
      rawScore: 71,
    },
    { providerType: "oiliness", key: "oiliness", uiScore: 58, rawScore: 58 },
    { providerType: "pores", key: "pores", uiScore: 24, rawScore: 24 },
  ],
  skinAge: 31,
  overallScore: 72,
};

const ATTRIBUTES_SUMMARY = {
  skinColor: "#6b4a2f",
  eyeColor: "#3b2b22",
  eyeColorName: "Deep brown",
  lipColor: "#7a4436",
  eyebrowColor: "#1e1613",
  hairColor: "#1e1613",
  hairColorName: "Near black",
};

/** The file layout scripts/golden-run.ts writes, as a literal. */
const GOLDEN_JSON: Readonly<Record<string, unknown>> = {
  "manifest.json": {
    recordedOn: "2026-09-02T09:00:00.000Z",
    captureId: "golden-01",
    fixtureFile: "live-01.json",
    image: {
      sha256: "a".repeat(64),
      contentType: "image/jpeg",
      width: 1024,
      height: 1024,
      byteLength: 240_000,
    },
    spend: { ceilingUnits: 34, spentUnits: 30 },
    skippedAnalyses: [{ key: "fitzpatrick", reason: "10 units for one number." }],
    calls: [
      {
        step: "skin",
        endpointKey: "skinAnalysis",
        taskId: "task-skin",
        state: "succeeded",
        tableUnits: 8,
        measuredUnits: 9,
        startedAt: "2026-09-02T09:00:00.000Z",
        finishedAt: "2026-09-02T09:00:30.000Z",
        outputs: ["raw/skin.json", "masks/pigmentation.png"],
        error: null,
      },
      {
        step: "tone",
        endpointKey: "skinTone",
        taskId: "task-tone",
        state: "succeeded",
        tableUnits: 3,
        measuredUnits: null,
        startedAt: "2026-09-02T09:01:00.000Z",
        finishedAt: "2026-09-02T09:01:20.000Z",
        outputs: ["raw/tone.json"],
        error: null,
      },
      {
        step: "attr",
        endpointKey: "faceAttributes",
        taskId: "task-attr",
        state: "succeeded",
        tableUnits: 2,
        measuredUnits: 2,
        startedAt: "2026-09-02T09:02:00.000Z",
        finishedAt: "2026-09-02T09:02:10.000Z",
        outputs: ["raw/attr.json"],
        error: null,
      },
      {
        step: "makeup",
        endpointKey: "makeupTryOn",
        taskId: "task-makeup",
        state: "succeeded",
        tableUnits: 4,
        measuredUnits: 4,
        startedAt: "2026-09-02T09:03:00.000Z",
        finishedAt: "2026-09-02T09:03:40.000Z",
        outputs: ["renders/makeup-1.png"],
        error: null,
      },
      {
        step: "hairstyle",
        endpointKey: "hairstyleTryOn",
        taskId: "task-hair",
        state: "succeeded",
        tableUnits: 4,
        measuredUnits: 4,
        startedAt: "2026-09-02T09:04:00.000Z",
        finishedAt: "2026-09-02T09:04:40.000Z",
        outputs: ["renders/hairstyle-1.png"],
        error: null,
      },
    ],
  },
  "live-01.json": {
    id: "live-01",
    synthetic: false,
    summaries: {
      skin: SKIN_SUMMARY,
      fitzpatrick: null,
      attributes: ATTRIBUTES_SUMMARY,
      face_shape: { faceShape: "Oval" },
      hair_type: null,
    },
  },
  "raw/skin.json": { result: "recorded skin response, bytes stripped" },
  "raw/tone.json": { result: "recorded tone response" },
  "raw/attr.json": { result: "recorded attributes response" },
};

const GOLDEN_BYTES: Readonly<Record<string, string>> = {
  "capture.jpg": "not a real jpeg, and no test ever decodes it",
  "masks/pigmentation.png": "mask bytes",
  "renders/makeup-1.png": "makeup render bytes",
  "renders/hairstyle-1.png": "hairstyle render bytes",
};

function memorySource(extra: Readonly<Record<string, unknown>> = {}): FileSource {
  const json: Record<string, unknown> = { ...GOLDEN_JSON, ...extra };
  return {
    label: "in memory golden run",
    exists(path) {
      return path in json || path in GOLDEN_BYTES;
    },
    readJson(path) {
      if (!(path in json)) {
        throw new SeedError("read golden file", `${path} is missing.`);
      }
      return json[path];
    },
    readBytes(path) {
      const value = GOLDEN_BYTES[path];
      if (value === undefined) {
        throw new SeedError("read golden file", `${path} is missing.`);
      }
      return new TextEncoder().encode(value);
    },
  };
}

function goldenInput(extra: Readonly<Record<string, unknown>> = {}): GoldenInput {
  return loadGoldenRun({ source: memorySource(extra), imagePath: null });
}

/** The makeup request the golden run sent, recomputed the way the script does. */
function expectedMakeupHash(): string {
  const params = makeupParamsFrom({
    attributesSummary: ATTRIBUTES_SUMMARY,
    captureId: DEMO_CAPTURE_ID,
    categories: MAKEUP_CATEGORIES,
  });
  if (params === null) {
    throw new Error("The fixture attributes summary should produce shades.");
  }
  return paramsHash(
    "makeup",
    canonicalMakeupParams({
      captureId: DEMO_CAPTURE_ID,
      params: makeupRenderParamsSchema.parse({ categories: params.categories }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Column vocabularies, taken from src/lib/server/db/types.ts
// ---------------------------------------------------------------------------

const INSERTABLE_COLUMNS: Readonly<Record<SeedTableName, readonly string[]>> = {
  captures: [
    "id",
    "user_id",
    "sha256",
    "storage_path",
    "width",
    "height",
    "quality",
    "deleted_at",
  ],
  analyses: [
    "id",
    "capture_id",
    "user_id",
    "kind",
    "status",
    "provider_task_id",
    "raw",
    "summary",
    "mask_paths",
    "credits_used",
    "error",
  ],
  garments: [
    "id",
    "user_id",
    "storage_path",
    "type",
    "colors",
    "pattern",
    "formality",
    "classification",
    "user_edited",
  ],
  looks: [
    "id",
    "user_id",
    "occasion",
    "garments",
    "rationale",
    "render_path",
    "is_saved",
  ],
  renders: [
    "id",
    "user_id",
    "kind",
    "params",
    "params_hash",
    "storage_path",
    "provider_task_id",
    "credits_used",
    "status",
  ],
  aesthetic_profiles: [
    "user_id",
    "capture_id",
    "skin_type_zones",
    "concerns",
    "skin_age",
    "fitzpatrick",
    "skin_tone_hex",
    "undertone",
    "undertone_source",
    "eye_color_hex",
    "hair_color_hex",
    "face_shape",
    "hair_type",
    "saved_hair_style_id",
    "saved_hair_color_name",
    "season",
    "palette",
    "reading",
    "reading_model",
    "version",
  ],
};

function expectColumnsAreInsertable(
  table: SeedTableName,
  rows: readonly Record<string, unknown>[],
): void {
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      expect(
        INSERTABLE_COLUMNS[table],
        `public.${table} has no insertable column "${column}"`,
      ).toContain(column);
    }
  }
}

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("reads both modes, the image path, and the dry run flag", () => {
    expect(parseArgs(["--from-fixtures"])).toEqual({
      mode: "fixtures",
      goldenDir: null,
      imagePath: null,
      dryRun: false,
    });
    expect(
      parseArgs([
        "--from-golden",
        "evals/fixtures/golden",
        "--image",
        "selfie.jpg",
        "--dry-run",
      ]),
    ).toEqual({
      mode: "golden",
      goldenDir: "evals/fixtures/golden",
      imagePath: "selfie.jpg",
      dryRun: true,
    });
  });

  it("refuses no mode, an unknown flag, and a flag with no value", () => {
    expect(() => parseArgs([])).toThrow(/Pick a mode/u);
    expect(() => parseArgs(["--seed-everything"])).toThrow(/Unknown argument/u);
    expect(() => parseArgs(["--from-golden"])).toThrow(/needs a value/u);
    expect(() => parseArgs(["--from-golden", "--dry-run"])).toThrow(
      /needs a value/u,
    );
    expect(() => parseArgs(["--from-fixtures", "--image"])).toThrow(
      /needs a value/u,
    );
  });
});

describe("parseEnvFile", () => {
  /*
   * A literal, never the real .env.local. The values below are obvious
   * placeholders: this suite must not be able to read, print, or assert on key
   * material.
   */
  const sample = [
    "# A comment",
    "",
    "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co",
    'SUPABASE_SERVICE_ROLE_KEY="placeholder-not-a-key"',
    "export JUDGE_CREDITS_CAP=120",
    "SPACED = value with spaces ",
    "EMPTY=",
    "no equals sign here",
    "=novalue",
    "1BAD_NAME=x",
  ].join("\n");

  it("reads keys, strips quotes and export, and skips what is not a pair", () => {
    const values = parseEnvFile(sample);
    expect(values.get("NEXT_PUBLIC_SUPABASE_URL")).toBe(
      "https://example.supabase.co",
    );
    expect(values.get("SUPABASE_SERVICE_ROLE_KEY")).toBe("placeholder-not-a-key");
    expect(values.get("JUDGE_CREDITS_CAP")).toBe("120");
    expect(values.get("SPACED")).toBe("value with spaces");
    expect(values.get("EMPTY")).toBe("");
    expect(values.has("no equals sign here")).toBe(false);
    expect(values.has("1BAD_NAME")).toBe(false);
    expect(values.size).toBe(5);
  });

  it("keeps a hash inside a value rather than truncating it", () => {
    expect(parseEnvFile("HEX=#6b4a2f").get("HEX")).toBe("#6b4a2f");
  });
});

// ---------------------------------------------------------------------------
// Fixtures mode
// ---------------------------------------------------------------------------

describe("runSeed, --from-fixtures", () => {
  it("writes the wardrobe, the two looks, the profile, and the recorded listings", async () => {
    const writer = new RecordingWriter();
    const report = await seed({ writer });

    expect(report.ok).toBe(true);
    expect(exitCodeForReport(report)).toBe(0);

    expect(writer.rowsOf("garments")).toHaveLength(6);
    expect(writer.rowsOf("looks")).toHaveLength(2);
    expect(writer.rowsOf("aesthetic_profiles")).toHaveLength(1);
    expect(writer.rowsOf("captures")).toHaveLength(0);
    expect(writer.rowsOf("analyses")).toHaveLength(0);
    expect(writer.rowsOf("renders")).toHaveLength(0);

    // Six garment images, in the garments bucket, and no other object.
    expect(writer.objects.size).toBe(6);
    for (const object of writer.objects.values()) {
      expect(object.bucket).toBe("garments");
      expect(object.path.startsWith(`${DEMO_OWNER_ID}/`)).toBe(true);
      expect(object.contentType).toBe("image/svg+xml");
      expect(object.bytes.byteLength).toBeGreaterThan(0);
    }

    const steps = new Map(report.steps.map((step) => [step.id, step] as const));
    expect(steps.get("capture")?.status).toBe("skipped");
    expect(steps.get("analyses")?.status).toBe("skipped");
    expect(steps.get("renders")?.status).toBe("skipped");
    expect(steps.get("wardrobe")?.status).toBe("written");
    expect(steps.get("product-cache")?.status).toBe("written");
    expect(report.assumptions).toEqual([]);
  });

  it("seeds one product cache row per recorded response, keyed the way a live search keys it", async () => {
    const writer = new RecordingWriter();
    const report = await seed({ writer });

    expect(RECORDED_LISTING_RESPONSES.length).toBeGreaterThan(0);
    expect(writer.productCacheRows).toHaveLength(
      RECORDED_LISTING_RESPONSES.length,
    );

    const steps = new Map(report.steps.map((step) => [step.id, step] as const));
    expect(steps.get("product-cache")?.rows).toBe(
      RECORDED_LISTING_RESPONSES.length,
    );

    for (const response of RECORDED_LISTING_RESPONSES) {
      const query = sanitizeProductQuery(response.query);
      expect(query).not.toBeNull();
      if (query === null) {
        continue;
      }
      const expectedKey = productCacheKey({
        engine: SHOPPING_ENGINE,
        query,
        location: null,
        gl: RECORDED_LISTINGS_GL ?? "",
        hl: RECORDED_LISTINGS_HL ?? "",
      });
      const row = writer.productCacheRows.find(
        (candidate) => candidate.query_hash === expectedKey,
      );
      expect(row).toBeDefined();
      expect(row?.engine).toBe(SHOPPING_ENGINE);
      // fetched_at is when the provider was actually called, never now.
      expect(row?.fetched_at).toBe(RECORDED_LISTINGS_RECORDED_ON);

      // The results column holds the normalized listing shape the grounding
      // layer reads back, not a raw provider body.
      const results = cachedListingsSchema.safeParse(row?.results);
      expect(results.success).toBe(true);
    }
  });

  it("upserts the product cache rather than clearing a cache nobody owns", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });

    expect(
      writer.calls.filter((call) => call.startsWith("upsert product_cache")),
    ).toHaveLength(1);
    expect(
      writer.calls.filter((call) => call.includes("product_cache")),
    ).toHaveLength(1);
  });

  it("deletes children before parents, and only for the demo owner", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });

    const deletes = writer.calls
      .filter((call) => call.startsWith("delete "))
      .map((call) => call.split(" ")[1]);

    expect(deletes).toEqual([
      "analyses",
      "renders",
      "looks",
      "garments",
      "aesthetic_profiles",
      "captures",
    ]);
    for (const call of writer.calls.filter((entry) => entry.startsWith("delete "))) {
      expect(call.endsWith(DEMO_OWNER_ID)).toBe(true);
    }

    // Every delete happens before the first insert.
    const lastDelete = writer.calls.findLastIndex((call) =>
      call.startsWith("delete "),
    );
    const firstInsert = writer.calls.findIndex((call) => call.startsWith("insert "));
    expect(lastDelete).toBeLessThan(firstInsert);
  });

  it("writes garment rows the garments table can take", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });

    const rows = writer.rowsOf("garments");
    expectColumnsAreInsertable("garments", rows);

    const idByFixtureId = demoGarmentIdByFixtureId();
    for (const [index, fixture] of DEMO_FIXTURE_WARDROBE.garments.entries()) {
      const row = rows[index];
      expect(row?.id).toBe(idByFixtureId.get(fixture.id));
      expect(row?.id).toBe(demoUuid(0x1, index + 1));
      expect(row?.user_id).toBe(DEMO_OWNER_ID);
      expect(row?.storage_path).toBe(`${DEMO_OWNER_ID}/${String(row?.id)}.svg`);
      expect(row?.type).toBe(fixture.type);
      expect(row?.formality).toBe(fixture.formality);
      expect(row?.pattern).toBe(fixture.pattern);
      expect(row?.colors).toEqual(fixture.colors);
      expect(row?.classification).toBeNull();
      expect(row?.user_edited).toBe(false);
    }
  });

  it("writes two saved looks whose members point at the seeded garment ids", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });

    const rows = writer.rowsOf("looks");
    expectColumnsAreInsertable("looks", rows);

    const garmentIds = new Set(demoGarmentIdByFixtureId().values());
    expect(rows.map((row) => row.occasion)).toEqual(["wedding_guest", "interview"]);

    for (const row of rows) {
      expect(row.user_id).toBe(DEMO_OWNER_ID);
      expect(row.is_saved).toBe(true);
      expect(row.render_path).toBeNull();
      expect(typeof row.rationale).toBe("string");
      expect(String(row.rationale).length).toBeGreaterThan(0);

      const members = row.garments as { garment_id?: string }[];
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) {
        expect(member.garment_id).toBeDefined();
        expect(garmentIds.has(String(member.garment_id))).toBe(true);
      }
    }
  });

  it("writes a profile row with no capture and a fallback reading", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });

    const row = writer.rowsOf("aesthetic_profiles")[0];
    expect(row).toBeDefined();
    expectColumnsAreInsertable("aesthetic_profiles", [
      row as Record<string, unknown>,
    ]);

    expect(row?.user_id).toBe(DEMO_OWNER_ID);
    expect(row?.capture_id).toBeNull();
    expect(row?.hair_type).toBeNull();
    expect(row?.undertone).toBe("warm");
    expect(row?.undertone_source).toBe("detected");
    expect(row?.season).toBe("deep_autumn");
    expect(String(row?.skin_tone_hex)).toMatch(/^#[0-9a-f]{6}$/u);
    expect(String(row?.reading).length).toBeGreaterThan(0);
    // Must start with "fallback/", or report-view.ts would report a model wrote it.
    expect(String(row?.reading_model).startsWith("fallback/")).toBe(true);
    expect(row?.skin_type_zones).toEqual({ t_zone: "oily", cheeks: "dry" });
    expect(Array.isArray(row?.concerns)).toBe(true);
  });

  it("is idempotent: a second run leaves exactly the same rows and objects", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });

    const firstRows = JSON.stringify([...writer.rows.entries()]);
    const firstObjects = [...writer.objects.keys()].sort();

    const report = await seed({ writer });
    expect(report.ok).toBe(true);

    expect(JSON.stringify([...writer.rows.entries()])).toBe(firstRows);
    expect([...writer.objects.keys()].sort()).toEqual(firstObjects);
    expect(writer.rowsOf("garments")).toHaveLength(6);
    expect(writer.rowsOf("looks")).toHaveLength(2);
    expect(writer.rowsOf("aesthetic_profiles")).toHaveLength(1);
  });

  it("removes the objects it finds under the demo owner before writing again", async () => {
    const writer = new RecordingWriter();
    await seed({ writer });
    writer.calls.length = 0;

    await seed({ writer });
    const removals = writer.calls.filter((call) => call.startsWith("remove "));
    expect(removals).toHaveLength(6);
    for (const call of removals) {
      expect(call).toContain(DEMO_OWNER_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the golden run
// ---------------------------------------------------------------------------

describe("loadGoldenRun", () => {
  it("accepts the manifest scripts/golden-run.ts writes", () => {
    const parsed = goldenManifestSchema.safeParse(GOLDEN_JSON["manifest.json"]);
    expect(parsed.success).toBe(true);
  });

  it("rejects a manifest with no image hash", () => {
    expect(
      goldenManifestSchema.safeParse({
        recordedOn: "2026-09-02T09:00:00.000Z",
        captureId: "golden-01",
        fixtureFile: null,
        image: { contentType: "image/jpeg" },
        calls: [],
      }).success,
    ).toBe(false);
  });

  it("refuses a run whose skin analysis never landed", () => {
    const source = memorySource({
      "manifest.json": {
        ...(GOLDEN_JSON["manifest.json"] as Record<string, unknown>),
        fixtureFile: null,
      },
    });
    expect(() => loadGoldenRun({ source, imagePath: null })).toThrow(
      /produced no skin analysis/u,
    );
  });

  it("finds the selfie in the run folder, and says so when it cannot", () => {
    expect(findCaptureImage(memorySource(), "C:/elsewhere/selfie.jpg")).toBe(
      "C:/elsewhere/selfie.jpg",
    );
    expect(findCaptureImage(memorySource(), null)).toBe(
      CAPTURE_IMAGE_CANDIDATES[0],
    );

    const empty: FileSource = {
      label: "a run with no copy of the selfie",
      exists: () => false,
      readJson: () => ({}),
      readBytes: () => new Uint8Array(),
    };
    expect(() => findCaptureImage(empty, null)).toThrow(/--image <path>/u);
  });
});

// ---------------------------------------------------------------------------
// Golden mode
// ---------------------------------------------------------------------------

describe("runSeed, --from-golden", () => {
  it("writes the capture, its analyses and masks, and the two renders", async () => {
    const writer = new RecordingWriter();
    const report = await seed({ writer, golden: goldenInput() });

    expect(report.ok).toBe(true);

    const captures = writer.rowsOf("captures");
    expect(captures).toHaveLength(1);
    expectColumnsAreInsertable("captures", captures);
    expect(captures[0]?.id).toBe(DEMO_CAPTURE_ID);
    expect(captures[0]?.user_id).toBe(DEMO_OWNER_ID);
    expect(captures[0]?.sha256).toBe("a".repeat(64));
    expect(captures[0]?.storage_path).toBe(
      `${DEMO_OWNER_ID}/${DEMO_CAPTURE_ID}.jpg`,
    );
    expect(captures[0]?.width).toBe(1024);
    expect(captures[0]?.deleted_at).toBeNull();

    const analyses = writer.rowsOf("analyses");
    expect(analyses).toHaveLength(3);
    expectColumnsAreInsertable("analyses", analyses);
    expect(analyses.map((row) => row.kind)).toEqual([
      "skin",
      "attributes",
      "face_shape",
    ]);
    for (const row of analyses) {
      expect(row.status).toBe("succeeded");
      expect(row.capture_id).toBe(DEMO_CAPTURE_ID);
      expect(row.user_id).toBe(DEMO_OWNER_ID);
      expect(row.error).toBeNull();
    }
    // No fitzpatrick and no hair type: the frugal golden run does not buy them.
    expect(analyses.map((row) => row.kind)).not.toContain("fitzpatrick");
    expect(analyses.map((row) => row.kind)).not.toContain("hair_type");

    // The skin call measured 9 units; the tone call only had a table figure.
    expect(analyses[0]?.credits_used).toBe(9);
    expect(analyses[1]?.credits_used).toBe(3);
    expect(analyses[0]?.provider_task_id).toBe("task-skin");
    expect(analyses[0]?.mask_paths).toEqual([
      `${DEMO_OWNER_ID}/${DEMO_CAPTURE_ID}/pigmentation.png`,
    ]);
    expect(analyses[0]?.summary).toEqual(SKIN_SUMMARY);
    expect(analyses[0]?.raw).toEqual(GOLDEN_JSON["raw/skin.json"]);

    const renders = writer.rowsOf("renders");
    expect(renders).toHaveLength(2);
    expectColumnsAreInsertable("renders", renders);
    expect(renders.map((row) => row.kind)).toEqual(["makeup", "hairstyle"]);
    for (const row of renders) {
      expect(row.status).toBe("succeeded");
      expect(row.user_id).toBe(DEMO_OWNER_ID);
      expect(String(row.params_hash)).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.credits_used).toBe(4);
    }
  });

  it("hashes the render params the way the live render layer does", async () => {
    const writer = new RecordingWriter();
    const report = await seed({ writer, golden: goldenInput() });

    const renders = writer.rowsOf("renders");
    expect(renders[0]?.params_hash).toBe(expectedMakeupHash());
    expect(renders[1]?.params_hash).toBe(
      paramsHash(
        "hairstyle",
        canonicalHairstyleParams({
          captureId: DEMO_CAPTURE_ID,
          params: { styleId: ASSUMED_HAIRSTYLE_STYLE_ID },
        }),
      ),
    );

    // Both were resolved rather than recorded, so both are reported.
    expect(report.assumptions.join(" ")).toContain("recomputed with makeupParamsFrom");
    expect(report.assumptions.join(" ")).toContain(ASSUMED_HAIRSTYLE_STYLE_ID);
  });

  it("prefers a recorded params file over its own assumption", async () => {
    const writer = new RecordingWriter();
    const report = await seed({
      writer,
      golden: goldenInput({
        "renders/hairstyle-params.json": { styleId: "long-layers" },
      }),
    });

    expect(writer.rowsOf("renders")[1]?.params_hash).toBe(
      paramsHash(
        "hairstyle",
        canonicalHairstyleParams({
          captureId: DEMO_CAPTURE_ID,
          params: { styleId: "long-layers" },
        }),
      ),
    );
    expect(report.assumptions.join(" ")).toContain(
      "read from renders/hairstyle-params.json",
    );
  });

  it("uploads every object into the bucket its row points at", async () => {
    const writer = new RecordingWriter();
    await seed({ writer, golden: goldenInput() });

    const byBucket = new Map<string, string[]>();
    for (const object of writer.objects.values()) {
      byBucket.set(object.bucket, [
        ...(byBucket.get(object.bucket) ?? []),
        object.path,
      ]);
    }
    expect(byBucket.get("captures")).toEqual([
      `${DEMO_OWNER_ID}/${DEMO_CAPTURE_ID}.jpg`,
    ]);
    expect(byBucket.get("masks")).toEqual([
      `${DEMO_OWNER_ID}/${DEMO_CAPTURE_ID}/pigmentation.png`,
    ]);
    expect(byBucket.get("renders")).toHaveLength(2);
    expect(byBucket.get("garments")).toHaveLength(6);
  });

  it("rebuilds the profile from the analyses rather than from the fixture", async () => {
    const writer = new RecordingWriter();
    await seed({ writer, golden: goldenInput() });

    const row = writer.rowsOf("aesthetic_profiles")[0];
    expect(row).toBeDefined();
    expectColumnsAreInsertable("aesthetic_profiles", [
      row as Record<string, unknown>,
    ]);

    expect(row?.capture_id).toBe(DEMO_CAPTURE_ID);
    expect(row?.skin_age).toBe(31);
    expect(row?.skin_tone_hex).toBe("#6b4a2f");
    expect(row?.eye_color_hex).toBe("#3b2b22");
    expect(row?.hair_color_hex).toBe("#1e1613");
    expect(row?.face_shape).toBe("Oval");
    // No fitzpatrick analysis was bought, so the column is null and not guessed.
    expect(row?.fitzpatrick).toBeNull();
    expect(row?.undertone).toBe("warm");
    expect(row?.undertone_source).toBe("detected");
    expect(row?.hair_type).toBeNull();

    const concerns = row?.concerns as { key: string; mask_path: string | null }[];
    expect(concerns.map((concern) => concern.key)).toContain("pigmentation");
    expect(
      concerns.find((concern) => concern.key === "pigmentation")?.mask_path,
    ).toBe(`${DEMO_OWNER_ID}/${DEMO_CAPTURE_ID}/pigmentation.png`);

    // The reading came from the deterministic fallback, and says so.
    expect(String(row?.reading).length).toBeGreaterThan(0);
    expect(String(row?.reading_model).startsWith("fallback/")).toBe(true);
  });

  it("uses a recorded reading when one sits beside the run", async () => {
    const writer = new RecordingWriter();
    const report = await seed({
      writer,
      golden: goldenInput({
        [RECORDED_READING_FILE]: {
          reading: "A recorded reading.",
          readingModel: "test-model/v1",
        },
      }),
    });

    const row = writer.rowsOf("aesthetic_profiles")[0];
    expect(row?.reading).toBe("A recorded reading.");
    expect(row?.reading_model).toBe("test-model/v1");
    expect(report.assumptions.join(" ")).toContain(RECORDED_READING_FILE);
  });

  it("keeps the wardrobe and the looks from the fixture in golden mode too", async () => {
    const writer = new RecordingWriter();
    await seed({ writer, golden: goldenInput() });

    expect(writer.rowsOf("garments")).toHaveLength(6);
    expect(writer.rowsOf("looks")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe("runSeed, failure", () => {
  it("stops at the failing step, exits 1, and reports what did and did not land", async () => {
    const writer = new RecordingWriter();
    writer.failInsertInto = "looks";

    const report = await seed({ writer });

    expect(report.ok).toBe(false);
    expect(exitCodeForReport(report)).toBe(1);
    expect(report.failure).toMatch(/insert into looks/u);

    const steps = new Map(report.steps.map((step) => [step.id, step] as const));
    expect(steps.get("wardrobe")?.status).toBe("written");
    expect(steps.get("looks")?.status).toBe("failed");
    expect(steps.get("aesthetic-profile")?.status).toBe("not run");
    expect(steps.get("product-cache")?.status).toBe("not run");

    // The garments that did land are still there, and nothing later was written.
    expect(writer.rowsOf("garments")).toHaveLength(6);
    expect(writer.rowsOf("looks")).toHaveLength(0);
    expect(writer.rowsOf("aesthetic_profiles")).toHaveLength(0);

    const summary = summaryLines(report).join("\n");
    expect(summary).toContain("Written: clear, wardrobe");
    expect(summary).toContain("looks (failed)");
    expect(summary).toContain("aesthetic-profile (not run)");
    expect(summary).toContain("Failed: insert into looks failed");
  });

  it("reports a missing golden file rather than writing half a profile", async () => {
    const writer = new RecordingWriter();
    const base = goldenInput();
    const report = await seed({
      writer,
      golden: { ...base, captureImagePath: "not-there.jpg" },
    });

    expect(report.ok).toBe(false);
    expect(report.failure).toMatch(/not-there\.jpg is missing/u);
    expect(writer.rowsOf("captures")).toHaveLength(0);
    expect(writer.rowsOf("aesthetic_profiles")).toHaveLength(0);
  });

  it("refuses a render call that wrote no image", async () => {
    const writer = new RecordingWriter();
    const manifest = GOLDEN_JSON["manifest.json"] as GoldenManifest;
    const report = await seed({
      writer,
      golden: goldenInput({
        "manifest.json": {
          ...manifest,
          calls: manifest.calls.map((call) =>
            call.step === "makeup" ? { ...call, outputs: [] } : call,
          ),
        },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.failure).toMatch(/wrote no file under renders\//u);
    expect(writer.rowsOf("renders")).toHaveLength(0);
  });
});
