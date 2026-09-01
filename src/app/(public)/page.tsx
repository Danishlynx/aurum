import { copy } from "@/lib/shared/copy";

/**
 * Temporary placeholder for the landing screen.
 * The real screen (reveal preview, primary action, judge entry) is specified in
 * docs/01-user-flow.md section A and is built in a later Layer 0 pass.
 */
export default function LandingPlaceholderPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[var(--column-max)] flex-col justify-center px-[var(--column-padding)] py-16">
      <h1 className="text-center font-display text-display-1 font-light text-text">
        {copy.landing.headline}
      </h1>
      <p className="mx-auto mt-6 max-w-[64ch] text-center text-body text-text-muted">
        {copy.landing.subhead}
      </p>
    </main>
  );
}
