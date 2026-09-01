import { redirect } from "next/navigation";

import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { FaceShapeLine } from "@/components/hair/FaceShapeLine";
import { HairScreen } from "@/components/hair/HairScreen";
import { Column } from "@/components/layout/Column";
import { buildHairView } from "@/lib/server/profile/hair";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { getSession, type AppSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";

/**
 * I. Hair, docs/01-user-flow.md section I: the face shape line, a row of 3 to 4
 * styles rendered on the person's own face, hair colors from their palette
 * rendered on the selected style, and "Save this".
 *
 * A server component. It reads the session, asks the profile layer for one
 * HairView, and hands it to the screen. The rules that pick the styles, write
 * the reasons, and word the face shape line all live on the server, so nothing
 * on this screen decides what suits a face.
 *
 * The face shape line is rendered here rather than inside the screen: it is
 * static text and belongs in the server rendered HTML, not in the client bundle.
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true the profile layer answers from the
 * checked in fixture. That fixture has no photo, so no render is requested and
 * the hero carries the documented preview unavailable line rather than a stand
 * in face. The save route refuses with 403 because the demo profile is read
 * only, and the screen says so instead of claiming a save.
 */

/** The screen reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

/** See src/app/(app)/report/page.tsx for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export default async function HairPage() {
  const fixture = isDemoFixtureMode();
  const session = fixture ? FIXTURE_SESSION : await getSession();
  if (session === null) {
    // No session means consent has not been given on this device.
    redirect("/welcome");
  }

  const view = await buildHairView(session);
  if (view === null) {
    // No profile yet: there is no face shape to read from, so the person goes to
    // capture rather than to an empty screen.
    redirect("/capture");
  }

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.hair}</ScreenTitle>

      <Column>
        <FaceShapeLine line={view.faceShapeLine} />
      </Column>

      <HairScreen view={view} readOnly={fixture} />
    </div>
  );
}
