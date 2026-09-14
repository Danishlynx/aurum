/**
 * The second line under a failed upload on the capture screen.
 *
 * On 2026-09-14 a phone showed "Upload did not complete. Your photo was not
 * saved. Try again." and nothing else, and the cause had to be reconstructed
 * from the code: the judge session had run out, the register call answered
 * 401, and the screen said the same thing it says for a dropped connection. A
 * status code is not a sentence a person acts on, but it is what turns a
 * screenshot into a diagnosis, so the screen now says which step stopped and
 * what the server said. The first line is unchanged.
 */

import { copy, fill } from "@/lib/shared/copy";

/** The steps between the tap and /analyzing, in the order they run. */
export type UploadStep = keyof typeof copy.capture.uploadSteps;

/**
 * Where the upload stopped and what came back. status is the HTTP status, or
 * zero when the request never got an answer (a dropped connection, a refused
 * CORS preflight, an encoder that returned nothing).
 */
export type UploadFailure = {
  readonly step: UploadStep;
  readonly status: number;
};

export function uploadFailureDetail(failure: UploadFailure): string {
  const step = copy.capture.uploadSteps[failure.step];
  if (failure.status <= 0) {
    return fill(copy.errors.uploadFailedNoAnswerTemplate, { step });
  }
  return fill(copy.errors.uploadFailedDetailTemplate, {
    step,
    status: failure.status,
  });
}
