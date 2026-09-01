import { redirect } from "next/navigation";

import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { ConcernList } from "@/components/report/ConcernList";
import { ReadingBlock } from "@/components/report/ReadingBlock";
import { hasHeroContent } from "@/components/report/report-content";
import { ReportHero } from "@/components/report/ReportHero";
import { RoutineGroup } from "@/components/report/RoutineGroup";
import { ButtonLink } from "@/components/ui/Button";
import {
  buildReportView,
  isDemoFixtureMode,
} from "@/lib/server/profile/report-view";
import { getSession, type AppSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";
import {
  reportDermatologistLine,
  reportSkinAgeLine,
} from "@/lib/shared/report-view";

/**
 * F. Skin report, docs/01-user-flow.md section F, top to bottom: the hero with
 * mask toggles, the reading, the concern list, the skin age line, the routine in
 * two groups with a product card per step, then the footer.
 *
 * A server component. It reads the session, asks the profile layer for one
 * ReportView, and renders it. The only client component is the hero, because a
 * mask toggle is the only thing on this screen a person interacts with.
 *
 * Fixture mode: with AURUM_DEMO_FIXTURE=true, buildReportView answers from the
 * checked in fixture and never touches the database, so the screen can be built
 * and screenshotted before Supabase exists. There is no session to resolve in
 * that mode, and asking for one would only fail on the missing configuration.
 */

/** The report reads a session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Fixture mode answers from the checked in fixture before it reads anything, so
 * there is no session to resolve and no Supabase project to resolve one against.
 * This value exists only to satisfy the parameter on that one path. It is never
 * used when fixture mode is off, and it never reaches a query.
 */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export default async function ReportPage() {
  const session = isDemoFixtureMode() ? FIXTURE_SESSION : await getSession();
  if (session === null) {
    // No session means consent has not been given on this device.
    redirect("/welcome");
  }

  const view = await buildReportView(session);
  if (view === null) {
    // A session with no profile yet has nothing to report on. The person needs
    // to take the selfie first, so send them there rather than draw an empty
    // screen.
    redirect("/capture");
  }

  const skinAgeLine = reportSkinAgeLine(view);
  const dermatologistLine = reportDermatologistLine(view);

  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.report}</ScreenTitle>

      {hasHeroContent(view) ? (
        <Column>
          <ReportHero
            captureImageUrl={view.captureImageUrl}
            concerns={view.concerns}
          />
        </Column>
      ) : null}

      <Column>
        <ReadingBlock view={view} />
      </Column>

      <Column>
        <ConcernList concerns={view.concerns} />
      </Column>

      {skinAgeLine === null && dermatologistLine === null ? null : (
        <Column className="flex flex-col gap-3">
          {/*
            Both lines are required framing from docs/06-safety-privacy.md, said
            once, small, and never celebrated. The skin age estimate and its
            framing sentence are produced together by copy.formatSkinAge.
          */}
          {skinAgeLine === null ? null : (
            <p className="max-w-[70ch] font-body text-small text-text-muted">
              {skinAgeLine}
            </p>
          )}
          {dermatologistLine === null ? null : (
            <p className="max-w-[70ch] font-body text-small text-text-muted">
              {dermatologistLine}
            </p>
          )}
        </Column>
      )}

      <Column>
        <RoutineGroup
          heading={copy.report.routineMorning}
          period="morning"
          steps={view.routine.morning}
        />
      </Column>

      <Column>
        <RoutineGroup
          heading={copy.report.routineNight}
          period="night"
          steps={view.routine.night}
        />
      </Column>

      <Column className="flex flex-col items-start gap-4">
        {/*
          docs/01-user-flow.md section F item 7. The report is already saved, so
          this button confirms and moves the person on to their color identity.
          "Retake photo" is quiet, because it is the rarer choice.
        */}
        <ButtonLink variant="primary" href="/color">
          {copy.report.saveToProfileAction}
        </ButtonLink>
        <ButtonLink variant="quiet" href="/capture">
          {copy.report.retakePhotoAction}
        </ButtonLink>
      </Column>
    </div>
  );
}
