import { redirect } from "next/navigation";

import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { WardrobeScreen } from "@/components/wardrobe/WardrobeScreen";
import { demoProfileIsReadOnly } from "@/lib/server/judge/demo";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { getSession, type AppSession } from "@/lib/server/session";
import { buildWardrobeView } from "@/lib/server/wardrobe";
import { copy } from "@/lib/shared/copy";

/**
 * J. Wardrobe, docs/01-user-flow.md section J: the empty state, the add flow,
 * and the grid of garment cards filterable by type.
 *
 * A server component. It reads the session, asks the wardrobe layer for one
 * WardrobeView, and hands it to the screen. Every signed photo URL and every
 * chip on it comes from the person's own stored rows; nothing on this screen
 * decides what a garment is.
 *
 * There is no redirect to /capture here, unlike /report and /hair. A wardrobe
 * does not need a profile: a person can add garments before they take a selfie,
 * and the looks screen is the one that reads their palette. The only thing this
 * screen needs is a session, which is what consent produces.
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true the wardrobe layer answers from the
 * checked in six garment fixture and touches neither the database nor a
 * provider. Every write route refuses with 403 in that mode, and the screen says
 * the demo profile is read only rather than claiming a save.
 */

/** The screen reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

/** See src/app/(app)/report/page.tsx for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export default async function WardrobePage() {
  const fixture = isDemoFixtureMode();
  const session = fixture ? FIXTURE_SESSION : await getSession();
  if (session === null) {
    // No session means consent has not been given on this device, and a garment
    // photo is the person's own data under the same consent record.
    redirect("/welcome");
  }

  const view = await buildWardrobeView(session);

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.wardrobe}</ScreenTitle>

      {/* Read only covers the development switch and a judge session with no
          analyses left alike (src/lib/server/judge/demo.ts). */}
      <WardrobeScreen view={view} readOnly={demoProfileIsReadOnly(session)} />
    </div>
  );
}
