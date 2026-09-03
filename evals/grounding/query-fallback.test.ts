import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:grounding, the broader retry.
 *
 * The problem it answers, seen in production: every routine step on the report
 * read "No listing found near you yet" while the same products were on sale on
 * Amazon.in, Nykaa, and Myntra. Two things caused it. The cap is covered by
 * evals/budget/search-cap.test.ts. This file covers the second: a query written
 * for a person ("niacinamide serum for pigmentation combination") is not the
 * query a shop's catalogue answers ("niacinamide serum").
 *
 * The rule under test, from src/lib/server/products/ranking.ts and the pipeline
 * in src/lib/server/products/index.ts: ask the strict query first, always; only
 * when it ends with no listing at all, ask once more with the broader one, and
 * record that the broader one is what answered.
 */

vi.mock("server-only", () => ({}));

/** Bodies keyed by the query they answer. Anything else answers empty. */
const BODIES: Record<string, unknown> = {
  "niacinamide serum": {
    shopping_results: [
      {
        title: "Minimalist 10% Niacinamide Face Serum 30 ml",
        product_link: "https://www.nykaa.com/p/minimalist-niacinamide",
        source: "Nykaa",
        price: "₹549.00",
        extracted_price: 549,
      },
    ],
  },
  "gentle cream cleanser": {
    shopping_results: [
      {
        title: "Cetaphil Gentle Skin Cleanser 250 ml",
        product_link: "https://www.amazon.in/dp/B00A0AZ0PC",
        source: "Amazon.in",
        price: "₹399.00",
        extracted_price: 399,
      },
    ],
  },
};

const searched: string[] = [];

const readProductCache = vi.fn(async () => null);
const writeProductCache = vi.fn(async () => undefined);
const fetchShoppingBody = vi.fn(async (args: { readonly query: string }) => {
  searched.push(args.query);
  return BODIES[args.query] ?? { shopping_results: [] };
});
const reserve = vi.fn(async () => ({
  ok: true as const,
  reservation: {
    id: "reservation",
    owner: { ownerType: "judge_session" as const, ownerId: "judge" },
    provider: "serpapi" as const,
    units: 1,
    subjectId: null,
  },
}));

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
  fetchShoppingBody: (args: { readonly query: string }) =>
    fetchShoppingBody(args),
}));

vi.mock("@/lib/server/products/ledger", () => ({
  openSearchBudget: async () => ({
    ok: true as const,
    reserve,
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

const { broadenProductQuery } = await import(
  "@/lib/server/products/ranking"
);
const { groundRoutineSteps } = await import("@/lib/server/products");

const OWNER = {
  location: null,
  gl: "in",
  hl: "en",
  ownerType: "judge_session" as const,
  ownerId: "00000000-0000-4000-8000-000000000002",
};

let runLines: string[] = [];

beforeEach(() => {
  searched.length = 0;
  readProductCache.mockClear();
  writeProductCache.mockClear();
  fetchShoppingBody.mockClear();
  reserve.mockClear();
  runLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    runLines.push(args.map((part) => String(part)).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("eval:grounding, broadening a query", () => {
  it("drops the tail that describes the person, not the product", () => {
    expect(
      broadenProductQuery("niacinamide serum for pigmentation combination"),
    ).toBe("niacinamide serum");
    expect(
      broadenProductQuery("gentle cream cleanser for combination skin"),
    ).toBe("gentle cream cleanser");
    expect(broadenProductQuery("serum to fade dark spots")).toBe("serum");
    expect(
      broadenProductQuery("moisturiser with ceramides for dry skin"),
    ).toBe("moisturiser");
  });

  it("keeps a long query with no marker down to the words a title carries", () => {
    expect(broadenProductQuery("broad spectrum sunscreen spf 50 gel")).toBe(
      "broad spectrum sunscreen",
    );
    expect(broadenProductQuery("navy cotton chinos slim fit men")).toBe(
      "navy cotton chinos",
    );
  });

  it("says a query is already as broad as it goes rather than shortening it twice", () => {
    expect(broadenProductQuery("niacinamide serum")).toBeNull();
    expect(broadenProductQuery("sunscreen")).toBeNull();
    expect(broadenProductQuery("")).toBeNull();
  });

  it("never invents a word, a store, or a market", () => {
    const broad = broadenProductQuery(
      "fragrance free ceramide moisturiser for dehydrated combination skin",
    );
    expect(broad).not.toBeNull();
    for (const word of (broad ?? "").split(" ")) {
      expect(
        "fragrance free ceramide moisturiser for dehydrated combination skin",
      ).toContain(word);
    }
  });
});

describe("eval:grounding, the pipeline's one retry", () => {
  it("answers a step with a real listing when only the broader query finds one", async () => {
    const results = await groundRoutineSteps(
      [{ productQuery: "niacinamide serum for pigmentation combination" }],
      OWNER,
    );

    expect(searched).toEqual([
      "niacinamide serum for pigmentation combination",
      "niacinamide serum",
    ]);
    const listing = results[0];
    expect(listing).not.toBeNull();
    expect(listing?.url).toBe("https://www.nykaa.com/p/minimalist-niacinamide");
    expect(listing?.priceText).toBe("₹549.00");
    expect(listing?.store).toBe("Nykaa");
  });

  it("records that the broader query is what answered, without logging either query", async () => {
    await groundRoutineSteps(
      [{ productQuery: "gentle cream cleanser for combination skin" }],
      OWNER,
    );

    const run = runLines.find((line) => line.includes("aurum.grounding_run"));
    expect(run).toBeDefined();
    expect(run).toContain('"broadened":1');
    expect(run).toContain('"broadenedSearches":1');
    expect(run).toContain('"withoutListing":0');
    expect(run).not.toContain("cleanser");
  });

  it("spends nothing extra when the strict query already found a product", async () => {
    const results = await groundRoutineSteps(
      [{ productQuery: "niacinamide serum" }],
      OWNER,
    );

    expect(searched).toEqual(["niacinamide serum"]);
    expect(results[0]?.store).toBe("Nykaa");
  });

  it("spends nothing extra on a query that cannot be broadened", async () => {
    const results = await groundRoutineSteps(
      [{ productQuery: "unobtainium" }],
      OWNER,
    );

    expect(searched).toEqual(["unobtainium"]);
    expect(results[0]).toBeNull();
  });

  it("asks the broader query at most once, however many steps share it", async () => {
    const results = await groundRoutineSteps(
      [
        { productQuery: "niacinamide serum for pigmentation combination" },
        { productQuery: "niacinamide serum for pigmentation combination" },
      ],
      OWNER,
    );

    expect(searched).toEqual([
      "niacinamide serum for pigmentation combination",
      "niacinamide serum",
    ]);
    expect(results[0]?.store).toBe("Nykaa");
    expect(results[1]?.store).toBe("Nykaa");
  });
});
