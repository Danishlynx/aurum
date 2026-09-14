import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";

import { uploadFailureDetail } from "./upload-failure";

describe("uploadFailureDetail", () => {
  it("names the step and the status the server answered", () => {
    const line = uploadFailureDetail({ step: "register", status: 401 });
    expect(line).toContain(copy.capture.uploadSteps.register);
    expect(line).toContain("401");
    expect(line).toBe(
      "Stopped while registering the photo. The server answered 401.",
    );
  });

  it("says no answer came back when there was no status at all", () => {
    const line = uploadFailureDetail({ step: "store", status: 0 });
    expect(line).toContain(copy.capture.uploadSteps.store);
    expect(line).not.toMatch(/\d/u);
    expect(line).toBe(
      "Stopped while saving the photo. No answer came back from the server.",
    );
  });

  it("has words for every step the screen can stop on", () => {
    for (const step of ["encode", "register", "store", "analyze"] as const) {
      expect(uploadFailureDetail({ step, status: 500 })).toContain(
        copy.capture.uploadSteps[step],
      );
    }
  });
});
