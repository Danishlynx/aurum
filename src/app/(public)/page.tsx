import Link from "next/link";

import { LandingHero } from "@/components/landing/LandingHero";
import { Column } from "@/components/layout/Column";
import { Button, ButtonLink } from "@/components/ui/Button";
import { copy } from "@/lib/shared/copy";

/**
 * A. Landing, docs/01-user-flow.md section A.
 *
 * The headline is the only centered element on this screen
 * (docs/02-design-system.md "Layout", alignment).
 *
 * The hero is the reveal preview: the fixture face with gold toned concern masks
 * blooming and settling into swatches, the one orchestrated non user triggered
 * motion in the app. It plays only when the consented fixture face is in the
 * repository at public/fixtures/landing-face.jpg; until then the frame holds its
 * exact size in Basalt, so the screen is composed at 390px either way and
 * nothing reflows when the image lands. That decision is made on the server, in
 * src/components/landing/LandingHero.tsx.
 *
 * The fixture is the founder's own consented selfie, or a synthetic face made
 * with Perfect Corp's tools. Never a stock model, never an illustration
 * (docs/02-design-system.md "Imagery").
 */

const demoVideoUrl = process.env.NEXT_PUBLIC_DEMO_VIDEO_URL ?? "";

export default function LandingPage() {
  return (
    <main className="py-12">
      <Column className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-center font-display text-display-1 font-light text-text">
            {copy.landing.headline}
          </h1>
          <p className="max-w-[64ch] font-body text-body text-text-muted">
            {copy.landing.subhead}
          </p>
        </div>

        <LandingHero />

        <div className="flex flex-col gap-4">
          <ButtonLink variant="primary" href="/welcome">
            {copy.landing.primaryAction}
          </ButtonLink>
          {demoVideoUrl === "" ? (
            <Button variant="quiet" disabled>
              {copy.landing.secondaryLink}
            </Button>
          ) : (
            <a
              href={demoVideoUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-[44px] items-center font-body text-body text-text-muted underline-offset-4 hover:underline focus-visible:underline"
            >
              {copy.landing.secondaryLink}
            </a>
          )}
        </div>

        <div className="border-t border-raised pt-6">
          <Link
            href="/judge"
            className="inline-flex min-h-[44px] items-center font-body text-small text-text-muted underline-offset-4 hover:underline focus-visible:underline"
          >
            {copy.landing.judgeFooter}
          </Link>
        </div>
      </Column>
    </main>
  );
}
