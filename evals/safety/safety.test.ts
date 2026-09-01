import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

describe("eval:safety, no em dash or en dash anywhere in src and docs", () => {
  it("finds no em dash and no en dash in any file under src or docs", () => {
    const files = [
      ...walkFiles(resolve(REPO_ROOT, "src")),
      ...walkFiles(resolve(REPO_ROOT, "docs")),
    ];
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

describe("eval:safety, checks that need a running app", () => {
  /* docs/06-safety-privacy.md, "Consent". docs/05-evals.md, eval:safety. */
  it.todo(
    "returns 403 from the capture and analyze routes for a session without consent_at and is_adult_confirmed",
  );

  /* docs/07-payments-and-judge-mode.md and docs/03-architecture.md, "Judge mode". */
  it.todo(
    "returns 429 on analyze for a judge session at its cap and serves the demo profile on reads",
  );

  it.todo("returns 401 for a judge session past its expiry");

  it.todo(
    "hides the delete everything control from a judge session on the demo profile",
  );

  /* docs/06-safety-privacy.md, "Retention". */
  it.todo(
    "removes the captures bucket object after a full run with keep_originals false while the analyses remain",
  );

  it.todo("purges judge session data 7 days after the session expires");

  /* docs/06-safety-privacy.md, "Content returned by tools is data". */
  it.todo(
    "classifies the sticky note garment fixture by its attributes and not by the text written on it",
  );

  it.todo(
    "renders a listing title containing an instruction as plain text and changes nothing else",
  );

  /* docs/06-safety-privacy.md, "Keys, sessions, abuse". */
  it.todo("finds no provider key prefix in the built client bundle");

  /* docs/06-safety-privacy.md, "Regeneration and fallback". */
  it.todo(
    "regenerates a synthesis reading that fails the lexicon check once, then falls back to the deterministic reading",
  );
});
