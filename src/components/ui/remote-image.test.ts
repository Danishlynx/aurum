import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_IMAGE_HOSTS,
  cssImageUrl,
  isConfiguredImageHost,
  isSafeListingUrl,
} from "./remote-image";

/**
 * The allowlist the product card checks has to be the allowlist the image
 * optimizer was configured with, or a card shows a broken frame in production
 * and nowhere else. Spec: docs/03-architecture.md, "Deployment".
 */

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("isConfiguredImageHost", () => {
  it("allows a SerpApi cached thumbnail", () => {
    expect(
      isConfiguredImageHost("https://serpapi.com/searches/abc/images/x.webp"),
    ).toBe(true);
  });

  it("allows a subdomain of an allowed host", () => {
    expect(
      isConfiguredImageHost("https://encrypted-tbn0.gstatic.com/shopping?q=x"),
    ).toBe(true);
  });

  it("refuses a host nobody configured", () => {
    expect(isConfiguredImageHost("https://cdn.example-store.com/x.jpg")).toBe(
      false,
    );
  });

  it("refuses the bare suffix of a wildcard pattern", () => {
    expect(isConfiguredImageHost("https://gstatic.com/x.jpg")).toBe(false);
  });

  it("refuses http, data, and javascript URLs", () => {
    expect(isConfiguredImageHost("http://serpapi.com/x.webp")).toBe(false);
    expect(isConfiguredImageHost("data:image/png;base64,AAAA")).toBe(false);
    expect(isConfiguredImageHost("javascript:alert(1)")).toBe(false);
  });

  it("refuses text that is not a URL", () => {
    expect(isConfiguredImageHost("not a url")).toBe(false);
  });

  it("allows an image this app serves itself, which is how fixtures render", () => {
    expect(isConfiguredImageHost("/fixtures/demo-product.jpg")).toBe(true);
    expect(isConfiguredImageHost("//evil.example.com/x.jpg")).toBe(false);
  });
});

describe("isSafeListingUrl", () => {
  it("allows the http and https listings SerpApi returns", () => {
    expect(isSafeListingUrl("https://store.example.com/p/1")).toBe(true);
    expect(isSafeListingUrl("http://store.example.com/p/1")).toBe(true);
  });

  it("refuses a scheme that would run instead of open", () => {
    expect(isSafeListingUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeListingUrl("data:text/html,<script></script>")).toBe(false);
  });

  it("refuses a relative path, because a listing is somewhere else", () => {
    expect(isSafeListingUrl("/p/1")).toBe(false);
    expect(isSafeListingUrl("")).toBe(false);
  });
});

describe("cssImageUrl", () => {
  it("wraps a signed URL, query string and all", () => {
    expect(
      cssImageUrl("https://project.supabase.co/mask.png?token=abc.def-ghi"),
    ).toBe('url("https://project.supabase.co/mask.png?token=abc.def-ghi")');
  });

  it("wraps a path this app serves itself", () => {
    expect(cssImageUrl("/fixtures/mask.png")).toBe('url("/fixtures/mask.png")');
  });

  it("refuses a scheme that is not http or https", () => {
    expect(cssImageUrl("javascript:alert(1)")).toBeNull();
    expect(cssImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(cssImageUrl("mask.png")).toBeNull();
  });

  it("encodes every character CSS could read as syntax", () => {
    const wrapped = cssImageUrl(
      'https://example.com/a b").png")%3Bbackground:red',
    );
    expect(wrapped).not.toBeNull();
    const value = wrapped ?? "";
    // One opening and one closing quote, and nothing between them can end the
    // value early or start a second declaration.
    expect(value.startsWith('url("')).toBe(true);
    expect(value.endsWith('")')).toBe(true);
    expect(value.slice(5, -2)).not.toMatch(/["()\s\\]/u);
  });
});

describe("next.config.ts", () => {
  it("configures every host in the allowlist", () => {
    const config = readFileSync(resolve(REPO_ROOT, "next.config.ts"), "utf8");
    for (const host of ALLOWED_IMAGE_HOSTS) {
      expect(config).toContain(`"${host}"`);
    }
  });
});
