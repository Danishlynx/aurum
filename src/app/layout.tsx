import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import type { ReactNode } from "react";

import { JudgeBanner } from "@/components/judge/JudgeBanner";
import { copy } from "@/lib/shared/copy";
import "@/styles/tokens.css";
import "@/styles/globals.css";

/**
 * The root shell: the Obsidian canvas, the two families, and the judge banner,
 * which docs/01-user-flow.md keeps visible on every screen.
 *
 * The bottom navigation is not here. It belongs to the (app) group only, so the
 * landing, judge, consent, capture, and reveal screens have no chrome at all.
 *
 * Reading the judge cookie makes every route dynamic. That is the right trade
 * for this app: nothing here is cacheable at the edge anyway, and the banner has
 * to be correct on the first paint of every screen.
 */

const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display-loaded",
});

const body = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-body-loaded",
});

export const metadata: Metadata = {
  title: copy.product.name,
  description: copy.landing.subhead,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // themeColor is deliberately not set here: it would need the Obsidian hex as a
  // literal, and colors live in src/styles/tokens.css only.
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen bg-canvas font-body text-body text-text">
        <JudgeBanner />
        {children}
      </body>
    </html>
  );
}
