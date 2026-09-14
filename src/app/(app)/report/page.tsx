import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { FirstRunInvitation } from "@/components/app-shell/FirstRunInvitation";
import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { ConcernList } from "@/components/report/ConcernList";
import { ReadingBlock } from "@/components/report/ReadingBlock";
import { ProjectionRow } from "@/components/report/ProjectionRow";
import { hasHeroContent } from "@/components/report/report-content";
import { ReportHero } from "@/components/report/ReportHero";
import { RoutineGroup } from "@/components/report/RoutineGroup";
import { ButtonLink } from "@/components/ui/Button";
import { reconcileRunningJobsForProfile } from "@/lib/server/jobs";
import { resolveGroundingLocale } from "@/lib/server/locale";
import {
  buildReportView,
  isDemoFixtureMode,
} from "@/lib/server/profile/report-view";
import { readProjection } from "@/lib/server/renders";
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

  /*
   * The readings the reveal did not wait for.
   *
   * /analyzing leaves for this screen about thirty seconds after the core set
   * lands, and its poll is the only thing that advances a provider task. A face
   * shape or Fitzpatrick reading still running at that moment was charged and
   * then abandoned: no result stored, no reservation settled, and a jobs row
   * that says running for ever. So this screen asks for one catch up pass on
   * the capture its profile was built from, which is the last moment anybody is
   * looking. It is bounded to a single pass and it cannot throw
   * (src/lib/server/jobs/index.ts), so a provider that is down costs a beat of
   * render time and nothing else.
   *
   * Fixture mode is skipped because it reads no database at all. Every other
   * way the pass can fail, including a server with no project to read, is
   * absorbed inside it, because a judge at zero analyses reaches this screen
   * on a server that may have no project and is promised a demo profile, not
   * an error page.
   */
  if (!isDemoFixtureMode()) {
    await reconcileRunningJobsForProfile(session);
  }

  /*
   * Which country's shops the routine is grounded in, read from this request
   * (src/lib/server/locale.ts). A judge opening the report in Portland gets
   * American listings; the founder in India gets Indian ones; a machine with no
   * country header gets the configured default. The header is Vercel's, so this
   * is the only place on the screen that needs to know about it.
   */
  const view = await buildReportView(
    session,
    resolveGroundingLocale(await headers()),
  );
  if (view === null) {
    /*
     * A session with no profile yet has nothing to report on.
     *
     * This used to redirect to /capture. The pull is right and it stays, but it
     * is said out loud now: docs/01-user-flow.md, "Global states and rules",
     * asks an empty screen to invite action with one specific verb, and a
     * redirect invites nothing. Somebody who taps "Report" in the bottom
     * navigation and arrives at a camera has been moved without being told why.
     * The title stays on screen so the navigation still says where they are.
     */
    return (
      <div className="flex flex-col gap-8">
        <ScreenTitle>{copy.nav.report}</ScreenTitle>
        <FirstRunInvitation line={copy.firstRun.report} />
      </div>
    );
  }

  const skinAgeLine = reportSkinAgeLine(view);
  const dermatologistLine = reportDermatologistLine(view);

  /*
   * The projection, docs/09-build-order-and-demo.md Layer 6. The render layer
   * answers with nothing at all in fixture mode, with no key, with the skin
   * simulation endpoint still unverified, or once retention has deleted the
   * original photo, and the row then renders nothing.
   */
  const projection = await readProjection({
    session,
    rankedConcernKeys: view.concerns.map((concern) => concern.key),
  });

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

      {/*
        docs/09-build-order-and-demo.md Layer 6, after the routine and before the
        footer. With no projection stored and none that could be asked for, the
        row is not on the screen at all: no column, no spacing, no control that
        cannot work. The same question is asked inside the component, so it can
        never be rendered into a state it has nothing to draw.
      */}
      {projection.renderUrl === null && !projection.canRender ? null : (
        <Column>
          <ProjectionRow
            renderUrl={projection.renderUrl}
            canRender={projection.canRender}
            concerns={projection.concerns}
          />
        </Column>
      )}

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
