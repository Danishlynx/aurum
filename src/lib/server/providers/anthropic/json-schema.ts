import "server-only";

import type { ZodType } from "zod";

/**
 * A small local zod to JSON Schema converter.
 *
 * Structured output uses tool use with a single forced tool whose input_schema
 * is the zod schema converted to JSON Schema, and the tool input is parsed with
 * that same zod schema. This keeps one source of truth for the shape.
 *
 * The dependency set for this build is fixed, so this is written here rather
 * than pulled in. It covers only the node kinds the prompt schemas use and
 * throws on anything else, so an unsupported node fails loudly at build and
 * test time instead of producing a tool schema that quietly does not match.
 *
 * Spec: docs/04-integrations.md (structured outputs).
 */

export interface JsonSchemaNode {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly (string | number)[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  additionalProperties?: false;
  anyOf?: readonly JsonSchemaNode[];
}

export interface JsonSchemaObject extends JsonSchemaNode {
  type: "object";
  properties: Record<string, JsonSchemaNode>;
  required: readonly string[];
  additionalProperties: false;
}

interface ZodDefLike {
  readonly type: string;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly element?: unknown;
  readonly innerType?: unknown;
  readonly entries?: Readonly<Record<string, string | number>>;
  readonly values?: readonly unknown[];
}

export class SchemaConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaConversionError";
  }
}

function defOf(schema: unknown, path: string): ZodDefLike {
  const internal = (schema as { _zod?: { def?: unknown } } | null)?._zod;
  const def = internal?.def;
  if (typeof def !== "object" || def === null) {
    throw new SchemaConversionError(
      `The value at "${path}" is not a zod schema this converter can read.`,
    );
  }
  return def as ZodDefLike;
}

function descriptionOf(schema: unknown): string | undefined {
  const value = (schema as { description?: unknown } | null)?.description;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isOptional(schema: unknown, path: string): boolean {
  return defOf(schema, path).type === "optional";
}

function convert(schema: unknown, path: string): JsonSchemaNode {
  const def = defOf(schema, path);
  const description = descriptionOf(schema);
  const node = convertByType(def, path);
  return description === undefined ? node : { ...node, description };
}

function convertByType(def: ZodDefLike, path: string): JsonSchemaNode {
  switch (def.type) {
    case "string":
      return { type: "string" };

    case "number":
      return { type: "number" };

    case "boolean":
      return { type: "boolean" };

    case "enum": {
      const entries = def.entries;
      if (entries === undefined) {
        throw new SchemaConversionError(`The enum at "${path}" carries no values.`);
      }
      const values = Object.values(entries);
      if (values.length === 0) {
        throw new SchemaConversionError(`The enum at "${path}" carries no values.`);
      }
      return { type: "string", enum: values.map((value) => String(value)) };
    }

    case "literal": {
      const values = def.values ?? [];
      const usable = values.filter(
        (value): value is string | number =>
          typeof value === "string" || typeof value === "number",
      );
      if (usable.length === 0) {
        throw new SchemaConversionError(
          `The literal at "${path}" is not a string or a number.`,
        );
      }
      return { type: typeof usable[0] === "number" ? "number" : "string", enum: usable };
    }

    case "array": {
      if (def.element === undefined) {
        throw new SchemaConversionError(`The array at "${path}" carries no element schema.`);
      }
      return { type: "array", items: convert(def.element, `${path}[]`) };
    }

    case "object":
      return convertObject(def, path);

    case "optional": {
      if (def.innerType === undefined) {
        throw new SchemaConversionError(`The optional at "${path}" carries no inner schema.`);
      }
      return convert(def.innerType, path);
    }

    case "nullable": {
      if (def.innerType === undefined) {
        throw new SchemaConversionError(`The nullable at "${path}" carries no inner schema.`);
      }
      return { anyOf: [convert(def.innerType, path), { type: "null" }] };
    }

    default:
      throw new SchemaConversionError(
        `The zod node "${def.type}" at "${path}" is not supported by this converter. ` +
          "Use a supported node or extend json-schema.ts.",
      );
  }
}

function convertObject(def: ZodDefLike, path: string): JsonSchemaObject {
  const shape = def.shape;
  if (shape === undefined) {
    throw new SchemaConversionError(`The object at "${path}" carries no shape.`);
  }
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    properties[key] = convert(child, childPath);
    if (!isOptional(child, childPath)) {
      required.push(key);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Converts a zod object schema into the JSON Schema an Anthropic tool takes as
 * its input_schema. The root has to be an object, which is what tool use needs.
 */
export function toToolInputSchema(schema: ZodType): JsonSchemaObject {
  const def = defOf(schema, "");
  if (def.type !== "object") {
    throw new SchemaConversionError("A tool input schema has to be a zod object at the root.");
  }
  return convertObject(def, "");
}
