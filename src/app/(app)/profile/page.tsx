import { redirect } from "next/navigation";

import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { ProfileScreen } from "@/components/profile/ProfileScreen";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { getSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";

/**
 * L. Profile, docs/01-user-flow.md section L: the summary rows with their
 * "Retake" and "Adjust" affordances, the saved makeup look, hair choice, and
 * looks, and the three data controls (retention, download, typed delete).
 *
 * A server component that does two things: it checks the session, and it renders
 * the screen. The profile itself is fetched by the screen from GET /api/profile,
 * because the retention toggle and the delete both change what this screen
 * shows, so it reads the view from the same route it writes through. This is the
 * pattern /looks already uses.
 *
 * Reached from the top right of every screen inside the (app) group, which is
 * where src/app/(app)/layout.tsx puts the link (docs/01-user-flow.md "Screen
 * map": "Profile is reached from the top right").
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true the profile route answers from the
 * checked in fixture and touches neither the database nor a provider. Every
 * write refuses with 403, which the screen reports as the demo profile being
 * read only; the download refuses too (docs/06-safety-privacy.md: "Judge
 * sessions cannot delete the demo profile and cannot download data"); and the
 * delete control is not rendered at all, because the fixture is a judge session.
 */

/** The screen reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
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

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.profile}</ScreenTitle>

      <ProfileScreen />
    </div>
  );
}
