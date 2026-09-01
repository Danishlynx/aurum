# Landing hero fixture face

This folder holds one file, and it is not in the repository yet:

    public/fixtures/landing-face.jpg

It is the face the landing hero reveal plays over (docs/01-user-flow.md section
A). No build step can produce it, because it is a photograph of a real person who
has to agree to it being published.

## What it has to be

- A face you have written consent to publish. Your own is simplest. A synthetic
  face made with Perfect Corp's tools also works.
- Never a stock model, never an illustration, never a 3D render, never abstract
  art, never a customer's photo, never a friend's photo without written consent
  (docs/02-design-system.md, "Imagery", and docs/06-safety-privacy.md).
- Square, at least 800 by 800, face centred and evenly lit, so the mask oval
  lands on the face.
- Under about 300KB. The landing screen has to load in under 3 seconds on mobile
  data (docs/09-build-order-and-demo.md, pre submission checklist).

## What happens when you add it

Nothing else changes. `src/components/landing/LandingHero.tsx` asks the file
system for the file on the server:

- file absent (today): the hero is the quiet Basalt frame, at exactly the size
  the reveal would take, and no image is requested from the browser, so there is
  no failed request in a screen recording.
- file present: the hero becomes the reveal preview. Gold toned masks bloom over
  the face for 600ms with an ease out curve, settle over 300ms, and three
  swatches arrive with the settle. It plays once. With
  `prefers-reduced-motion: reduce` the settled state is painted on the first
  frame and nothing animates (docs/02-design-system.md, "Motion").

Rebuild after adding it. The landing screen is prerendered, so the check runs at
build time.

## Record the consent

Write the consent record next to the fixture consent record in
`evals/fixtures/README.md`: whose face it is, who holds the written consent, and
the date. A face in a public repository with no consent record is the one thing
this project does not ship.
