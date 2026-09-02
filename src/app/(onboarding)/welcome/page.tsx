import { redirect } from "next/navigation";

import { BackLink } from "@/components/app-shell/BackLink";
import { Column } from "@/components/layout/Column";
import { ConsentForm } from "@/components/welcome/ConsentForm";
import { judgeAnalysesRemaining } from "@/lib/server/judge";
import { readJudgeSessionFromCookie } from "@/lib/server/judge/guard";
import { copy } from "@/lib/shared/copy";
import { backTargetFor } from "@/lib/shared/navigation";

/**
 * C. Welcome and consent, docs/01-user-flow.md section C.
 *
 * Three short sections separated by warm hairlines, one checkbox group, one
 * button, no illustration. It is a screen and never a modal
 * (docs/06-safety-privacy.md, "Consent").
 *
 * docs/01-user-flow.md section C: "Returning person with a profile: this screen
 * is skipped; they land on /report." A judge session with no analyses left is
 * that person. It reads the saved demo profile on every screen
 * (src/lib/server/judge/demo.ts) and can never take a photo, so consent here
 * would gate nothing and the capture screen behind it is one it cannot use. The
 * redirect is server side rather than a decision the access form makes alone,
 * because a bookmark, a back button, or the landing page's own button can all
 * arrive here without going through /judge.
 *
 * The other half of that doc line, a signed in person who already has a profile,
 * still waits on the auth work: it needs a session read that reaches Supabase,
 * which this screen must not require on a build with no project configured.
 *
 * Nothing about consent is weakened by the redirect. A session that skips this
 * screen has recorded no consent, and the capture and analyze routes answer 403
 * without it (docs/06-safety-privacy.md), so no photo can be read either way.
 */

/** The page reads the judge cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const judge = await readJudgeSessionFromCookie();
  if (judge !== null && judgeAnalysesRemaining(judge) === 0) {
    redirect("/report");
  }

  return (
    <>
      {/*
        The header row of the screen skeleton (docs/02-design-system.md,
        "Layout"). This group has no shared shell, so the screen draws its own.
        Back goes to the landing screen: nothing has been recorded at this point,
        so leaving costs the person nothing, and a screen of consent text with no
        way out is a wall. src/lib/shared/navigation.ts holds the decision.
      */}
      <header className="pt-6">
        <Column>
          <BackLink href={backTargetFor("/welcome")} />
        </Column>
      </header>

      <main className="pb-12 pt-2">
        <Column className="flex flex-col gap-8">
          <h1 className="font-display text-display-2 font-light text-text">
            {copy.welcome.title}
          </h1>

          <section className="flex flex-col gap-2">
            <h2 className="font-display text-title font-normal text-text">
              {copy.welcome.section1Heading}
            </h2>
            <p className="max-w-[64ch] font-body text-body text-text-muted">
              {copy.welcome.section1Body}
            </p>
          </section>

          <section className="flex flex-col gap-2 border-t border-raised pt-8">
            <h2 className="font-display text-title font-normal text-text">
              {copy.welcome.section2Heading}
            </h2>
            <p className="max-w-[64ch] font-body text-body text-text-muted">
              {copy.welcome.section2Body}
            </p>
          </section>

          <div className="border-t border-raised pt-8">
            <ConsentForm />
          </div>
        </Column>
      </main>
    </>
  );
}
