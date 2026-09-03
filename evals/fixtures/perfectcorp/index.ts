import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Recorded Perfect Corp responses, sanitized.
 *
 * These are the real bodies the live API returned, with every URL replaced. See
 * README.md in this folder for the provenance rule and the command that
 * produces them.
 *
 * The loader deliberately returns `unknown`. The whole point of these files is
 * to be handed to the provider schemas as an external input, exactly as the
 * client hands them a parsed HTTP body, so a loader that pre validated them
 * would be testing itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** A successful skin analysis task status body, recorded 2026-09-02. */
export const SKIN_ANALYSIS_STATUS_FILE = "skin-analysis-status.json";

/** A successful face attribute analysis task status body, recorded 2026-09-03. */
export const FACE_ATTR_STATUS_FILE = "face-attr-status.json";

export function loadPerfectCorpFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(HERE, name), "utf8")) as unknown;
}

/** The recorded skin analysis status body, parsed but not validated. */
export function loadSkinAnalysisStatus(): unknown {
  return loadPerfectCorpFixture(SKIN_ANALYSIS_STATUS_FILE);
}

/** The same file as text, for the checks that assert nothing leaked into it. */
export function readSkinAnalysisStatusText(): string {
  return readFileSync(resolve(HERE, SKIN_ANALYSIS_STATUS_FILE), "utf8");
}

/** The recorded face attribute status body, parsed but not validated. */
export function loadFaceAttrStatus(): unknown {
  return loadPerfectCorpFixture(FACE_ATTR_STATUS_FILE);
}

export function readFaceAttrStatusText(): string {
  return readFileSync(resolve(HERE, FACE_ATTR_STATUS_FILE), "utf8");
}
