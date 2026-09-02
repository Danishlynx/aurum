import { redirect } from "next/navigation";

import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { LooksScreen } from "@/components/looks/LooksScreen";
import { demoProfileIsReadOnly } from "@/lib/server/judge/demo";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { accessoryTryOnOptions } from "@/lib/server/renders";
import { getSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";

/**
 * K. Looks, docs/01-user-flow.md section K: the occasion chips, two to three
 * composed looks with rationales, the cloth try on of the hero garment, and
 * "Shop the gap".
 *
 * A server component that does two things: it checks the session, and it renders
 * the screen. The looks themselves are fetched by the screen from
 * GET /api/looks?occasion=, because a look belongs to an occasion and the
 * occasion is a chip the person taps: the screen would fetch a new view on the
 * first tap either way, so every view comes from the same route.
 *
 * There is no redirect to /capture here, unlike /report and /hair. A person with
 * no profile has no palette, and the rules engine composes on formality alone in
 * that case (src/lib/shared/looks.ts, matchToPalette with a null palette). That
 * is a smaller screen, not a broken one, so it is not worth sending someone away
 * from it.
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true the looks route answers from the
 * checked in fixture and touches neither the database nor a provider, and every
 * write refuses with 403, which the screen reports as the demo profile being
 * read only.
 */

/** The screen reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function LooksPage() {
  const fixture = isDemoFixtureMode();
  /*
   * Fixture mode answers from the checked in fixture before it reads anything,
   * so there is no session to resolve and no Supabase project to resolve one
   * against. See src/app/(app)/report/page.tsx.
   */
  const session = fixture ? null : await getSession();
  if (!fixture && session === null) {
    // No session means consent has not been given on this device.
    redirect("/welcome");
  }

  /*
   * The accessory try on in the top look, docs/09-build-order-and-demo.md Layer
   * 6. The render layer answers with an empty list in fixture mode, without a
   * Perfect Corp key, with the kill switch off, when the wardrobe holds no
   * accessory, and for every category whose endpoint is still unverified. An
   * empty list draws no affordance, so the demo never shows a control that
   * cannot render.
   */
  const accessoryOptions =
    session === null ? [] : await accessoryTryOnOptions(session);

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.looks}</ScreenTitle>

      {/* Read only covers the development switch and a judge session with no
          analyses left alike (src/lib/server/judge/demo.ts). */}
      <LooksScreen
        readOnly={demoProfileIsReadOnly(session)}
        accessoryOptions={accessoryOptions}
      />
    </div>
  );
}
