import "server-only";

import { z } from "zod";

/**
 * Zod for the parts of a Claude response this module reads.
 * The SDK types the response, but a structured output is only trustworthy once
 * it has been parsed, so the tool input goes through the caller's schema and
 * the usage block goes through this one.
 *
 * Spec: docs/04-integrations.md (structured outputs, general rules).
 */

export const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export function readUsage(value: unknown): TokenUsage {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: parsed.data.input_tokens,
    outputTokens: parsed.data.output_tokens,
  };
}

/** Image media types the vision calls accept. */
export const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * The prompt shape callers build. The wire format stays inside this module, so
 * nothing outside it knows what a content block looks like.
 */
export type PromptContentBlock =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly mediaType: ImageMediaType;
      /** Base64 with no line breaks. */
      readonly base64: string;
    };

export interface PromptMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly PromptContentBlock[];
}

export function textMessage(role: "user" | "assistant", text: string): PromptMessage {
  return { role, content: [{ kind: "text", text }] };
}
