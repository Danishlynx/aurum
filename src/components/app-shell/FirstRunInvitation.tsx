import { Column } from "@/components/layout/Column";
import { ButtonLink } from "@/components/ui/Button";
import { copy } from "@/lib/shared/copy";

/**
 * What a screen shows to a person who has not taken their selfie yet.
 *
 * docs/01-user-flow.md, "Global states and rules": "Empty screens invite action
 * with one specific verb." Every screen in the (app) group is a lens on one
 * profile, so before the photo there is one thing to do, and this is it: one
 * line saying what this screen in particular is waiting on, and one control that
 * goes and gets it.
 *
 * The verb is copy.landing.primaryAction, "Start with a selfie", the same words
 * the landing screen uses, because it is the same request. The screens that used
 * to answer this state by redirecting to /capture now say why they are empty and
 * offer the way out: a redirect is a pull, but it is a silent one, and a person
 * who taps "Color" in the bottom navigation and lands on a camera has been moved
 * rather than told.
 *
 * The line comes in as a prop rather than being looked up by screen name here,
 * so this component holds no map of screens to sentences and every caller can be
 * read on its own.
 *
 * variant exists for one screen. docs/02-design-system.md allows one primary
 * (gold) action per screen, and /looks already spends its gold on "Save this
 * look" for the leading look, which is real content that renders with no profile
 * at all. There the invitation is the secondary variant: still the only
 * invitation, still one specific verb, without a second gold fill on the screen.
 */

type FirstRunInvitationProps = {
  /** What this screen is waiting on, from copy.firstRun. */
  readonly line: string;
  /** Secondary only where the screen already carries its one gold action. */
  readonly variant?: "primary" | "secondary";
};

export function FirstRunInvitation({
  line,
  variant = "primary",
}: FirstRunInvitationProps) {
  return (
    <Column className="flex flex-col items-start gap-4">
      <p className="max-w-[64ch] font-body text-body text-text">{line}</p>
      <ButtonLink variant={variant} href="/capture">
        {copy.landing.primaryAction}
      </ButtonLink>
    </Column>
  );
}
