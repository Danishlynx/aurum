import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";
import { TextSourceCodeBase, VisitNodeStep } from "@eslint/plugin-kit";

const here = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: here });

const CODE_FILES = ["**/*.{js,jsx,mjs,cjs,ts,tsx}"];
const TEXT_FILES = ["**/*.md", "src/**/*.css"];

/*
 * A minimal plain text language so the same dash rule can lint Markdown and CSS.
 * The AST is a single Document node; rules read sourceCode.text and report by index.
 */
class PlainTextSourceCode extends TextSourceCodeBase {
  constructor({ text, ast }) {
    super({ text, ast });
  }

  *traverse() {
    yield new VisitNodeStep({ target: this.ast, phase: 1, args: [this.ast] });
  }

  getDisableDirectives() {
    return { directives: [], problems: [] };
  }

  getInlineConfigNodes() {
    return [];
  }

  applyInlineConfig() {
    return { configs: [], problems: [] };
  }
}

const plainText = {
  fileType: "text",
  lineStart: 1,
  columnStart: 0,
  nodeTypeKey: "type",
  visitorKeys: { Document: [] },
  validateLanguageOptions() {
    // No options are supported.
  },
  parse(file) {
    const text = String(file.body);
    return {
      ok: true,
      ast: {
        type: "Document",
        loc: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: 0 },
        },
        range: [0, text.length],
      },
    };
  },
  createSourceCode(file, parseResult) {
    return new PlainTextSourceCode({
      text: String(file.body),
      ast: parseResult.ast,
    });
  },
};

function locateIndex(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r\n|\r|\n/u);
  const lastLine = lines[lines.length - 1] ?? "";
  return { line: lines.length, column: lastLine.length };
}

/*
 * Rule: no em dash (U+2014) and no en dash (U+2013), anywhere.
 * Non negotiable in CLAUDE.md and docs/06-safety-privacy.md.
 */
const noDashes = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow em dashes and en dashes. Use commas, colons, periods, or parentheses. Write ranges as 1 to 3.",
    },
    schema: [],
    messages: {
      emDash:
        "Em dash found. Use a comma, a colon, a period, or parentheses instead.",
      enDash: "En dash found. Write ranges as 1 to 3, or use a hyphen.",
    },
  },
  create(context) {
    function check() {
      const text = context.sourceCode.text;
      // U+2013 en dash, U+2014 em dash. Written as escapes so this file passes its own rule.
      const pattern = /[\u2013\u2014]/gu;
      let match = pattern.exec(text);
      while (match !== null) {
        context.report({
          loc: locateIndex(text, match.index),
          messageId: match[0] === "\u2014" ? "emDash" : "enDash",
        });
        match = pattern.exec(text);
      }
    }

    return { Program: check, Document: check };
  },
};

/*
 * Rule: no hex color literals in src/components and src/app.
 * Colors come from the Tailwind theme, which reads src/styles/tokens.css.
 */
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/u;

const noHexColors = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw hex colors in components. Use the design tokens from docs/02-design-system.md.",
    },
    schema: [],
    messages: {
      hex: "Raw hex color '{{value}}' found. Use a design token from src/styles/tokens.css through the Tailwind theme.",
    },
  },
  create(context) {
    function inspect(node, value) {
      if (typeof value !== "string") {
        return;
      }
      const found = HEX_COLOR.exec(value);
      if (found === null) {
        return;
      }
      context.report({ node, messageId: "hex", data: { value: found[0] } });
    }

    return {
      Literal(node) {
        inspect(node, node.value);
      },
      TemplateElement(node) {
        inspect(node, node.value.cooked);
      },
    };
  },
};

/*
 * Rule: every module under src/lib/server starts with import "server-only".
 * See CLAUDE.md and docs/03-architecture.md, security boundaries in code.
 */
const requireServerOnly = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the server-only import at the top of every module under src/lib/server.",
    },
    schema: [],
    messages: {
      missing:
        "Modules under src/lib/server must start with: import \"server-only\";",
    },
  },
  create(context) {
    return {
      Program(node) {
        const first = node.body[0];
        const isServerOnly =
          first !== undefined &&
          first.type === "ImportDeclaration" &&
          first.specifiers.length === 0 &&
          first.source.value === "server-only";
        if (!isServerOnly) {
          context.report({ node, messageId: "missing" });
        }
      },
    };
  },
};

/*
 * Rule: a client component never imports a server only module.
 * Triggered by the "use client" directive, so server components stay unaffected.
 */
const SERVER_IMPORT = /(^@\/lib\/server(\/|$))|((^|\/)lib\/server(\/|$))/u;

const noServerImportsInClient = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing src/lib/server or server-only from a client component.",
    },
    schema: [],
    messages: {
      leak: "'{{source}}' is server only. A client component must not import it. Move the call behind a route handler or a server component.",
    },
  },
  create(context) {
    const body = context.sourceCode.ast.body;
    const isClient = body.some(
      (statement) =>
        statement.type === "ExpressionStatement" &&
        statement.expression.type === "Literal" &&
        statement.expression.value === "use client",
    );

    if (!isClient) {
      return {};
    }

    function inspect(node, source) {
      if (typeof source !== "string") {
        return;
      }
      if (source === "server-only" || SERVER_IMPORT.test(source)) {
        context.report({ node, messageId: "leak", data: { source } });
      }
    }

    return {
      ImportDeclaration(node) {
        inspect(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null && node.source !== undefined) {
          inspect(node, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        inspect(node, node.source.value);
      },
    };
  },
};

const aurum = {
  meta: { name: "aurum" },
  languages: { "plain-text": plainText },
  rules: {
    "no-dashes": noDashes,
    "no-hex-colors": noHexColors,
    "require-server-only": requireServerOnly,
    "no-server-imports-in-client": noServerImportsInClient,
  },
};

const nextConfigs = compat
  .extends("next/core-web-vitals", "next/typescript")
  .map((entry) => ({ ...entry, files: CODE_FILES }));

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "evals/results/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  ...nextConfigs,
  {
    files: CODE_FILES,
    plugins: { aurum },
    rules: {
      "aurum/no-dashes": "error",
      "aurum/no-server-imports-in-client": "error",
    },
  },
  {
    files: TEXT_FILES,
    plugins: { aurum },
    language: "aurum/plain-text",
    rules: {
      "aurum/no-dashes": "error",
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    plugins: { aurum },
    rules: {
      "aurum/no-hex-colors": "error",
    },
  },
  {
    files: ["src/lib/server/**/*.{ts,tsx}"],
    plugins: { aurum },
    rules: {
      "aurum/require-server-only": "error",
    },
  },
];

export default config;
