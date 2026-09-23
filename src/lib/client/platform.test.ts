import { afterEach, describe, expect, it, vi } from "vitest";

import { currentPlatform, platformFromUserAgent } from "./platform";

describe("platformFromUserAgent", () => {
  it("reads an iPhone, an iPad and an iPod as ios", () => {
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("ios");
    expect(
      platformFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)"),
    ).toBe("ios");
    expect(platformFromUserAgent("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0)")).toBe(
      "ios",
    );
  });

  it("reads an Android phone as android", () => {
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("android");
  });

  it("reads everything else as desktop, including an empty string", () => {
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("desktop");
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
      ),
    ).toBe("desktop");
    expect(platformFromUserAgent("")).toBe("desktop");
  });

  it("is case sensitive on purpose, so a lower case product name is not a phone", () => {
    // "android" appears in some desktop developer tool strings in lower case.
    expect(platformFromUserAgent("something android-studio")).toBe("desktop");
  });

  describe("currentPlatform", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("answers desktop where there is no navigator at all", () => {
      // Node 22 defines a global navigator whose userAgent is "Node.js/22", so
      // without the stub this would pass through the regex path and prove
      // nothing about the guard.
      vi.stubGlobal("navigator", undefined);
      expect(typeof navigator).toBe("undefined");
      expect(currentPlatform()).toBe("desktop");
    });

    it("answers desktop for a navigator with no user agent string", () => {
      vi.stubGlobal("navigator", {});
      expect(currentPlatform()).toBe("desktop");
    });

    it("reads the browser's user agent when there is one", () => {
      vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)" });
      expect(currentPlatform()).toBe("ios");
    });
  });
});
