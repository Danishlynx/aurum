import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts: this replaces the marker. */
vi.mock("server-only", () => ({}));

/**
 * The one database call the read plan makes, replaced so this file can ask what
 * happens with a seeded demo profile and without one, on a machine that has
 * neither. Nothing here reaches Supabase and nothing here spends a credit.
 */
vi.mock("@/lib/server/profile/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/server/profile/db")>();
  return {
    ...original,
    getAestheticProfile: vi.fn(),
    upsertAestheticProfile: vi.fn(),
  };
});

import { judgeConfig } from "@/lib/server/env";
import { messages } from "@/lib/server/http/messages";
import { isHttpError } from "@/lib/server/http/responses";
import {
  consumeJudgeAnalysis,
  createJudgeSession,
  DEMO_OWNER_ID,
  judgeAnalysesRemaining,
  loadJudgeSession,
  recordJudgeConsent,
} from "@/lib/server/judge";
import {
  demoProfileIsReadOnly,
  isDemoFixtureMode,
  judgeAnalysesExhausted,
  planDemoRead,
  DEMO_FIXTURE_ENV,
} from "@/lib/server/judge/demo";
import {
  clearFixtureJudgeSessions,
  JUDGE_FIXTURE_ENV,
} from "@/lib/server/judge/fixture-store";
import { refuseWhenJudgeAnalysesExhausted } from "@/lib/server/judge/guard";
import { judgeLanding } from "@/lib/client/judge-session";
import { saveLook } from "@/lib/server/looks/save";
import { confirmUndertone } from "@/lib/server/profile/color";
import { deleteEverything, setKeepOriginals } from "@/lib/server/profile/delete";
import {
  getAestheticProfile,
  upsertAestheticProfile,
  type AestheticProfile,
} from "@/lib/server/profile/db";
import { DEMO_FIXTURE_REPORT_VIEW } from "@/lib/server/profile/demo-fixture";
import { saveHairChoice } from "@/lib/server/profile/hair";
import { buildReportView } from "@/lib/server/profile/report-view";
import { buildProfileView } from "@/lib/server/profile/view";
import type { JudgeSession } from "@/lib/server/db/types";
import type { AppSession } from "@/lib/server/session";
import { copy, formatJudgeBanner } from "@/lib/shared/copy";

/**
 * eval:safety, the judge session that is given no analyses at all.
 *
 * Why this suite exists: the Perfect Corp trial units in this build are counted
 * in tens, so judging spends none of them. JUDGE_ANALYSES_ALLOWED=0 is the
 * setting that makes that true, and docs/01-user-flow.md, "Judge mode across the
 * flow", says exactly what has to happen at zero: "capture is disabled with the
 * line 'This session has used its analyses. Exploring the saved demo profile.'
 * and every screen renders from the demo profile so nothing is dead".
 * docs/03-architecture.md adds the server half: "Requests beyond a cap return
 * 429 with the copy from the flow doc", and "When a judge session exceeds its
 * cap, every read route serves the demo profile".
 *
 * Every provider function is out of reach here: no key is read, no request is
 * made, and the only database call in the path is mocked. A run of this file
 * costs nothing.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function judgeRow(overrides: Partial<JudgeSession> = {}): JudgeSession {
  return {
    id: "judge-session-zero",
    code_hash: "not a real hash",
    expires_at: "2099-01-01T00:00:00.000Z",
    analyses_allowed: 0,
    analyses_used: 0,
    credits_cap: 0,
    credits_used: 0,
    last_seen_at: null,
    consent_at: "2026-01-01T00:00:00.000Z",
    consent_version: "2026-01-01",
    is_adult_confirmed: true,
    keep_originals: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function judgeSession(overrides: Partial<JudgeSession> = {}): AppSession {
  const row = judgeRow(overrides);
  return {
    kind: "judge",
    id: row.id,
    ownerType: "judge_session",
    session: row,
  };
}

const USER_SESSION: AppSession = {
  kind: "user",
  id: "user-1",
  ownerType: "user",
};

/** A profile row with no capture behind it, which is what the seed writes. */
function demoProfileRow(): AestheticProfile {
  return {
    user_id: DEMO_OWNER_ID,
    capture_id: null,
    skin_type_zones: null,
    concerns: [],
    skin_age: null,
    fitzpatrick: null,
    skin_tone_hex: "#8d5524",
    undertone: "warm",
    undertone_source: "detected",
    eye_color_hex: null,
    hair_color_hex: null,
    face_shape: "Oval",
    hair_type: null,
    saved_hair_style_id: null,
    saved_hair_color_name: null,
    saved_makeup: null,
    season: "deep_autumn",
    palette: null,
    reading: null,
    reading_model: null,
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as AestheticProfile;
}

const SUPABASE_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const TOUCHED_VARS = [
  DEMO_FIXTURE_ENV,
  JUDGE_FIXTURE_ENV,
  "JUDGE_ANALYSES_ALLOWED",
  "JUDGE_CREDITS_CAP",
  "JUDGE_ACCESS_CODE_HASH",
  ...SUPABASE_VARS,
] as const;

const saved = new Map<string, string | undefined>();

const readProfile = vi.mocked(getAestheticProfile);
const writeProfile = vi.mocked(upsertAestheticProfile);

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of TOUCHED_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  clearFixtureJudgeSessions();
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  saved.clear();
  clearFixtureJudgeSessions();
});

/** Pretends a project is configured. No client is ever built from these. */
function configureSupabase(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-not-real";
}

/* ------------------------------------------------------------------ */
/* The setting itself                                                  */
/* ------------------------------------------------------------------ */

describe("eval:safety, JUDGE_ANALYSES_ALLOWED=0", () => {
  it("is read as zero rather than falling back to the default of three", () => {
    process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
    process.env.JUDGE_ANALYSES_ALLOWED = "0";

    expect(judgeConfig().analysesAllowed).toBe(0);
  });

  it("still refuses a value that is not a whole count", () => {
    process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
    process.env.JUDGE_ANALYSES_ALLOWED = "none";

    expect(judgeConfig().analysesAllowed).toBe(3);
  });

  it("gives a fresh session no analyses at all", async () => {
    process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
    process.env.JUDGE_ANALYSES_ALLOWED = "0";
    process.env.JUDGE_CREDITS_CAP = "0";
    process.env[JUDGE_FIXTURE_ENV] = "true";

    // No Supabase project is configured in this run, so a session that reached
    // for the database would throw rather than answer.
    const session = await createJudgeSession();

    expect(session.analyses_allowed).toBe(0);
    expect(judgeAnalysesRemaining(session)).toBe(0);
    expect(await loadJudgeSession(session.id)).toEqual(session);
  });

  it("refuses the first analysis of a fresh session, without a counter moving", async () => {
    process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
    process.env.JUDGE_ANALYSES_ALLOWED = "0";
    process.env[JUDGE_FIXTURE_ENV] = "true";

    const session = await createJudgeSession();
    const outcome = await consumeJudgeAnalysis(session.id);

    expect(outcome).toEqual({ ok: false, reason: "exhausted" });
    expect((await loadJudgeSession(session.id))?.analyses_used).toBe(0);
  });

  it("still lets the judge consent, because consent is not an analysis", async () => {
    process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
    process.env.JUDGE_ANALYSES_ALLOWED = "0";
    process.env[JUDGE_FIXTURE_ENV] = "true";

    const session = await createJudgeSession();
    const updated = await recordJudgeConsent({
      sessionId: session.id,
      consentVersion: "2026-01-01",
      keepOriginals: false,
    });

    expect(updated?.is_adult_confirmed).toBe(true);
    expect(updated?.consent_at).not.toBeNull();
    expect(updated?.keep_originals).toBe(false);
  });

  it("writes the banner the flow doc asks for, with the count at zero", () => {
    expect(formatJudgeBanner(0)).toBe("Judge session. 0 analyses remaining.");
    // The template the doc shows, filled: the words never change, only the
    // number does.
    expect(formatJudgeBanner(0)).toBe(
      copy.judge.bannerTemplate.replace("{count}", "0"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* The refusal                                                         */
/* ------------------------------------------------------------------ */

describe("eval:safety, the capture and analyze guard at zero", () => {
  const routes = ["/api/captures", "/api/captures/[id]/analyze"] as const;

  it.each(routes)("answers %s with 429 and the flow doc line", (route) => {
    let thrown: unknown = null;
    try {
      refuseWhenJudgeAnalysesExhausted({
        session: judgeSession(),
        route,
        requestId: "request-1",
      });
    } catch (error) {
      thrown = error;
    }

    expect(isHttpError(thrown)).toBe(true);
    if (!isHttpError(thrown)) {
      return;
    }
    expect(thrown.status).toBe(429);
    expect(thrown.code).toBe("judge_analyses");
    expect(thrown.extra).toEqual({ remaining: 0 });
    expect(thrown.message).toBe(
      "This session has used its analyses. Exploring the saved demo profile.",
    );
    expect(thrown.message).toBe(copy.errors.judgeExhausted);
    expect(thrown.message).toBe(messages.judgeExhausted);
  });

  it("never says a session used three analyses it was never given", () => {
    expect(messages.judgeExhausted).not.toContain("3");
    // The /judge screen's sentence is the one that names three, and it stays on
    // that screen (docs/01-user-flow.md section B).
    expect(copy.judge.exhausted).toContain("3 analyses");
  });

  it("lets a session with an analysis left through untouched", () => {
    expect(() => {
      refuseWhenJudgeAnalysesExhausted({
        session: judgeSession({ analyses_allowed: 3, analyses_used: 1 }),
        route: "/api/captures",
        requestId: "request-2",
      });
    }).not.toThrow();
  });

  it("does not apply to a signed in person, who has their own daily cap", () => {
    expect(() => {
      refuseWhenJudgeAnalysesExhausted({
        session: USER_SESSION,
        route: "/api/captures",
        requestId: "request-3",
      });
    }).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Where the code lands                                                */
/* ------------------------------------------------------------------ */

describe("eval:safety, where the judge code lands", () => {
  it("sends a session that was given no analyses to the demo profile", () => {
    // docs/01-user-flow.md section C: a person who already has a profile skips
    // the consent screen and lands on /report. This session reads the saved demo
    // profile on every screen and can never take a photo, so it is that person.
    expect(judgeLanding({ analysesAllowed: 0, analysesRemaining: 0 })).toBe(
      "/report",
    );
  });

  it("never routes a session with no analyses at the capture flow", () => {
    // /welcome is the consent screen, and the only thing behind it is /capture,
    // which this session is refused at with 429 above. Landing there is the two
    // screen dead end this decision exists to prevent.
    expect(judgeLanding({ analysesAllowed: 0, analysesRemaining: 0 })).not.toBe(
      "/welcome",
    );
  });

  it("keeps consent in front of a session that can still take a photo", () => {
    // docs/06-safety-privacy.md: nothing is captured before consent, so a judge
    // with an analysis to spend goes through /welcome like anyone else.
    expect(judgeLanding({ analysesAllowed: 3, analysesRemaining: 3 })).toBe(
      "/welcome",
    );
    expect(judgeLanding({ analysesAllowed: 3, analysesRemaining: 1 })).toBe(
      "/welcome",
    );
  });

  it("tells a session that spent its analyses rather than routing it", () => {
    // docs/01-user-flow.md section B writes copy for this state and no other:
    // "This session has used its 3 analyses." It is true only when three were
    // given, which is why it is not what a zero session is told.
    expect(judgeLanding({ analysesAllowed: 3, analysesRemaining: 0 })).toBe(
      "exhausted",
    );
  });
});

/* ------------------------------------------------------------------ */
/* The read plan                                                       */
/* ------------------------------------------------------------------ */

describe("eval:safety, where a screen reads from", () => {
  it("knows a judge session at zero from one that still has an analysis", () => {
    expect(judgeAnalysesExhausted(judgeSession())).toBe(true);
    expect(
      judgeAnalysesExhausted(
        judgeSession({ analyses_allowed: 3, analyses_used: 1 }),
      ),
    ).toBe(false);
    expect(judgeAnalysesExhausted(USER_SESSION)).toBe(false);
    expect(judgeAnalysesExhausted(null)).toBe(false);
  });

  it("reads the caller's own rows for a signed in person", async () => {
    await expect(planDemoRead(USER_SESSION)).resolves.toEqual({
      source: "live",
      ownerId: "user-1",
    });
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("reads the caller's own rows for a judge with an analysis left", async () => {
    const session = judgeSession({ analyses_allowed: 3, analyses_used: 2 });
    await expect(planDemoRead(session)).resolves.toEqual({
      source: "live",
      ownerId: session.id,
    });
  });

  it("serves the checked in fixture when the environment switch is on", async () => {
    process.env[DEMO_FIXTURE_ENV] = "true";
    expect(isDemoFixtureMode()).toBe(true);

    await expect(planDemoRead(USER_SESSION)).resolves.toEqual({
      source: "fixture",
      reason: "env",
    });
  });

  it("serves the seeded demo profile to a judge at zero when it is there", async () => {
    configureSupabase();
    readProfile.mockResolvedValue(demoProfileRow());

    await expect(planDemoRead(judgeSession())).resolves.toEqual({
      source: "database",
      ownerId: DEMO_OWNER_ID,
    });
    expect(readProfile).toHaveBeenCalledWith(DEMO_OWNER_ID);
  });

  it("falls back to the fixture when nothing has been seeded", async () => {
    configureSupabase();
    readProfile.mockResolvedValue(null);

    await expect(planDemoRead(judgeSession())).resolves.toEqual({
      source: "fixture",
      reason: "judge_exhausted",
    });
  });

  it("falls back to the fixture when the seed cannot be read at all", async () => {
    configureSupabase();
    readProfile.mockRejectedValue(new Error("the database said no"));

    await expect(planDemoRead(judgeSession())).resolves.toEqual({
      source: "fixture",
      reason: "judge_exhausted",
    });
  });

  it("asks nothing at all with no Supabase project configured", async () => {
    await expect(planDemoRead(judgeSession())).resolves.toEqual({
      source: "fixture",
      reason: "judge_exhausted",
    });
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("keeps the environment switch out of the judge decision", async () => {
    // The judge path reaches the same fixture builders with the switch unset,
    // which is what lets it be a development only switch and still be true in
    // production for a judge session.
    expect(isDemoFixtureMode()).toBe(false);

    const plan = await planDemoRead(judgeSession());

    expect(plan).toEqual({ source: "fixture", reason: "judge_exhausted" });
    expect(process.env[DEMO_FIXTURE_ENV]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* The screens                                                         */
/* ------------------------------------------------------------------ */

describe("eval:safety, every screen renders for a judge at zero", () => {
  it("serves the report from the fixture with no switch and no database", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    try {
      const view = await buildReportView(judgeSession());

      expect(view).toBe(DEMO_FIXTURE_REPORT_VIEW);
      // The log line says which of the two fixture reasons is true, so a judge
      // read is never recorded as an environment switch that is not set.
      expect(logged.join(" ")).toContain("judge_exhausted");
      expect(logged.join(" ")).not.toContain(`${DEMO_FIXTURE_ENV} is true`);
    } finally {
      spy.mockRestore();
    }
  });

  it("serves the profile rows from the fixture, read only, with no delete", async () => {
    const view = await buildProfileView(judgeSession());

    expect(view.isJudgeSession).toBe(true);
    expect(view.rows).toHaveLength(6);
    expect(view.saved.map((item) => item.kind)).toEqual(["look", "look"]);
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("reads the seeded demo profile's rows when the seed is there", async () => {
    configureSupabase();
    readProfile.mockResolvedValue(demoProfileRow());

    const view = await buildReportView(judgeSession());

    // Not the fixture object: this came from the row the seed wrote, under the
    // demo owner id rather than the judge session's own id.
    expect(view).not.toBe(DEMO_FIXTURE_REPORT_VIEW);
    expect(readProfile).toHaveBeenCalledWith(DEMO_OWNER_ID);
    expect(readProfile).not.toHaveBeenCalledWith("judge-session-zero");
  });
});

/* ------------------------------------------------------------------ */
/* The writes                                                          */
/* ------------------------------------------------------------------ */

describe("eval:safety, the demo profile stays read only", () => {
  it("says a judge session at zero may not write", () => {
    expect(demoProfileIsReadOnly(judgeSession())).toBe(true);
    expect(
      demoProfileIsReadOnly(
        judgeSession({ analyses_allowed: 3, analyses_used: 1 }),
      ),
    ).toBe(false);
    expect(demoProfileIsReadOnly(USER_SESSION)).toBe(false);
  });

  it("refuses the hair save without touching a row", async () => {
    const outcome = await saveHairChoice({
      session: judgeSession(),
      styleId: "long_layers",
      colorName: null,
    });

    expect(outcome).toEqual({ ok: false, reason: "fixture_read_only" });
    expect(writeProfile).not.toHaveBeenCalled();
  });

  it("refuses the undertone confirmation without touching a row", async () => {
    const outcome = await confirmUndertone({
      session: judgeSession(),
      undertone: "cool",
    });

    expect(outcome).toEqual({ ok: false, reason: "fixture_read_only" });
    expect(writeProfile).not.toHaveBeenCalled();
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("refuses the retention toggle without touching a row", async () => {
    const outcome = await setKeepOriginals({
      session: judgeSession(),
      keepOriginals: true,
    });

    expect(outcome).toEqual({ ok: false, reason: "read_only" });
  });

  it("still refuses the delete for a judge with analyses left", async () => {
    // docs/06-safety-privacy.md: a judge never deletes the demo profile,
    // whatever their count says.
    const outcome = await deleteEverything({
      session: judgeSession({ analyses_allowed: 3, analyses_used: 0 }),
    });

    expect(outcome).toEqual({ ok: false, reason: "read_only" });
  });

  it("refuses the look save without touching a row", async () => {
    const outcome = await saveLook({
      session: judgeSession(),
      lookId: "00000000-0000-4000-8000-0000000000ff",
    });

    expect(outcome).toEqual({ ok: false, reason: "fixture_read_only" });
  });
});
