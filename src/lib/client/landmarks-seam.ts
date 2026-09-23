/**
 * The e2e seam for the face model: a landmarker result handed in by a test,
 * so the capture screen can be walked through a face of known width, position
 * and pose on a machine whose fake camera has no face in it.
 *
 * Off in production by construction, not by configuration. next.config.ts
 * defines NEXT_PUBLIC_AURUM_E2E_SEAMS in every build, "false" unless the
 * environment says exactly "true", so the check below is inlined as a literal
 * comparison and the minifier drops the whole branch: in a build without the
 * variable neither the window read nor the schema is in the bundle. (Defined
 * in every build on purpose: Next inlines only a NEXT_PUBLIC_* variable that
 * is defined at build time, and an undefined one stays a runtime property
 * read, which is how the branch shipped once, reviewed 2026-09-23.)
 * playwright.config.ts sets the variable for the fixture server it starts and
 * nothing else does; .env.example says so.
 *
 * With the seam on, a page that has set window.__aurumLandmarker before the
 * app's scripts run (page.addInitScript) gets that result back from
 * src/lib/client/landmarks.ts in place of the model's, through the same
 * conversion the model's result goes through, so the conversion is what the
 * e2e test exercises. The module also sets window.__aurumSeams = true, which is
 * how a test tells a seamed server from one that is not.
 *
 * The injected object is validated like any other external input. The schema
 * is built inside the guarded branch rather than at module level so that it,
 * too, is dead code in a build without the seam.
 */

import { z } from "zod";

/** True only in a build made with NEXT_PUBLIC_AURUM_E2E_SEAMS=true. */
const SEAMS_ON = process.env.NEXT_PUBLIC_AURUM_E2E_SEAMS === "true";

function injectedLandmarkerSchema() {
  const landmarkSchema = z.object({
    x: z.number(),
    y: z.number(),
    z: z.number().optional(),
  });

  const injectedFaceSchema = z.object({
    /** The 478 normalized landmarks of one face. */
    landmarks: z.array(landmarkSchema),
    /** The 16 column major values of the transformation matrix, or null. */
    matrix: z.array(z.number()).length(16).nullable(),
    /** Blendshape scores by name, or null. */
    blendshapes: z.record(z.string(), z.number()).nullable(),
  });

  return z.object({
    faces: z.array(injectedFaceSchema),
  });
}

export type InjectedLandmarker = z.infer<
  ReturnType<typeof injectedLandmarkerSchema>
>;
export type InjectedLandmarkerFace = InjectedLandmarker["faces"][number];

type SeamWindow = {
  __aurumSeams?: boolean;
  __aurumLandmarker?: unknown;
};

if (SEAMS_ON && typeof window !== "undefined") {
  (window as unknown as SeamWindow).__aurumSeams = true;
}

/**
 * The injected result, or null when the seam is off, there is no window, or
 * nothing valid was injected. Read on every call rather than once, so a test
 * that changes the face between taps is answered.
 */
export function injectedLandmarker(): InjectedLandmarker | null {
  if (!SEAMS_ON || typeof window === "undefined") {
    return null;
  }
  const candidate = (window as unknown as SeamWindow).__aurumLandmarker;
  if (candidate === undefined || candidate === null) {
    return null;
  }
  const parsed = injectedLandmarkerSchema().safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
