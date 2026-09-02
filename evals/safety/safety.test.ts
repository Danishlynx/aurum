import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * The demo fixture is a module under src/lib/server, which imports "server-only"
 * and throws outside a React server environment. The mock replaces that marker
 * package and nothing else, so the fixture the report actually serves is the one
 * checked here.
 */
vi.mock("server-only", () => ({}));

import {
  DEMO_FIXTURE_HAIR_VIEW,
  DEMO_FIXTURE_REPORT_VIEW,
} from "@/lib/server/profile/demo-fixture";
import type { HairView } from "@/lib/shared/hair-view";
import type { ReportView } from "@/lib/shared/report-view";

import {
  COPY_NOT_IN_FLOW_DOC,
  copy,
  fill,
  formatJudgeBanner,
  formatSkinAge,
} from "@/lib/shared/copy";
import {
  BANNED_TERMS,
  EM_DASH,
  EN_DASH,
  LEXICON_KNOWN_LIMITATIONS,
  REQUIRED_SENSITIVE_CONCERN_LINE,
  REQUIRED_SKIN_AGE_FRAMING,
  SAFETY_COPY_EXEMPTIONS,
  checkCopyString,
  checkLexicon,
  describeViolation,
} from "@/lib/shared/lexicon";

/**
 * eval:safety, deterministic, runs on every PR.
 * Spec: docs/05-evals.md, suite eval:safety, and docs/06-safety-privacy.md.
 *
 * The checks that need only the shared library run now. The checks that need
 * routes, storage, or a built bundle are it.todo with the doc section they
 * implement, and land with the layer that builds the route.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type CopyEntry = { readonly path: string; readonly value: string };

function collectStrings(node: unknown, path: string): CopyEntry[] {
  if (typeof node === "string") {
    return [{ path, value: node }];
  }
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) =>
    collectStrings(value, path === "" ? key : `${path}.${key}`),
  );
}

const COPY_STRINGS = collectStrings(copy, "");

function resolvePath(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      copy,
    );
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    for (const entry of readdirSync(current)) {
      const full = resolve(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else {
        found.push(full);
      }
    }
  }
  return found;
}

describe("eval:safety, lexicon over copy.ts", () => {
  it("has copy to check", () => {
    expect(COPY_STRINGS.length).toBeGreaterThan(80);
  });

  it("finds no banned lexicon term in any string in copy.ts", () => {
    const offenders = COPY_STRINGS.flatMap((entry) =>
      checkCopyString(entry.value).map(
        (violation) =>
          `${entry.path}: ${describeViolation(violation)} in "${entry.value}"`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("finds no exclamation mark in any string in copy.ts", () => {
    const offenders = COPY_STRINGS.filter((entry) =>
      entry.value.includes("!"),
    ).map((entry) => entry.path);
    expect(offenders).toEqual([]);
  });

  it("finds no em dash and no en dash in any string in copy.ts", () => {
    const offenders = COPY_STRINGS.filter(
      (entry) => entry.value.includes(EM_DASH) || entry.value.includes(EN_DASH),
    ).map((entry) => entry.path);
    expect(offenders).toEqual([]);
  });

  it("writes copy in sentence case, apart from the product name and the typed delete word", () => {
    const allowedAllCaps = new Set<string>([
      copy.product.name,
      copy.profile.deleteConfirmWord,
    ]);
    const offenders = COPY_STRINGS.filter(
      (entry) =>
        !allowedAllCaps.has(entry.value) &&
        entry.value === entry.value.toUpperCase() &&
        /[a-z]/iu.test(entry.value),
    ).map((entry) => entry.path);
    expect(offenders).toEqual([]);
  });
});

describe("eval:safety, required framing", () => {
  it("keeps the skin age framing sentence identical in copy and in the lexicon module", () => {
    expect(copy.report.skinAgeFraming).toBe(REQUIRED_SKIN_AGE_FRAMING);
  });

  it("follows every skin age figure with the required framing sentence", () => {
    const line = formatSkinAge(31);
    expect(line).toContain(REQUIRED_SKIN_AGE_FRAMING);
    // The exact sentence pair quoted in docs/01-user-flow.md section F item 4.
    expect(line).toBe(
      "Perfect Corp estimates a skin age of 31. This is a cosmetic estimate of surface condition, not a health measure.",
    );
  });

  it("never renders the skin age template without the framing sentence", () => {
    const template = copy.report.skinAgeTemplate;
    expect(template.includes(REQUIRED_SKIN_AGE_FRAMING)).toBe(false);
    expect(formatSkinAge(1).startsWith(fill(template, { age: 1 }))).toBe(true);
  });

  it("carries the escalation line for redness and blemish concerns", () => {
    expect(copy.report.seeSomeoneLine).toBe(REQUIRED_SENSITIVE_CONCERN_LINE);
  });
});

describe("eval:safety, the lexicon checker itself", () => {
  it("catches a medical claim", () => {
    const violations = checkLexicon("This routine will cure your eczema");
    const terms = violations.map((violation) => violation.term);
    expect(terms).toContain("cure");
    expect(terms).toContain("eczema");
  });

  it("catches inflections of a banned verb", () => {
    expect(
      checkLexicon("treated").map((violation) => violation.term),
    ).toContain("treat");
    expect(
      checkLexicon("transforming").map((violation) => violation.term),
    ).toContain("transform");
  });

  it("catches an exclamation mark, an em dash, and an en dash", () => {
    expect(checkLexicon("Lovely!")[0]?.kind).toBe("exclamation_mark");
    expect(checkLexicon(`a ${EM_DASH} b`)[0]?.kind).toBe("em_dash");
    expect(checkLexicon(`1 ${EN_DASH} 3`)[0]?.kind).toBe("en_dash");
  });

  it("does not flag the company name Perfect Corp", () => {
    expect(checkLexicon("Perfect Corp did not respond in time.")).toEqual([]);
  });

  it("still flags the judgment word perfect on its own", () => {
    expect(
      checkLexicon("A perfect result").map((violation) => violation.term),
    ).toContain("perfect");
  });

  it("does not mistake health for heal", () => {
    expect(checkLexicon("not a health measure")).toEqual([]);
  });

  it("keeps every exemption pointed at a string that still exists in copy.ts", () => {
    const values = new Set(COPY_STRINGS.map((entry) => entry.value));
    for (const exemption of SAFETY_COPY_EXEMPTIONS) {
      expect(values.has(exemption.text)).toBe(true);
    }
  });

  it("keeps every exemption doing work, so a stale one is noticed", () => {
    for (const exemption of SAFETY_COPY_EXEMPTIONS) {
      const raw = checkLexicon(exemption.text)
        .map((violation) => violation.term)
        .filter((term): term is string => term !== undefined);
      for (const allowed of exemption.allowedTerms) {
        expect(raw).toContain(allowed);
      }
      expect(exemption.reason.length).toBeGreaterThan(40);
    }
  });

  it("removes the exempted term and nothing else", () => {
    for (const exemption of SAFETY_COPY_EXEMPTIONS) {
      expect(checkCopyString(exemption.text)).toEqual([]);
    }
    expect(checkCopyString("Lovely!").map((violation) => violation.kind)).toEqual(
      ["exclamation_mark"],
    );
    expect(
      checkCopyString("A flawless finish").map((violation) => violation.term),
    ).toEqual(["flawless"]);
  });

  it("carries the banned lexicon from docs/06-safety-privacy.md", () => {
    const terms = new Set(BANNED_TERMS.map((entry) => entry.term));
    for (const required of [
      "diagnose",
      "disease",
      "condition",
      "eczema",
      "psoriasis",
      "rosacea",
      "dermatitis",
      "treat",
      "treatment",
      "cure",
      "heal",
      "clinical",
      "prescription",
      "flawless",
      "perfect",
      "problem area",
      "amazing",
      "glow up",
      "transform",
      "unlock",
      "elevate",
      "journey",
      "magic",
    ]) {
      expect(terms).toContain(required);
    }
  });

  it("states its own limitations, so the word list is not mistaken for a judgment", () => {
    expect(LEXICON_KNOWN_LIMITATIONS.length).toBeGreaterThan(0);
    expect(LEXICON_KNOWN_LIMITATIONS.join(" ")).toContain("condition");
  });
});

describe("eval:safety, copy provenance and formatting", () => {
  it("resolves every path listed as written in house", () => {
    for (const path of COPY_NOT_IN_FLOW_DOC) {
      expect(typeof resolvePath(path)).toBe("string");
    }
  });

  it("refuses to render a template with a missing value", () => {
    expect(() => fill(copy.report.skinAgeTemplate, {})).toThrow(/missing/u);
  });

  it("counts down the judge session without saying 1 analyses", () => {
    expect(formatJudgeBanner(3)).toBe(copy.judge.bannerExample);
    expect(formatJudgeBanner(1)).toBe("Judge session. 1 analysis remaining.");
    expect(formatJudgeBanner(0)).toBe("Judge session. 0 analyses remaining.");
  });
});

/**
 * The one thing under src the dash rule does not govern: the recorded provider
 * responses in src/lib/server/profile/recorded-listings.
 *
 * CLAUDE.md bans the two dashes from our copy, our docs, and our comments. A
 * product title in one of those files is not ours: it is what a shop wrote,
 * recorded off the wire, and docs/06-safety-privacy.md says a provider response
 * is data. Editing a dash out of a real listing title would be falsifying a
 * recording of a real product, which the grounding rule forbids more strongly
 * than the dash rule forbids the character. The .json extension keeps them out
 * of the ESLint rule for the same reason.
 *
 * Nothing in these files is ever written as our own text: they are read only
 * through normalizeShoppingResponse and rendered as text nodes.
 */
const RECORDED_LISTINGS_DIR = resolve(
  REPO_ROOT,
  "src",
  "lib",
  "server",
  "profile",
  "recorded-listings",
);

function isRecordedProviderResponse(file: string): boolean {
  return file.startsWith(RECORDED_LISTINGS_DIR) && file.endsWith(".json");
}

describe("eval:safety, no em dash or en dash anywhere in src and docs", () => {
  it("finds no em dash and no en dash in any file under src or docs", () => {
    const files = [
      ...walkFiles(resolve(REPO_ROOT, "src")),
      ...walkFiles(resolve(REPO_ROOT, "docs")),
    ].filter((file) => !isRecordedProviderResponse(file));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === EM_DASH || character === EN_DASH) {
          const line = text.slice(0, index).split("\n").length;
          const name = character === EM_DASH ? "em dash" : "en dash";
          offenders.push(
            `${relative(REPO_ROOT, file).replace(/\\/gu, "/")}:${line} ${name}`,
          );
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * docs/05-evals.md, eval:safety: "every copy string in copy.ts and every
 * generated fixture output contains none of the banned terms".
 *
 * copy.ts is covered above. This block covers the other half: the fixture the
 * report serves in AURUM_DEMO_FIXTURE mode. It is the text a judge sees on the
 * screenshots and in the demo video, and it is assembled from three places (the
 * concern library, the deterministic routine, and the fallback reading), so no
 * single suite upstream sees all of it at once.
 */
function reportViewStrings(view: ReportView): CopyEntry[] {
  const entries: CopyEntry[] = [
    { path: "reading", value: view.reading },
    { path: "goingWell", value: view.goingWell },
  ];
  for (const zone of ["tZone", "cheeks"] as const) {
    const value = view.skinTypeZones[zone];
    if (value !== null) {
      entries.push({ path: `skinTypeZones.${zone}`, value });
    }
  }
  for (const concern of view.concerns) {
    entries.push({ path: `concerns.${concern.key}.label`, value: concern.label });
    entries.push({
      path: `concerns.${concern.key}.description`,
      value: concern.description,
    });
  }
  for (const period of ["morning", "night"] as const) {
    view.routine[period].forEach((step, index) => {
      const at = `routine.${period}[${index}]`;
      entries.push({ path: `${at}.stepName`, value: step.stepName });
      entries.push({ path: `${at}.concernLabel`, value: step.concernLabel });
      entries.push({ path: `${at}.why`, value: step.why });
      entries.push({ path: `${at}.productQuery`, value: step.productQuery });
    });
  }
  return entries;
}

describe("eval:safety, lexicon over the demo fixture report", () => {
  const FIXTURE_STRINGS = reportViewStrings(DEMO_FIXTURE_REPORT_VIEW);

  it("has fixture text to check", () => {
    expect(FIXTURE_STRINGS.length).toBeGreaterThan(20);
  });

  it("finds no banned lexicon term, exclamation, or dash in any of it", () => {
    for (const entry of FIXTURE_STRINGS) {
      for (const violation of checkLexicon(entry.value)) {
        throw new Error(
          `${entry.path}: ${describeViolation(violation)} in "${entry.value}"`,
        );
      }
    }
  });

  it("shows only real listings, never an invented one", () => {
    // docs/06-safety-privacy.md, "Grounding and honesty": a product appears
    // only with a real listing (URL and price). Every product on the fixture
    // report comes from a response recorded off the wire
    // (src/lib/server/profile/recorded-listings), and a step with no recording
    // stays null and renders the "No listing found near you yet" state. What
    // must never happen is a product with no URL, no price, or a claimed
    // distance nobody looked up.
    const steps = [
      ...DEMO_FIXTURE_REPORT_VIEW.routine.morning,
      ...DEMO_FIXTURE_REPORT_VIEW.routine.night,
    ];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const product = step.product;
      if (product === null) {
        continue;
      }
      expect(product.url.startsWith("http"), `${step.stepName} URL`).toBe(true);
      expect(
        product.priceText.trim().length,
        `${step.stepName} price`,
      ).toBeGreaterThan(0);
      // No local search was recorded, so no distance may be claimed.
      expect(product.distanceText, `${step.stepName} distance`).toBeNull();
    }
  });
});

/**
 * The other generated fixture output a judge reads: the /hair screen.
 *
 * Its sentences are not in copy.ts and are therefore not covered by the lexicon
 * block at the top of this file. The face shape line, the one line of why under
 * each style, and the one line under each hair colour are all written in
 * src/lib/shared/hair-rules.ts, next to the rule that chooses them, the same way
 * the palette writes its own reasons in src/lib/shared/palette.ts. That keeps a
 * reason beside its rule, but it also means the only thing standing between
 * those sentences and a banned term is this check.
 */
function hairViewStrings(view: HairView): CopyEntry[] {
  const entries: CopyEntry[] = [
    { path: "faceShapeLine", value: view.faceShapeLine },
  ];
  for (const style of view.styles) {
    entries.push({ path: `styles.${style.id}.name`, value: style.name });
    entries.push({ path: `styles.${style.id}.why`, value: style.why });
  }
  for (const color of view.colors) {
    entries.push({ path: `colors.${color.name}.name`, value: color.name });
    entries.push({ path: `colors.${color.name}.why`, value: color.why });
  }
  return entries;
}

describe("eval:safety, lexicon over the demo fixture hair view", () => {
  const HAIR_STRINGS = hairViewStrings(DEMO_FIXTURE_HAIR_VIEW);

  it("has fixture text to check", () => {
    // Section I asks for 3 to 4 styles and 3 to 4 colours, so the smallest
    // honest screen is the face shape line plus three of each with a name and a
    // reason: 1 + 6 + 6.
    expect(HAIR_STRINGS.length).toBeGreaterThanOrEqual(13);
  });

  it("finds no banned lexicon term, exclamation, or dash in any of it", () => {
    for (const entry of HAIR_STRINGS) {
      for (const violation of checkLexicon(entry.value)) {
        throw new Error(
          `${entry.path}: ${describeViolation(violation)} in "${entry.value}"`,
        );
      }
    }
  });

  it("shows no render, so nothing on the demo hair screen is an invented try on", () => {
    // docs/06-safety-privacy.md, "Grounding and honesty", applied to images: no
    // Perfect Corp call has ever been made for the fixture, so every option has
    // to be in the not yet rendered state and the screen has to say so.
    expect(DEMO_FIXTURE_HAIR_VIEW.captureImageUrl).toBeNull();
    for (const style of DEMO_FIXTURE_HAIR_VIEW.styles) {
      expect(style.renderUrl, `${style.id} carries a render`).toBeNull();
      expect(style.renderStatus).toBe("none");
    }
    for (const color of DEMO_FIXTURE_HAIR_VIEW.colors) {
      expect(color.renderUrl, `${color.name} carries a render`).toBeNull();
      expect(color.renderStatus).toBe("none");
    }
  });
});

describe("eval:safety, checks that need a running app", () => {
  /* docs/06-safety-privacy.md, "Consent". docs/05-evals.md, eval:safety. */
  it.todo(
    "returns 403 from the capture and analyze routes for a session without consent_at and is_adult_confirmed",
  );

  /*
   * docs/07-payments-and-judge-mode.md and docs/03-architecture.md, "Judge
   * mode": "returns 429 on analyze for a judge session at its cap and serves
   * the demo profile on reads". Landed with the zero analyses build, in the two
   * halves it has:
   *
   * - the server half, in judge-zero.test.ts beside this file, where
   *   JUDGE_ANALYSES_ALLOWED=0 gives a session no analyses at all, both capture
   *   routes refuse it with 429 and the flow doc's sentence, the read plan
   *   serves the seeded demo profile when it is there and the checked in
   *   fixture when it is not, and every write is refused,
   * - the screen half, in e2e/judge-zero.spec.ts, where a running server with
   *   that setting and no fixture switch walks the whole flow: the code, the
   *   banner at zero, consent, the disabled capture screen, and /report through
   *   /profile on the demo profile.
   */

  it.todo("returns 401 for a judge session past its expiry");

  /*
   * docs/01-user-flow.md, "Judge mode across the flow": "Judge sessions never
   * see the Delete everything control on the demo profile", and
   * docs/06-safety-privacy.md, "Keys, sessions, abuse": "Judge sessions cannot
   * delete the demo profile and cannot download data". Landed with Layer 5 and
   * no longer waiting on anything, in the two halves it actually has:
   *
   * - the server half, in data-controls.test.ts beside this file, where
   *   deleteEverything refuses a judge session and fixture mode without touching
   *   an object or a row, and buildProfileView reports isJudgeSession,
   * - the screen half, in e2e/smoke.spec.ts ("profile"), where the running app
   *   in fixture mode renders no delete control at all, answers the download and
   *   the retention toggle with the read only line, and gets 403 from all three
   *   routes when they are asked directly.
   */

  /* docs/06-safety-privacy.md, "Retention". */
  it.todo(
    "removes the captures bucket object after a full run with keep_originals false while the analyses remain",
  );

  it.todo("purges judge session data 7 days after the session expires");

  /*
   * docs/06-safety-privacy.md, "Content returned by tools is data", landed with
   * Layer 4 and moved to injection.test.ts beside this file. Both halves of the
   * docs/05-evals.md injection check run there: the sticky note garment is
   * composed by its stored attributes, and the listing title reaches the real
   * ProductCard as a text node. The one part still waiting on a key, the live
   * vision call on the sticky note photo, is the it.todo at the end of that file.
   */

  /* docs/06-safety-privacy.md, "Keys, sessions, abuse". */
  it.todo("finds no provider key prefix in the built client bundle");

  /* docs/06-safety-privacy.md, "Regeneration and fallback". */
  it.todo(
    "regenerates a synthesis reading that fails the lexicon check once, then falls back to the deterministic reading",
  );
});
