import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { FirstRunInvitation } from "@/components/app-shell/FirstRunInvitation";
import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { MakeupScreen } from "@/components/makeup/MakeupScreen";
import { resolveGroundingLocale } from "@/lib/server/locale";
import { buildMakeupView } from "@/lib/server/profile/makeup";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { getSession, type AppSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";

/**
 * H. Makeup, docs/01-user-flow.md section H: the recommended look on the
 * person's own face, the four shade rows inside their palette, a product card
 * per selected shade, and "Save this look".
 *
 * A server component that reads the session, asks the profile layer for one
 * MakeupView, and hands it to the screen. The shades come from the palette, so
 * nothing here chooses a color.
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true the profile layer answers from the
 * checked in fixture. That fixture has no photo, so no render is requested and
 * the hero carries the documented "Preview unavailable for this shade." line
 * rather than a stand in face.
 */

/** The screen reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

/** See src/app/(app)/report/page.tsx for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export default async function MakeupPage() {
  const session = isDemoFixtureMode() ? FIXTURE_SESSION : await getSession();
  if (session === null) {
    // No session means consent has not been given on this device.
    redirect("/welcome");
  }

  /*
   * ground: true asks the grounding layer for a listing for each row's opening
   * shade, so the product cards are filled on the first paint. The queries are
   * the shades' own, so they hit the same product cache on every later visit
   * (docs/03-architecture.md, "Caching"). Choosing a different shade re grounds
   * from the browser through the same route.
   */
  const view = await buildMakeupView(session, {
    ground: true,
    // The shade a row opens on is shopped for in the viewer's own country, read
    // from this request (src/lib/server/locale.ts). Re grounding after a tap
    // goes through GET /api/profile/makeup, which resolves the same locale from
    // the same headers, so the second card comes from the same market as the
    // first.
    locale: resolveGroundingLocale(await headers()),
  });
  if (view === null) {
    // No profile yet: there is no palette, so there are no shades to recommend.
    // The screen says what it is waiting on instead of redirecting to the camera
    // without a word. See src/app/(app)/report/page.tsx.
    return (
      <div className="flex flex-col gap-8">
        <ScreenTitle>{copy.nav.makeup}</ScreenTitle>
        <FirstRunInvitation line={copy.firstRun.makeup} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.makeup}</ScreenTitle>
      <MakeupScreen view={view} />
    </div>
  );
}
