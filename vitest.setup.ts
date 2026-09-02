/**
 * The network is off inside every suite.
 *
 * The unit tests and the eval suites are the only thing that exercises the
 * golden run script, the SerpApi recorder, and the seeder, and all three of them
 * exist to spend real money: Perfect Corp trial units, of which there are forty
 * in total, and SerpApi searches off a free plan. A mock that is forgotten in one
 * place would send a real request and take real units, and it would do it
 * quietly, because a passing test says nothing about where its bytes went.
 *
 * So the runner takes the network away rather than trusting each suite to mock
 * it. Nothing in this repository calls fetch in a test on purpose: every provider
 * module is replaced with vi.mock, and the pure functions do arithmetic. If this
 * throws, a mock is missing, and the fix is the mock, never an exception here.
 *
 * A suite that genuinely wants to watch a request can still assign its own
 * vi.fn() to globalThis.fetch: this file runs before the suite, so the suite's
 * assignment wins for the file it is in.
 *
 * The two suites that are meant to spend money on purpose (the live listing
 * check in eval:grounding and the model judged rubric in eval:synthesis) import
 * realFetch below and put it back for themselves, and only when their opt in
 * variable is set. Holding a key is never enough: a key sitting in a shell must
 * never turn a gate red or spend anything.
 */

/** The runtime's own fetch, captured before it is taken away. */
export const realFetch: typeof fetch = globalThis.fetch;

/**
 * Whether a suite is allowed to put realFetch back and spend real money.
 * Set AURUM_LIVE_EVALS=true to opt in, one command at a time.
 */
export const LIVE_EVALS_ENV = "AURUM_LIVE_EVALS";

export function liveEvalsOptedIn(): boolean {
  return process.env[LIVE_EVALS_ENV] === "true";
}

const refuseNetwork = (input: unknown): never => {
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input === "object" && input !== null && "url" in input
          ? String((input as { url: unknown }).url)
          : "an unnamed request";
  throw new Error(
    `A test tried to reach the network (${target}). Tests never call a provider: ` +
      "mock the module with vi.mock and return a fixture. See vitest.setup.ts.",
  );
};

globalThis.fetch = refuseNetwork as unknown as typeof fetch;
