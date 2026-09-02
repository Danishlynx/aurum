import { describe, expect, it, vi } from "vitest";

/**
 * Modules under src/lib/server import "server-only", which throws outside a
 * React server environment. The mock replaces that marker package and nothing
 * else, so the real provider code runs here.
 */
vi.mock("server-only", () => ({}));

import {
  PERFECTCORP_AUTH,
  PERFECTCORP_CREDIT_ENDPOINT,
} from "@/lib/server/providers/perfectcorp/endpoints";
import { creditBalanceResponseSchema } from "@/lib/server/providers/perfectcorp/schemas";
import {
  creditExpiryToIso,
  totalCreditUnits,
} from "@/lib/server/providers/perfectcorp";

/**
 * eval:budget, deterministic, runs on every PR.
 * The credit balance read, docs/04-integrations.md ("Authentication" and the
 * credit table).
 *
 * No network here: this pins the parse and the arithmetic against the exact body
 * the live API returned on 2026-09-02, so a change in either is caught without
 * spending a call. budget.test.ts prices what a session would reserve; this is
 * the other half, the account balance that reservation runs against.
 */

/** Verbatim shape of the live 200, with the account's own numbers replaced. */
const LIVE_BODY = {
  status: 200,
  results: [
    {
      id: 1,
      type: "ApiPaygToken",
      amount: 40,
      amount_dec: 40,
      expiry: 1_819_929_599_000,
    },
  ],
};

describe("perfect corp credit balance", () => {
  it("parses the live response shape", () => {
    const parsed = creditBalanceResponseSchema.safeParse(LIVE_BODY);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.results[0].amount).toBe(40);
    expect(parsed.data?.results[0].type).toBe("ApiPaygToken");
  });

  it("survives a grant that stops reporting an expiry", () => {
    const parsed = creditBalanceResponseSchema.safeParse({
      status: 200,
      results: [{ type: "ApiPaygToken", amount: 12 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a body that is missing the units", () => {
    const parsed = creditBalanceResponseSchema.safeParse({
      status: 200,
      results: [{ type: "ApiPaygToken" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("adds every grant, and reads an empty account as zero", () => {
    expect(totalCreditUnits([])).toBe(0);
    expect(
      totalCreditUnits([
        { kind: "ApiPaygToken", units: 40, expiresAt: null },
        { kind: "ApiTrialToken", units: 2, expiresAt: null },
      ]),
    ).toBe(42);
  });

  it("turns an expiry into an ISO date and refuses to throw on a bad one", () => {
    expect(creditExpiryToIso(1_819_929_599_000)).toBe("2027-09-02T23:59:59.000Z");
    expect(creditExpiryToIso(undefined)).toBeNull();
    expect(creditExpiryToIso(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("perfect corp auth", () => {
  /**
   * The point of the record: the console hands out a secret, which looks like it
   * demands a token exchange. It does not. If someone deletes this note and
   * reintroduces the exchange, this test is the thing that asks why.
   */
  it("is the api key as a bearer token, confirmed against the live API", () => {
    expect(PERFECTCORP_AUTH.scheme).toBe("bearer_api_key");
    expect(PERFECTCORP_AUTH.verification.state).toBe("confirmed");
    expect(PERFECTCORP_AUTH.tokenExchangePath).toBe("/s2s/v1.0/client/auth");
  });

  it("has a confirmed credit endpoint that creates no task", () => {
    expect(PERFECTCORP_CREDIT_ENDPOINT.path).toBe("/s2s/v1.0/client/credit");
    expect(PERFECTCORP_CREDIT_ENDPOINT.verification.state).toBe("confirmed");
    expect(PERFECTCORP_CREDIT_ENDPOINT.path).not.toContain("/task/");
  });
});
