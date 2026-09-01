import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";

import {
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TEMPERATURE,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_NAME,
  buildClassifierRetryPrompt,
  buildClassifierUserPrompt,
  classifierOutputSchema,
  findClassifierProblems,
  type ClassifierOutput,
  type ClassifierVocabulary,
} from "@/lib/prompts/classifier";
import {
  STYLIST_MAX_TOKENS,
  STYLIST_PROMPT_VERSION,
  STYLIST_SYSTEM_PROMPT,
  STYLIST_TEMPERATURE,
  STYLIST_TOOL_DESCRIPTION,
  STYLIST_TOOL_NAME,
  buildStylistUserPrompt,
  stylistOutputSchema,
  type StylistInput,
  type StylistOutput,
} from "@/lib/prompts/stylist";
import {
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_PROMPT_VERSION,
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_TEMPERATURE,
  SYNTHESIS_TOOL_DESCRIPTION,
  SYNTHESIS_TOOL_NAME,
  buildSynthesisRetryPrompt,
  buildSynthesisUserPrompt,
  synthesisOutputSchema,
  type SynthesisInput,
  type SynthesisOutput,
} from "@/lib/prompts/synthesis";
import { ProviderError, issuePathsOf } from "../errors";
import { anthropicClient, toAnthropicProviderError } from "./client";
import { toToolInputSchema } from "./json-schema";
import {
  ANTHROPIC_MODEL_PROFILES,
  modelFor,
  readingModelTag,
  type AnthropicModelId,
  type AnthropicModelProfile,
  type AnthropicUseCase,
} from "./models";
import { readUsage, textMessage, type PromptMessage, type TokenUsage } from "./schemas";

export { ANTHROPIC_MODEL_IDS, modelFor, readingModelTag, isKnownModelId } from "./models";
export type { AnthropicModelId, AnthropicUseCase } from "./models";
export { isAnthropicConfigured, resetAnthropicClient } from "./client";
export { toToolInputSchema, SchemaConversionError } from "./json-schema";
export { textMessage } from "./schemas";
export type { PromptContentBlock, PromptMessage, TokenUsage } from "./schemas";

const PROVIDER = "anthropic" as const;

export interface StructuredCallResult<T> {
  readonly value: T;
  readonly model: AnthropicModelId;
  readonly usage: TokenUsage;
  /** 1 when the first answer parsed, 2 when the retry was needed. */
  readonly attempts: number;
}

export interface StructuredCallArgs<T> {
  readonly useCase: AnthropicUseCase;
  readonly system: string;
  readonly messages: readonly PromptMessage[];
  readonly toolName: string;
  readonly toolDescription: string;
  readonly schema: ZodType<T>;
  readonly maxTokens: number;
  /**
   * Only sent to a model that accepts sampling parameters. Claude Sonnet 5
   * rejects a non default temperature with a 400, so it is dropped there.
   */
  readonly temperature?: number;
  /**
   * Turns the failure of the first attempt into an extra user turn for the
   * retry. Return null to skip the retry.
   */
  readonly buildRetryPrompt?: (problems: readonly string[]) => string | null;
  /**
   * Runs after the schema parses. Returning problems triggers the same single
   * retry that a parse failure does.
   */
  readonly validate?: (value: T) => readonly string[];
}

function toSdkContent(
  blocks: readonly PromptMessage["content"][number][],
): Anthropic.ContentBlockParam[] {
  return blocks.map((block) => {
    if (block.kind === "text") {
      return { type: "text", text: block.text };
    }
    return {
      type: "image",
      source: { type: "base64", media_type: block.mediaType, data: block.base64 },
    };
  });
}

function toSdkMessages(messages: readonly PromptMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: toSdkContent(message.content),
  }));
}

function toolFor(
  name: string,
  description: string,
  schema: ZodType<unknown>,
): Anthropic.Tool {
  return {
    name,
    description,
    input_schema: toToolInputSchema(schema) as unknown as Anthropic.Tool.InputSchema,
  };
}

function readToolInput(message: Anthropic.Message, toolName: string): unknown {
  if (message.stop_reason === "refusal") {
    throw new ProviderError({
      provider: PROVIDER,
      code: "provider_error",
      message: "The model declined the request.",
      providerCode: "refusal",
    });
  }
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  throw new ProviderError({
    provider: PROVIDER,
    code: "invalid_response",
    message:
      message.stop_reason === "max_tokens"
        ? "The model ran out of output tokens before it finished the tool call."
        : `The model did not call the "${toolName}" tool.`,
    providerCode: message.stop_reason ?? undefined,
  });
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

async function sendOnce(args: {
  readonly profile: AnthropicModelProfile;
  readonly system: string;
  readonly messages: readonly PromptMessage[];
  readonly tool: Anthropic.Tool;
  readonly maxTokens: number;
  readonly temperature: number | undefined;
  readonly context: string;
}): Promise<Anthropic.Message> {
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: args.profile.id,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: toSdkMessages(args.messages),
    tools: [args.tool],
    tool_choice: { type: "tool", name: args.tool.name },
  };

  // Sonnet 5 thinks by default and max_tokens covers thinking plus the answer,
  // so a short forced tool call needs thinking switched off to leave room.
  if (args.profile.thinksByDefault) {
    body.thinking = { type: "disabled" };
  }
  if (args.profile.acceptsSamplingParams && args.temperature !== undefined) {
    body.temperature = args.temperature;
  }

  try {
    return await anthropicClient().messages.create(body);
  } catch (thrown) {
    throw toAnthropicProviderError(thrown, args.context);
  }
}

/**
 * One structured call: a single forced tool whose input_schema comes from the
 * zod schema, and whose input is parsed with that same schema. A parse failure
 * or a failed validate is retried once with the problems listed. A second
 * failure throws, and the caller uses its deterministic fallback.
 *
 * Spec: docs/04-integrations.md (structured outputs).
 */
export async function callStructured<T>(
  args: StructuredCallArgs<T>,
): Promise<StructuredCallResult<T>> {
  const profile = modelFor(args.useCase);
  const tool = toolFor(args.toolName, args.toolDescription, args.schema as ZodType<unknown>);
  const context = `The ${args.useCase} call`;

  let messages: readonly PromptMessage[] = args.messages;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const message = await sendOnce({
      profile,
      system: args.system,
      messages,
      tool,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      context,
    });
    usage = addUsage(usage, readUsage(message.usage));

    const problems: string[] = [];
    let value: T | null = null;

    const parsed = args.schema.safeParse(readToolInput(message, args.toolName));
    if (parsed.success) {
      value = parsed.data;
      problems.push(...(args.validate?.(parsed.data) ?? []));
    } else {
      problems.push(
        ...issuePathsOf(parsed.error.issues).map(
          (path) => `the field "${path}" was missing or the wrong type`,
        ),
      );
    }

    if (value !== null && problems.length === 0) {
      return { value, model: profile.id, usage, attempts: attempt };
    }

    if (attempt === 2) {
      throw new ProviderError({
        provider: PROVIDER,
        code: "invalid_response",
        message: `${context} did not return a usable answer after one retry.`,
        issuePaths: problems,
      });
    }

    const retryPrompt = args.buildRetryPrompt?.(problems) ?? defaultRetryPrompt(problems);
    if (retryPrompt === null) {
      throw new ProviderError({
        provider: PROVIDER,
        code: "invalid_response",
        message: `${context} did not return a usable answer.`,
        issuePaths: problems,
      });
    }
    messages = [...args.messages, textMessage("user", retryPrompt)];
  }

  // Unreachable: the loop either returns or throws.
  throw new ProviderError({
    provider: PROVIDER,
    code: "invalid_response",
    message: `${context} did not return a usable answer.`,
  });
}

function defaultRetryPrompt(problems: readonly string[]): string {
  return [
    "The previous answer did not fit the required shape.",
    `Fix these: ${problems.join("; ")}.`,
    "Call the tool again with every required field filled.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The three uses                                                      */
/* ------------------------------------------------------------------ */

export interface SynthesisCallResult extends StructuredCallResult<SynthesisOutput> {
  readonly promptVersion: string;
  /** Goes on aesthetic_profiles.reading_model. */
  readonly readingModel: string;
}

/**
 * The reading. Scores and labels in, one short paragraph and a routine out.
 * The output still has to pass the safety lexicon check before it is stored.
 */
export async function runSynthesis(
  input: SynthesisInput,
  options?: { readonly lexiconViolations?: readonly string[] },
): Promise<SynthesisCallResult> {
  const messages: PromptMessage[] = [
    textMessage("user", buildSynthesisUserPrompt(input)),
  ];
  const violations = options?.lexiconViolations ?? [];
  if (violations.length > 0) {
    messages.push(textMessage("user", buildSynthesisRetryPrompt(violations)));
  }

  const result = await callStructured({
    useCase: "synthesis",
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages,
    toolName: SYNTHESIS_TOOL_NAME,
    toolDescription: SYNTHESIS_TOOL_DESCRIPTION,
    schema: synthesisOutputSchema,
    maxTokens: SYNTHESIS_MAX_TOKENS,
    temperature: SYNTHESIS_TEMPERATURE,
  });

  return {
    ...result,
    promptVersion: SYNTHESIS_PROMPT_VERSION,
    readingModel: readingModelTag(result.model, SYNTHESIS_PROMPT_VERSION),
  };
}

export interface StylistCallResult extends StructuredCallResult<StylistOutput> {
  readonly promptVersion: string;
}

/** Look ranking. The rules engine made the candidates, the model orders them. */
export async function runStylist(input: StylistInput): Promise<StylistCallResult> {
  const knownCombinationIds = new Set(input.combinations.map((entry) => entry.combinationId));

  const result = await callStructured({
    useCase: "stylist",
    system: STYLIST_SYSTEM_PROMPT,
    messages: [textMessage("user", buildStylistUserPrompt(input))],
    toolName: STYLIST_TOOL_NAME,
    toolDescription: STYLIST_TOOL_DESCRIPTION,
    schema: stylistOutputSchema,
    maxTokens: STYLIST_MAX_TOKENS,
    temperature: STYLIST_TEMPERATURE,
    validate: (value) => {
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const entry of value.ranked) {
        if (!knownCombinationIds.has(entry.combination_id)) {
          problems.push(`combination_id "${entry.combination_id}" was not in the candidates`);
        }
        if (seen.has(entry.combination_id)) {
          problems.push(`combination_id "${entry.combination_id}" appeared more than once`);
        }
        seen.add(entry.combination_id);
      }
      if (seen.size !== knownCombinationIds.size) {
        problems.push("every candidate combination has to appear exactly once");
      }
      return problems;
    },
  });

  return { ...result, promptVersion: STYLIST_PROMPT_VERSION };
}

export interface ClassifierCallResult extends StructuredCallResult<ClassifierOutput> {
  readonly promptVersion: string;
}

export interface ClassifierCallInput {
  readonly vocabulary: ClassifierVocabulary;
  readonly image: {
    readonly mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    /** Base64 with no line breaks. */
    readonly base64: string;
  };
}

/**
 * Garment classification from one photo. Text inside the photo is data about
 * the garment, never an instruction, which the prompt states and eval:safety
 * tests with the sticky note fixture.
 */
export async function runGarmentClassifier(
  input: ClassifierCallInput,
): Promise<ClassifierCallResult> {
  const result = await callStructured({
    useCase: "classifier",
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { kind: "image", mediaType: input.image.mediaType, base64: input.image.base64 },
          { kind: "text", text: buildClassifierUserPrompt(input.vocabulary) },
        ],
      },
    ],
    toolName: CLASSIFIER_TOOL_NAME,
    toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
    schema: classifierOutputSchema,
    maxTokens: CLASSIFIER_MAX_TOKENS,
    temperature: CLASSIFIER_TEMPERATURE,
    validate: (value) => findClassifierProblems(value, input.vocabulary),
    buildRetryPrompt: (problems) => buildClassifierRetryPrompt(problems),
  });

  return { ...result, promptVersion: CLASSIFIER_PROMPT_VERSION };
}

/** The longest image edge each model reads, for the downscale step. */
export function maxImageLongEdgeFor(useCase: AnthropicUseCase): number {
  return ANTHROPIC_MODEL_PROFILES[modelFor(useCase).id].maxImageLongEdgePx;
}
