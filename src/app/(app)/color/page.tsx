import { redirect } from "next/navigation";

import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { AvoidList } from "@/components/color/AvoidList";
import {
  ADJUSTER_QUERY_PARAM,
  adjusterRequestedByQuery,
} from "@/components/color/color-content";
import { DecidesRows } from "@/components/color/DecidesRows";
import { PaletteGrid } from "@/components/color/PaletteGrid";
import { ToneHeader } from "@/components/color/ToneHeader";
import { Column } from "@/components/layout/Column";
import { buildColorView } from "@/lib/server/profile/color";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { getSession, type AppSession } from "@/lib/server/session";
import { copy, fill } from "@/lib/shared/copy";

/**
 * G. Color identity, docs/01-user-flow.md section G, top to bottom: the wide
 * tone swatch with its undertone label and the "Not quite right?" link, the
 * season line, "Colors to wear", "Colors to keep away from your face", and
 * "What this decides".
 *
 * A server component. It reads the session, asks the profile layer for one
 * ColorView, and renders it. The palette is derived on the server by the pure
 * function in src/lib/shared/palette.ts; nothing on this screen decides a color.
 *
 * Client components are used only where a person taps: the tone header (which
 * owns the undertone adjuster) and the wear grid (which opens one line of why
 * under a row).
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true the profile layer answers from the
 * checked in fixture and touches neither the database nor a provider, so this
 * screen builds and renders before Supabase exists.
 *
 * One query parameter is read: "adjust=undertone" opens the undertone adjuster
 * on arrival, which is what the "Adjust" affordance on /profile links to
 * (docs/01-user-flow.md section L item 1). Anything else is ignored.
 */

/** The screen reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Fixture mode answers before it reads anything, so there is no session to
 * resolve and no Supabase project to resolve one against. This value satisfies
 * the parameter on that one path and never reaches a query. Same reasoning as
 * src/app/(app)/report/page.tsx.
 */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

type ColorPageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ColorPage({ searchParams }: ColorPageProps) {
  const session = isDemoFixtureMode() ? FIXTURE_SESSION : await getSession();
  if (session === null) {
    // No session means consent has not been given on this device.
    redirect("/welcome");
  }

  const view = await buildColorView(session);
  if (view === null) {
    // No profile yet: there is no tone to show, so the person goes to capture
    // rather than to an empty screen.
    redirect("/capture");
  }

  const palette = view.palette;
  const query = await searchParams;

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.color}</ScreenTitle>

      <Column>
        <ToneHeader
          skinToneHex={view.skinToneHex}
          undertone={view.undertone}
          openAdjuster={adjusterRequestedByQuery(query[ADJUSTER_QUERY_PARAM])}
        />
      </Column>

      {palette === null ? null : (
        <>
          {/*
            docs/01 section G item 3: the season line, then one sentence in plain
            words. Both come from the palette: the display name is the season's,
            and the sentence is written beside it in src/lib/shared/palette.ts,
            so this screen never explains a season in its own words.
          */}
          <Column className="flex flex-col gap-2">
            <p className="font-display text-title text-text">
              {fill(copy.color.seasonLineTemplate, {
                season: palette.seasonDisplayName,
              })}
            </p>
            <p className="max-w-[64ch] font-body text-body text-text-muted">
              {palette.seasonLine}
            </p>
          </Column>

          <Column>
            <PaletteGrid colors={palette.wear} />
          </Column>

          <Column>
            <AvoidList colors={palette.avoid} />
          </Column>
        </>
      )}

      <Column>
        <DecidesRows />
      </Column>
    </div>
  );
}
