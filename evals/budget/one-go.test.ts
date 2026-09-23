import { describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the one go reading rate as /api/judge/stats reports it.
 *
 * The arithmetic is pure (oneGoWindowOf) and the read is guarded: with no
 * Supabase project the rate is null, never a zero dressed up as a measurement.
 */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/db/service", () => ({
  serviceClient: () => {
    throw new Error("no project");
  },
}));

const { oneGoWindowOf, readOneGoStats } = await import("@/lib/server/jobs/outcomes");

describe("eval:budget, the one go rate", () => {
  it("counts one go over the rows a provider failure did not touch", () => {
    const window = oneGoWindowOf([
      { one_go: true, provider_failed: false },
      { one_go: true, provider_failed: false },
      { one_go: false, provider_failed: false },
      // An outage says nothing about the frame, so it is not a miss.
      { one_go: false, provider_failed: true },
    ]);
    expect(window).toEqual({ n: 3, ok: 2, rate: 2 / 3 });
  });

  it("answers null for the rate, not zero, when there are no rows", () => {
    expect(oneGoWindowOf([])).toEqual({ n: 0, ok: 0, rate: null });
  });

  it("answers null when there is no project to read the view from", async () => {
    const saved = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(await readOneGoStats()).toBeNull();
    } finally {
      if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.anon !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.anon;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });

  it("answers null when the view cannot be read, rather than failing the stats", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    try {
      expect(await readOneGoStats()).toBeNull();
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });
});
