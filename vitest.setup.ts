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
 */
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
