import "server-only";

/**
 * The only Claude model identifiers this app may use.
 *
 * Verified against https://platform.claude.com/docs/en/docs_site_map.md and the
 * models overview it links to on 2026-09-01. Note that
 * https://docs.claude.com/en/docs_site_map.md now redirects to platform.claude.com.
 *
 * Spec: docs/04-integrations.md (Claude API, models).
 */

export const ANTHROPIC_MODEL_IDS = {
  /** The reading. Ranked concerns and labels become one short paragraph. */
  synthesis: "claude-sonnet-5",
  /** Look ranking and rationales. */
  stylist: "claude-sonnet-5",
  /** Garment classification from one photo. */
  classifier: "claude-haiku-4-5-20251001",
} as const;

export type AnthropicUseCase = keyof typeof ANTHROPIC_MODEL_IDS;
export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[AnthropicUseCase];

export interface AnthropicModelProfile {
  readonly id: AnthropicModelId;
  readonly displayName: string;
  /**
   * Claude Sonnet 5 rejects non default temperature, top_p, and top_k with a
   * 400. Haiku 4.5 still takes them.
   */
  readonly acceptsSamplingParams: boolean;
  /**
   * Claude Sonnet 5 runs adaptive thinking when the thinking field is left off,
   * and max_tokens caps thinking plus response text together. For a short
   * forced tool call that would eat the budget, so thinking is set to disabled
   * explicitly.
   */
  readonly thinksByDefault: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  /** Longest image edge the model reads at full fidelity. */
  readonly maxImageLongEdgePx: number;
  readonly verifiedOn: string;
  readonly source: string;
}

const SOURCE = "https://platform.claude.com/docs/en/docs_site_map.md";
const VERIFIED_ON = "2026-09-01";

export const ANTHROPIC_MODEL_PROFILES: Readonly<
  Record<AnthropicModelId, AnthropicModelProfile>
> = {
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    acceptsSamplingParams: false,
    thinksByDefault: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxImageLongEdgePx: 2576,
    verifiedOn: VERIFIED_ON,
    source: SOURCE,
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    acceptsSamplingParams: true,
    thinksByDefault: false,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    maxImageLongEdgePx: 1568,
    verifiedOn: VERIFIED_ON,
    source: SOURCE,
  },
};

export function modelFor(useCase: AnthropicUseCase): AnthropicModelProfile {
  return ANTHROPIC_MODEL_PROFILES[ANTHROPIC_MODEL_IDS[useCase]];
}

export function isKnownModelId(value: string): value is AnthropicModelId {
  return Object.prototype.hasOwnProperty.call(ANTHROPIC_MODEL_PROFILES, value);
}

/**
 * The string stored on aesthetic_profiles.reading_model, so a stored reading
 * can always be traced back to the model and the prompt that produced it.
 */
export function readingModelTag(modelId: AnthropicModelId, promptVersion: string): string {
  return `${modelId}/${promptVersion}`;
}
