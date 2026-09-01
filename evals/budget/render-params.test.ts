import { describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts. */
vi.mock("server-only", () => ({}));

import {
  canonicalJson,
  canonicalMakeupParams,
  paramsHash,
} from "@/lib/server/renders/params";

/**
 * eval:budget, the render cache key.
 *
 * docs/03-architecture.md, "Caching": "Render params: (user_id, kind,
 * params_hash) is unique. Re selecting a shade or style returns the stored
 * render." docs/05-evals.md has this suite simulate a session of one capture set
 * plus six renders against the credit table, and this key is what keeps a shade
 * the person has already seen out of that total.
 *
 * Every assertion here is about not spending a credit twice for the same
 * picture, and about never serving one person's face for another request.
 */

const CAPTURE = "b3f1e0c2-1111-4a2b-8c3d-000000000001";

function makeup(
  categories: ReadonlyArray<{
    category: "lip" | "blush" | "foundation" | "eye";
    shadeHex: string;
    shadeName: string;
  }>,
) {
  return canonicalMakeupParams({
    captureId: CAPTURE,
    params: { categories: [...categories] },
  });
}

const LIP = {
  category: "lip",
  shadeHex: "#9c4a1e",
  shadeName: "Rust",
} as const;
const EYE = {
  category: "eye",
  shadeHex: "#5b5a2a",
  shadeName: "Olive",
} as const;

describe("render params, canonical JSON", () => {
  it("sorts object keys so key order cannot change a hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1}}');
  });

  it("keeps array order, because order is meaning", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  it("writes null for undefined rather than dropping the value", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("render params, the hash", () => {
  it("is a 64 character lowercase hex digest, as migration 0003 expects", () => {
    const hash = paramsHash("makeup", makeup([LIP]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gives the same hash for the same look asked for in a different order", () => {
    expect(paramsHash("makeup", makeup([LIP, EYE]))).toBe(
      paramsHash("makeup", makeup([EYE, LIP])),
    );
  });

  it("ignores the case of a hex, because #9C4A1E is the same colour", () => {
    expect(paramsHash("makeup", makeup([LIP]))).toBe(
      paramsHash("makeup", makeup([{ ...LIP, shadeHex: "#9C4A1E" }])),
    );
  });

  it("ignores the shade name, because renaming a swatch is not a new render", () => {
    expect(paramsHash("makeup", makeup([LIP]))).toBe(
      paramsHash("makeup", makeup([{ ...LIP, shadeName: "Burnt rust" }])),
    );
  });

  it("changes with the colour", () => {
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("makeup", makeup([{ ...LIP, shadeHex: "#7a3a17" }])),
    );
  });

  it("changes with the number of categories in the look", () => {
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("makeup", makeup([LIP, EYE])),
    );
  });

  it("changes with the capture, so a new selfie never serves the old face", () => {
    const other = canonicalMakeupParams({
      captureId: "b3f1e0c2-1111-4a2b-8c3d-000000000002",
      params: { categories: [LIP] },
    });
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("makeup", other),
    );
  });

  it("changes with the kind, so two render types never share a row", () => {
    expect(paramsHash("makeup", makeup([LIP]))).not.toBe(
      paramsHash("hairstyle", makeup([LIP])),
    );
  });

  it("stores the shade name it does not hash, for the pending line", () => {
    const stored = makeup([LIP]);
    expect(stored.categories[0]?.shadeName).toBe("Rust");
    expect(stored.categories[0]?.shadeHex).toBe("#9c4a1e");
  });
});
