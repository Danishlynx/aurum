import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * env.ts is a module under src/lib/server, which imports "server-only" and
 * throws outside a React server environment. The mock replaces that marker
 * package and nothing else, so what is checked here is the real reader.
 */
vi.mock("server-only", () => ({}));

import {
  OPEN_ACCESS_ON_VALUE,
  openAccessEnabled,
  providerCallsEnabled,
} from "@/lib/server/env";

/**
 * eval:safety, open access.
 *
 * AURUM_OPEN_ACCESS removes the access code from in front of the app
 * (docs/07-payments-and-judge-mode.md). What it must never do is remove it by
 * accident: the code is the only thing between a published URL and the account's
 * Perfect Corp balance, so the flag has to be off for every value except one
 * exact string, and it has to be off when nobody has set it at all.
 *
 * The contrast with PROVIDER_CALLS_ENABLED is deliberate and is asserted here so
 * it cannot be quietly made "consistent". That one is a kill switch and reads
 * anything but the literal "false" as on, because a typo must not disable the
 * product. This one reads anything but the literal "true" as off, because a typo
 * must not open it.
 */

const KEY = "AURUM_OPEN_ACCESS";
const original = process.env[KEY];

beforeEach(() => {
  delete process.env[KEY];
});

afterEach(() => {
  if (original === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = original;
  }
});

describe("openAccessEnabled", () => {
  it("is off when nothing is set", () => {
    expect(openAccessEnabled()).toBe(false);
  });

  it("is on for exactly one value", () => {
    process.env[KEY] = OPEN_ACCESS_ON_VALUE;
    expect(openAccessEnabled()).toBe(true);
  });

  it("is off for everything that merely looks like yes", () => {
    for (const value of [
      "True",
      "TRUE",
      "1",
      "yes",
      "on",
      "enabled",
      "tru",
      "",
      "false",
    ]) {
      process.env[KEY] = value;
      expect(openAccessEnabled(), `${KEY}=${JSON.stringify(value)}`).toBe(false);
    }
  });

  /**
   * Surrounding whitespace is trimmed before the comparison, so a value pasted
   * into a dashboard with a stray space still means what it says. Case is not:
   * "True" is off, because the set of values that open this has to be exactly
   * one thing somebody typed on purpose.
   */
  it("trims but does not interpret", () => {
    process.env[KEY] = `  ${OPEN_ACCESS_ON_VALUE}  `;
    expect(openAccessEnabled()).toBe(true);
    process.env[KEY] = "  True  ";
    expect(openAccessEnabled()).toBe(false);
  });

  /**
   * The two flags fail in opposite directions on purpose. A kill switch that a
   * typo disables is a broken product; an open door that a typo opens is a
   * drained account.
   */
  it("fails closed where the kill switch fails open", () => {
    process.env[KEY] = "typo";
    process.env.PROVIDER_CALLS_ENABLED = "typo";
    expect(openAccessEnabled()).toBe(false);
    expect(providerCallsEnabled()).toBe(true);
    delete process.env.PROVIDER_CALLS_ENABLED;
  });
});
