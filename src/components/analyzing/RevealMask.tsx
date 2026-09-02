"use client";

import { cssImageUrl } from "@/components/ui/remote-image";

/**
 * The bloom, docs/01-user-flow.md section E step 2 and docs/02-design-system.md
 * "Motion": masks bloom over 600ms with an ease out curve, then settle over
 * 300ms. This is the one orchestrated moment in the app, and it is triggered by
 * the skin analysis coming back, never by a timer: the layer mounts when the job
 * succeeds and the two durations are the only time it knows about.
 *
 * prefers-reduced-motion drops both durations and the delay to 0 in
 * src/styles/tokens.css, so the settled state is painted on the first frame and
 * the status lines carry the sequence on their own.
 *
 * What is drawn: Leaf, the one translucent gold in the system, in the shape the
 * skin analysis actually found. GET /api/jobs signs the mask stored for the top
 * ranked concern once that analysis has succeeded, which is the mask /report
 * opens on as well, so the reveal and the report show one result.
 *
 * Alignment. A mask is a full frame PNG the size of the picture that was
 * uploaded (the golden run masks are 767 by 1024, the capture at a 1024px long
 * edge), and the still on this screen is that same frame at a 720px long edge.
 * Same aspect ratio, so cover and center place the two identically inside one
 * box, and this layer only has to be that box: an absolute layer over the
 * still, no second crop, no offset.
 *
 * How a mask is read: the engine returns its marks in the alpha channel of a
 * transparent PNG (verified against evals/fixtures/golden/raw/skin, which is 32
 * bit ARGB, transparent everywhere the concern is not, with the strength of the
 * mark in alpha). So mask-mode is alpha. Reading them as luminance would fade a
 * mark by its own color and drop a dark one altogether.
 *
 * With no mask stored (a capture whose masks failed to persist, the demo
 * profile, a poll before the skin analysis is back) the layer falls back to the
 * oval the capture screen asked the person to fill. That is the shape of the
 * frame, not a claim about a face: nothing here draws a concern the analysis
 * did not find.
 */

/**
 * Two animations rather than one: the second is delayed by exactly the bloom
 * duration, so the settle starts when the bloom ends without a JavaScript timer
 * or a transitionend listener, both of which behave differently at zero
 * duration under reduced motion.
 */
const KEYFRAMES = `
@keyframes aurum-reveal-bloom {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes aurum-reveal-settle {
  from { opacity: 1; }
  to { opacity: 0.62; }
}
`;

const ANIMATION = [
  "aurum-reveal-bloom var(--duration-reveal-bloom) var(--ease-out) forwards",
  "aurum-reveal-settle var(--duration-reveal-settle) var(--ease-in-out) var(--duration-reveal-bloom) forwards",
].join(", ");

/**
 * The oval the capture frame asked the person to fill, which is where the face
 * is. Centred with the vignette on the screen behind it.
 */
const FACE_OVAL = "ellipse(33% 20% at 50% 42%)";

type RevealMaskProps = {
  /** A signed URL for the stored mask, or null for the oval. */
  readonly maskUrl?: string | null;
};

export function RevealMask({ maskUrl = null }: RevealMaskProps) {
  const maskValue = maskUrl === null ? null : cssImageUrl(maskUrl);

  const shape =
    maskValue === null
      ? { clipPath: FACE_OVAL }
      : {
          WebkitMaskImage: maskValue,
          maskImage: maskValue,
          WebkitMaskSize: "cover",
          maskSize: "cover",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          maskMode: "alpha",
        };

  return (
    <>
      {/*
        href and precedence let React hoist this into the document head and keep
        one copy of it, so the keyframes are valid document metadata rather than
        a style element sitting in the middle of the page. They are declared here
        rather than in src/styles/globals.css because they belong to this one
        moment: the reveal is the only orchestrated motion in the app.
      */}
      <style href="aurum-reveal" precedence="default">
        {KEYFRAMES}
      </style>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          animation: ANIMATION,
          backgroundColor: "var(--mask)",
          ...shape,
        }}
      />
    </>
  );
}
