"use client";

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
 * What is drawn: Leaf, the one translucent gold in the system, over the oval the
 * capture screen asked the person to fill. It is a mask layer with no mask data
 * in it. GET /api/jobs returns job status only, so the per concern mask images
 * that Perfect Corp produces (stored in analyses.mask_paths) are not on this
 * screen yet, and drawing invented concern shapes on someone's face would be
 * inventing a result. The real masks are on /report, where the profile layer
 * hands the screen a signed URL per concern. When the polling response carries
 * mask URLs, this layer takes one and the geometry stops being an oval.
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

export function RevealMask() {
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
          clipPath: FACE_OVAL,
        }}
      />
    </>
  );
}
