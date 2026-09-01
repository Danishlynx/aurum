import type { Config } from "tailwindcss";

/**
 * The only visual language is docs/02-design-system.md.
 * Every value here reads a CSS variable declared in src/styles/tokens.css.
 * Adding a color, a font, a radius, or a shadow means editing the design system doc first.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    // Two radii, nothing else. The capture frame oval is handled per component.
    borderRadius: {
      sm: "6px",
      md: "12px",
    },
    // Elevation is off. Depth comes from tonal layering and 1px hairlines.
    boxShadow: {},
    extend: {
      colors: {
        canvas: "var(--canvas)",
        surface: "var(--surface)",
        raised: "var(--raised)",
        text: "var(--text)",
        "text-muted": "var(--text-muted)",
        accent: "var(--accent)",
        "accent-bright": "var(--accent-bright)",
        positive: "var(--positive)",
        caution: "var(--caution)",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
      },
      fontSize: {
        "display-1": ["44px", { lineHeight: "48px", letterSpacing: "-0.01em" }],
        "display-2": ["32px", { lineHeight: "38px" }],
        title: ["24px", { lineHeight: "30px" }],
        reading: ["19px", { lineHeight: "30px" }],
        body: ["16px", { lineHeight: "24px" }],
        small: ["14px", { lineHeight: "20px" }],
        micro: ["12px", { lineHeight: "16px" }],
      },
    },
  },
  plugins: [],
};

export default config;
