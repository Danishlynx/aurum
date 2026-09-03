import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:grounding, the market a search is run in.
 *
 * The problem it answers: gl and hl came only from SERPAPI_DEFAULT_GL and
 * SERPAPI_DEFAULT_HL, which are the founder's country. A judge opening the
 * report in the United States was shown Nykaa and Amazon.in, which is a real
 * listing at a real price in a shop they cannot buy from. docs/04-integrations.md
 * already said what should happen: "Location comes from the profile's
 * approximate location (city level) with gl and hl set from the person's
 * locale."
 *
 * Two things are under test.
 *
 * 1. src/lib/server/locale.ts, which turns a request's headers into a market.
 *    Every branch: the header present, absent, malformed, in the wrong case, and
 *    each shape of Accept-Language a browser actually sends.
 * 2. That the resolved gl reaches both places it has to reach: the search sent
 *    to SerpApi, and the product cache key, so two countries never read each
 *    other's listings out of one shared table.
 */

vi.mock("server-only", () => ({}));

const {
  COUNTRY_HEADER,
  LANGUAGE_HEADER,
  envGroundingLocale,
  primaryLanguageOf,
  resolveGroundingLocale,
} = await import("@/lib/server/locale");
const { productCacheKey } = await import(
  "@/lib/server/products/cache-policy"
);

/** A Headers stand in. The real one lowercases names, so this does too. */
function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

const ORIGINAL_GL = process.env.SERPAPI_DEFAULT_GL;
const ORIGINAL_HL = process.env.SERPAPI_DEFAULT_HL;

beforeEach(() => {
  process.env.SERPAPI_DEFAULT_GL = "in";
  process.env.SERPAPI_DEFAULT_HL = "en";
});

afterEach(() => {
  if (ORIGINAL_GL === undefined) {
    delete process.env.SERPAPI_DEFAULT_GL;
  } else {
    process.env.SERPAPI_DEFAULT_GL = ORIGINAL_GL;
  }
  if (ORIGINAL_HL === undefined) {
    delete process.env.SERPAPI_DEFAULT_HL;
  } else {
    process.env.SERPAPI_DEFAULT_HL = ORIGINAL_HL;
  }
});

describe("eval:grounding, resolving the market from a request", () => {
  it("takes the country from the header Vercel sets", () => {
    const locale = resolveGroundingLocale(
      headersOf({ [COUNTRY_HEADER]: "US", [LANGUAGE_HEADER]: "en-US,en;q=0.9" }),
    );
    expect(locale).toEqual({ gl: "us", hl: "en", source: "header" });
  });

  it("lowercases a country the edge sent in capitals", () => {
    // Vercel sends "GB". SerpApi wants "gb". Nothing else in the pipeline
    // lowercases it before the search, so this is the place that must.
    const locale = resolveGroundingLocale(
      headersOf({ [COUNTRY_HEADER]: "GB" }),
    );
    expect(locale.gl).toBe("gb");
    expect(locale.source).toBe("header");
  });

  it("falls back to the configured default with no header at all", () => {
    // Local dev, a script, a test: there is no request, so the config answers.
    // This is the behaviour that shipped before the locale existed.
    expect(resolveGroundingLocale(null)).toEqual({
      gl: "in",
      hl: "en",
      source: "env",
    });
    expect(resolveGroundingLocale(undefined)).toEqual({
      gl: "in",
      hl: "en",
      source: "env",
    });
    expect(resolveGroundingLocale(headersOf({}))).toEqual({
      gl: "in",
      hl: "en",
      source: "env",
    });
  });

  it("reads the configured default, whatever it is set to", () => {
    process.env.SERPAPI_DEFAULT_GL = "US";
    process.env.SERPAPI_DEFAULT_HL = "EN";
    expect(envGroundingLocale()).toEqual({ gl: "us", hl: "en" });
    expect(resolveGroundingLocale(null)).toEqual({
      gl: "us",
      hl: "en",
      source: "env",
    });
  });

  it("falls back when the configured default is missing", () => {
    delete process.env.SERPAPI_DEFAULT_GL;
    delete process.env.SERPAPI_DEFAULT_HL;
    expect(resolveGroundingLocale(null)).toEqual({
      gl: "in",
      hl: "en",
      source: "env",
    });
  });

  it("refuses a malformed country and uses the default instead", () => {
    // A country that is not two letters is not a market. Sending it on would
    // buy a rejected search, which reads on screen as a report with no products
    // at all, so the default answers instead.
    for (const value of ["", " ", "USA", "U", "1S", "us-west", "*", "XX7"]) {
      const locale = resolveGroundingLocale(
        headersOf({ [COUNTRY_HEADER]: value }),
      );
      expect(locale.gl, `country header ${JSON.stringify(value)}`).toBe("in");
      expect(locale.source).toBe("env");
    }
  });

  it("reads the primary subtag of every Accept-Language shape", () => {
    expect(primaryLanguageOf("en-US,en;q=0.9,fr;q=0.8")).toBe("en");
    expect(primaryLanguageOf("fr-CA")).toBe("fr");
    expect(primaryLanguageOf("de")).toBe("de");
    expect(primaryLanguageOf("  pt-BR ,en;q=0.5")).toBe("pt");
    expect(primaryLanguageOf("JA-JP")).toBe("ja");
    expect(primaryLanguageOf("zh-Hans-CN,zh;q=0.9")).toBe("zh");
    expect(primaryLanguageOf("en;q=0.9")).toBe("en");
    // Nothing usable: a wildcard, an empty header, a missing one.
    expect(primaryLanguageOf("*")).toBeNull();
    expect(primaryLanguageOf("")).toBeNull();
    expect(primaryLanguageOf(null)).toBeNull();
    expect(primaryLanguageOf(undefined)).toBeNull();
    expect(primaryLanguageOf("q=0.9")).toBeNull();
  });

  it("keeps the country and defaults the language when Accept-Language says nothing", () => {
    const locale = resolveGroundingLocale(
      headersOf({ [COUNTRY_HEADER]: "de", [LANGUAGE_HEADER]: "*" }),
    );
    expect(locale).toEqual({ gl: "de", hl: "en", source: "header" });
  });

  it("carries the browser's language with the country", () => {
    const locale = resolveGroundingLocale(
      headersOf({ [COUNTRY_HEADER]: "FR", [LANGUAGE_HEADER]: "fr-FR,fr;q=0.9" }),
    );
    expect(locale).toEqual({ gl: "fr", hl: "fr", source: "header" });
  });

  it("ignores a language header when there is no country to pair it with", () => {
    // The pair is one market. A British browser reaching a machine with no
    // country header must not turn the Indian default into an English language
    // search of somewhere unspecified.
    const locale = resolveGroundingLocale(
      headersOf({ [LANGUAGE_HEADER]: "fr-FR,fr;q=0.9" }),
    );
    expect(locale).toEqual({ gl: "in", hl: "en", source: "env" });
  });

  it("survives a header bag that throws", () => {
    const hostile = {
      get(): string {
        throw new Error("no headers here");
      },
    };
    expect(resolveGroundingLocale(hostile)).toEqual({
      gl: "in",
      hl: "en",
      source: "env",
    });
  });

  it("keys the product cache separately per country", () => {
    // The seeded demo cache was recorded at gl=in. A judge in the United States
    // must not be served it, and this is what stops it: same engine, same query,
    // same location, different country, different row.
    const parts = {
      engine: "google_shopping",
      query: "niacinamide serum",
      location: null,
      hl: "en",
    };
    expect(productCacheKey({ ...parts, gl: "in" })).not.toBe(
      productCacheKey({ ...parts, gl: "us" }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* The resolved market, all the way to the search and the cache key    */
/* ------------------------------------------------------------------ */

/**
 * The rest of this file runs the real grounding pipeline with the provider, the
 * cache, and the ledger mocked, and watches what a gl of "us" does to both.
 * Same mocking shape as query-fallback.test.ts in this folder.
 */

const searches: { query: string; gl: string; hl: string }[] = [];
const cacheReads: { gl: string; hl: string; query: string }[] = [];
const cacheWrites: { gl: string; hl: string; query: string }[] = [];

const readProductCache = vi.fn(
  async (args: { readonly parts: { gl: string; hl: string; query: string } }) => {
    cacheReads.push({ ...args.parts });
    return null;
  },
);
const writeProductCache = vi.fn(
  async (args: { readonly parts: { gl: string; hl: string; query: string } }) => {
    cacheWrites.push({ ...args.parts });
    return undefined;
  },
);
const fetchShoppingBody = vi.fn(
  async (args: { readonly query: string; readonly gl: string; readonly hl: string }) => {
    searches.push({ ...args });
    return {
      shopping_results: [
        {
          title: "CeraVe Foaming Facial Cleanser 355 ml",
          product_link: "https://www.amazon.com/dp/B01N1LL62W",
          source: "Amazon.com",
          price: "$16.99",
          extracted_price: 16.99,
        },
      ],
    };
  },
);

vi.mock("@/lib/server/products/cache", () => ({
  readProductCache: (...args: unknown[]) =>
    (readProductCache as unknown as (...a: unknown[]) => unknown)(...args),
  writeProductCache: (...args: unknown[]) =>
    (writeProductCache as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@/lib/server/products/search", () => ({
  SHOPPING_ENGINE: "google_shopping",
  MAPS_ENGINE: "google_maps",
  SHOPPING_RESULT_POOL: 20,
  fetchShoppingBody: (args: {
    readonly query: string;
    readonly gl: string;
    readonly hl: string;
  }) => fetchShoppingBody(args),
}));

vi.mock("@/lib/server/products/ledger", () => ({
  openSearchBudget: async () => ({
    ok: true as const,
    reserve: async () => ({
      ok: true as const,
      reservation: {
        id: "reservation",
        owner: { ownerType: "judge_session" as const, ownerId: "judge" },
        provider: "serpapi" as const,
        units: 1,
        subjectId: null,
      },
    }),
    refund: async () => undefined,
  }),
}));

vi.mock("@/lib/server/providers/serpapi", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isSerpApiConfigured: () => true,
    searchMaps: async () => ({ places: [] }),
  };
});

const { groundRoutineSteps } = await import("@/lib/server/products");

const US_OPTIONS = {
  location: null,
  gl: "us",
  hl: "en",
  ownerType: "judge_session" as const,
  ownerId: "00000000-0000-4000-8000-000000000002",
};

describe("eval:grounding, the market reaches the search and the cache", () => {
  let runLines: string[] = [];

  beforeEach(() => {
    searches.length = 0;
    cacheReads.length = 0;
    cacheWrites.length = 0;
    readProductCache.mockClear();
    writeProductCache.mockClear();
    fetchShoppingBody.mockClear();
    runLines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      runLines.push(args.map((part) => String(part)).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the caller's country to SerpApi", async () => {
    const results = await groundRoutineSteps(
      [{ productQuery: "gentle foaming cleanser" }],
      US_OPTIONS,
    );

    expect(searches).toHaveLength(1);
    expect(searches[0]?.gl).toBe("us");
    expect(searches[0]?.hl).toBe("en");
    // And the listing that comes back is the one the shop returned, unchanged.
    expect(results[0]?.store).toBe("Amazon.com");
    expect(results[0]?.url).toContain("amazon.com");
  });

  it("reads and writes the cache under that country", async () => {
    await groundRoutineSteps(
      [{ productQuery: "gentle foaming cleanser" }],
      US_OPTIONS,
    );

    expect(cacheReads.length).toBeGreaterThan(0);
    for (const read of cacheReads) {
      expect(read.gl).toBe("us");
    }
    expect(cacheWrites.length).toBeGreaterThan(0);
    for (const write of cacheWrites) {
      expect(write.gl).toBe("us");
    }
  });

  it("logs the country once per run, and nothing more locating than that", async () => {
    await groundRoutineSteps(
      [{ productQuery: "gentle foaming cleanser" }],
      US_OPTIONS,
    );

    const runLine = runLines.find((line) => line.includes("aurum.grounding_run"));
    expect(runLine).toBeDefined();
    const parsed = JSON.parse(runLine ?? "{}") as Record<string, unknown>;
    expect(parsed.gl).toBe("us");
    // A country is not a location. No IP, no coordinates, no city, and never
    // the query text, which describes a person's skin
    // (docs/06-safety-privacy.md, "Observability").
    expect(runLine).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
    expect(runLine).not.toContain("gentle foaming cleanser");
    expect(parsed).not.toHaveProperty("ip");
    expect(parsed).not.toHaveProperty("location");
  });
});
