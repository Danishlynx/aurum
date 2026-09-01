"use client";

/**
 * The landing hero reveal preview, docs/01-user-flow.md section A: "a slow, one
 * time reveal on a fixture face where gold toned concern masks bloom over the
 * face and settle into swatches. This single orchestrated motion is the only non
 * user triggered animation in the app."
 *
 * docs/02-design-system.md, "Motion", is the timing, and it is the same timing as
 * the reveal on /analyzing that this previews: "Masks bloom over 600ms with an
 * ease out curve, then settle over 300ms." Both durations are tokens, and
 * prefers-reduced-motion drops them to 0 in src/styles/tokens.css, so a person
 * who asked for less motion is painted the settled state on the first frame
 * rather than being shown a faster version of the same animation.
 *
 * It plays once. There is no loop, no replay on scroll, no hover, and nothing
 * else on the screen moves (docs/02, anti slop item 7).
 *
 * What is drawn, and what it is not: a translucent Leaf mask over the oval the
 * capture screen asks a person to fill, then three small swatches in the golds
 * the design system already has. The swatches are the motion the doc describes,
 * not a reading: nobody has been analysed on the landing screen, so they carry
 * no concern name, no score, and no palette. Everything here is aria-hidden, and
 * the headline beside it is what a screen reader gets.
 *
 * The face is the consented fixture in public/fixtures/landing-face.jpg. When
 * that file is absent this component is not rendered at all
 * (src/components/landing/LandingHero.tsx).
 */

/**
 * Two animations rather than one, exactly as
 * src/components/analyzing/RevealMask.tsx does it: the second is delayed by the
 * bloom duration, so the settle starts when the bloom ends without a JavaScript
 * timer or a transitionend listener, both of which behave differently at zero
 * duration under reduced motion.
 */
const KEYFRAMES = `
@keyframes aurum-landing-bloom {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes aurum-landing-settle {
  from { opacity: 1; }
  to { opacity: 0.62; }
}
@keyframes aurum-landing-swatch {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

const MASK_ANIMATION = [
  "aurum-landing-bloom var(--duration-reveal-bloom) var(--ease-out) forwards",
  "aurum-landing-settle var(--duration-reveal-settle) var(--ease-in-out) var(--duration-reveal-bloom) forwards",
].join(", ");

/** The swatches arrive with the settle, on the same delay and the same curve. */
const SWATCH_ANIMATION =
  "aurum-landing-swatch var(--duration-reveal-settle) var(--ease-in-out) var(--duration-reveal-bloom) forwards";

/** The oval the capture frame asks the person to fill, which is where the face is. */
const FACE_OVAL = "ellipse(33% 24% at 50% 40%)";

/** The three golds the system has. No new colour is introduced by this hero. */
const SWATCH_TOKENS = ["var(--accent)", "var(--accent-bright)", "var(--mask)"];

type HeroRevealProps = {
  /** The consented fixture face, checked for on the server. */
  readonly imageSrc: string;
};

export function HeroReveal({ imageSrc }: HeroRevealProps) {
  return (
    <div
      aria-hidden="true"
      className="relative aspect-square w-full overflow-hidden border border-raised bg-surface"
    >
      {/*
        href and precedence let React keep one copy of these keyframes in the
        document head. They are declared here rather than in globals.css because
        they belong to this one moment.
      */}
      <style href="aurum-landing-reveal" precedence="default">
        {KEYFRAMES}
      </style>

      {/*
        The consented fixture face. Served from public/, so it is a static asset
        rather than a signed URL, and it is decorative: the headline says what
        the product does.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageSrc}
        alt=""
        draggable={false}
        className="h-full w-full select-none object-cover"
      />

      <span
        className="pointer-events-none absolute inset-0"
        style={{
          animation: MASK_ANIMATION,
          backgroundColor: "var(--mask)",
          clipPath: FACE_OVAL,
        }}
      />

      <span
        className="pointer-events-none absolute bottom-4 left-4 flex gap-2 opacity-0"
        style={{ animation: SWATCH_ANIMATION }}
      >
        {SWATCH_TOKENS.map((token) => (
          <span
            key={token}
            className="h-6 w-6 rounded-sm"
            style={{ backgroundColor: token }}
          />
        ))}
      </span>
    </div>
  );
}
