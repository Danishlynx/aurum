import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";

import { copy } from "@/lib/shared/copy";
import "@/styles/tokens.css";
import "@/styles/globals.css";

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
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen bg-canvas font-body text-body text-text">
        {children}
      </body>
    </html>
  );
}
