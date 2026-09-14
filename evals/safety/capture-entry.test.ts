import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts: this replaces the marker. */
vi.mock("server-only", () => ({}));

import { captureEntryFor } from "@/lib/server/capture/entry";
import { createJudgeSession } from "@/lib/server/judge";
import {
  clearFixtureJudgeSessions,
  JUDGE_FIXTURE_ENV,
} from "@/lib/server/judge/fixture-store";
import type { JudgeSession } from "@/lib/server/db/types";
import type { AppSession } from "@/lib/server/session";

/**
 * eval:safety, the door in front of the camera.
 *
 * On 2026-09-14 a phone whose judge session had run out reached /capture from
 * a restored tab, framed a selfie, tapped, and was told "Upload did not
 * complete. Your photo was not saved. Try again." The register call had
 * answered 401 and the screen had no way of saying so. With open access on,
 * the consent screen mints a session for a device without one, so the honest
 * answer to a missing session is to go there first, before the photo.
 *
 * Nothing here reaches Supabase: the judge sessions are the in memory fixture
 * store, and the decision is a pure function of what was read.
 */

const TOUCHED_VARS = [
  JUDGE_FIXTURE_ENV,
  "JUDGE_ACCESS_CODE_HASH",
  "JUDGE_PER_SESSION_CAPS",
  "JUDGE_ANALYSES_ALLOWED",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOUCHED_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env[JUDGE_FIXTURE_ENV] = "true";
  process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
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

function appSession(session: JudgeSession): AppSession {
  return {
    kind: "judge",
    id: session.id,
    ownerType: "judge_session",
    session,
  };
}

describe("captureEntryFor, with open access on", () => {
  it("sends a device with no session to consent before it frames a photo", () => {
    expect(
      captureEntryFor({ openAccess: true, session: null, consented: null }),
    ).toEqual({ kind: "welcome" });
  });

  it("sends a session that has not consented to consent", async () => {
    const session = appSession(await createJudgeSession());
    expect(
      captureEntryFor({ openAccess: true, session, consented: false }),
    ).toEqual({ kind: "welcome" });
  });

  it("offers the camera to a consented session", async () => {
    const session = appSession(await createJudgeSession());
    expect(
      captureEntryFor({ openAccess: true, session, consented: true }),
    ).toEqual({ kind: "camera", analysesExhausted: false });
  });

  it("still disables the camera for a session the per session cap has stopped", async () => {
    process.env.JUDGE_PER_SESSION_CAPS = "true";
    process.env.JUDGE_ANALYSES_ALLOWED = "0";
    const session = appSession(await createJudgeSession());
    expect(
      captureEntryFor({ openAccess: true, session, consented: true }),
    ).toEqual({ kind: "camera", analysesExhausted: true });
  });
});

describe("captureEntryFor, with the access code in front of the app", () => {
  /**
   * The camera screen has always been a public screen in this mode: the e2e
   * servers run with no Supabase project and no session, and a missing session
   * is repaired at /judge rather than at consent. Nothing changes here.
   */
  it("offers the camera whether or not there is a session", async () => {
    expect(
      captureEntryFor({ openAccess: false, session: null, consented: null }),
    ).toEqual({ kind: "camera", analysesExhausted: false });
    const session = appSession(await createJudgeSession());
    expect(
      captureEntryFor({ openAccess: false, session, consented: false }),
    ).toEqual({ kind: "camera", analysesExhausted: false });
  });
});
