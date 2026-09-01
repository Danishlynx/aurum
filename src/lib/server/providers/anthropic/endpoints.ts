import "server-only";

/**
 * The Claude API surface this app uses, and the verification state of each fact
 * the calls depend on. The SDK builds the request, so what is recorded here is
 * the parameter set and the per model restrictions, not raw paths we construct.
 *
 * Spec: docs/04-integrations.md (Claude API).
 */

export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

/** docs/04-integrations.md: timeouts 30 seconds. */
export const ANTHROPIC_HTTP_TIMEOUT_MS = 30_000;

/** The synthesis and stylist calls stay well inside this. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 900;

export type VerificationState = "confirmed" | "unverified";

export interface Verification {
  readonly state: VerificationState;
  readonly source: string;
  readonly checkedOn: string;
  readonly note: string;
}

export interface AnthropicSurfaceFact {
  readonly key: string;
  readonly verification: Verification;
}

const CHECKED_ON = "2026-09-01";
const SITE_MAP = "https://platform.claude.com/docs/en/docs_site_map.md";
const MODELS = "https://platform.claude.com/docs/en/models/overview.md";
const VISION = "https://platform.claude.com/docs/en/build-with-claude/vision.md";

export const ANTHROPIC_SURFACE: readonly AnthropicSurfaceFact[] = [
  {
    key: "messages_endpoint",
    verification: {
      state: "confirmed",
      source: SITE_MAP,
      checkedOn: CHECKED_ON,
      note:
        "Everything goes through POST /v1/messages. The SDK builds the request, so no path is " +
        "assembled by hand in this module.",
    },
  },
  {
    key: "forced_tool_use",
    verification: {
      state: "confirmed",
      source: SITE_MAP,
      checkedOn: CHECKED_ON,
      note:
        "tool_choice { type: \"tool\", name } forces one named tool, so the answer always comes " +
        "back as a tool_use block whose input we parse with the same zod schema that produced " +
        "input_schema.",
    },
  },
  {
    key: "model_ids",
    verification: {
      state: "confirmed",
      source: MODELS,
      checkedOn: CHECKED_ON,
      note:
        "claude-sonnet-5 and claude-haiku-4-5 (full id claude-haiku-4-5-20251001) are both current. " +
        "The identifiers in docs/04-integrations.md were correct as written.",
    },
  },
  {
    key: "sonnet_5_sampling_params",
    verification: {
      state: "confirmed",
      source: MODELS,
      checkedOn: CHECKED_ON,
      note:
        "Claude Sonnet 5 rejects a non default temperature, top_p, or top_k with a 400. The " +
        "temperature of 0.3 in docs/04-integrations.md cannot be sent to it. Steering happens in " +
        "the prompt instead. Haiku 4.5 still takes temperature, so the classifier keeps it.",
    },
  },
  {
    key: "sonnet_5_thinking_default",
    verification: {
      state: "confirmed",
      source: MODELS,
      checkedOn: CHECKED_ON,
      note:
        "Claude Sonnet 5 runs adaptive thinking when the thinking field is left off, and max_tokens " +
        "caps thinking plus response text together. With max_tokens at 900 that truncates, so the " +
        "structured calls set thinking to disabled explicitly.",
    },
  },
  {
    key: "vision_limits",
    verification: {
      state: "confirmed",
      source: VISION,
      checkedOn: CHECKED_ON,
      note:
        "Claude Sonnet 5 reads images up to 2576px on the long edge. Haiku 4.5 sits in the older " +
        "tier at 1568px. Garment photos going to the classifier are downscaled to 1568px.",
    },
  },
];

export function surfaceFact(key: string): AnthropicSurfaceFact | undefined {
  return ANTHROPIC_SURFACE.find((fact) => fact.key === key);
}
