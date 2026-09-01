import { Column } from "@/components/layout/Column";
import { ConsentForm } from "@/components/welcome/ConsentForm";
import { copy } from "@/lib/shared/copy";

/**
 * C. Welcome and consent, docs/01-user-flow.md section C.
 *
 * Three short sections separated by warm hairlines, one checkbox group, one
 * button, no illustration. It is a screen and never a modal
 * (docs/06-safety-privacy.md, "Consent").
 *
 * A returning person with a profile skips this screen and lands on /report.
 * That redirect needs the session, so it lands with the auth work in Layer 0.
 */
export default function WelcomePage() {
  return (
    <main className="py-12">
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
  );
}
