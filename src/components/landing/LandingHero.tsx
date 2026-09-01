import { landingFaceSource } from "./fixture-face";
import { HeroReveal } from "./HeroReveal";

/**
 * The landing hero, docs/01-user-flow.md section A.
 *
 * One decision, made on the server: is the consented fixture face in the
 * repository. With it, the hero is the reveal preview
 * (src/components/landing/HeroReveal.tsx). Without it, the hero is the quiet
 * Basalt frame that has held this space since Layer 0, at exactly the same size,
 * so the screen is composed at 390px either way and nothing reflows when the
 * image lands.
 *
 * The frame is never filled with a stock model, an illustration, or a generated
 * face while the real one is missing (docs/02-design-system.md, "Imagery"), and
 * no image is ever requested that is not there, so a screen recording of the
 * landing screen has nothing failing in its network tab.
 *
 * How to turn the reveal on: drop the image at public/fixtures/landing-face.jpg.
 * The whole runbook step is in src/components/landing/fixture-face.ts and in
 * public/fixtures/README.md.
 */
export function LandingHero() {
  const imageSrc = landingFaceSource();

  if (imageSrc === null) {
    return (
      <div
        aria-hidden="true"
        className="aspect-square w-full border border-raised bg-surface"
      />
    );
  }

  return <HeroReveal imageSrc={imageSrc} />;
}
