import { ProductCard } from "@/components/ui/ProductCard";
import { copy, fill } from "@/lib/shared/copy";
import type { RoutineStepView } from "@/lib/shared/report-view";

/**
 * The routine, docs/01-user-flow.md section F item 5: two groups, "Morning" and
 * "Night", each step a row with the step name, the concern it addresses, one
 * sentence of why, and a product card.
 *
 * docs/02-design-system.md, RoutineRow: step name in Manrope 600, the concern tag
 * in gold micro, one sentence of why in Sand, then the ProductCard. "The routine
 * is a real sequence, so numbering the steps is appropriate here and only here."
 *
 * The product card falls back to the ingredient or product type with the "No
 * listing found near you yet" line, which is why the row still reads as advice
 * when SerpApi returned nothing (docs/06-safety-privacy.md, "Grounding and
 * honesty").
 */

type RoutineGroupProps = {
  readonly heading: string;
  /** "morning" or "night", used to build stable element ids. */
  readonly period: string;
  readonly steps: readonly RoutineStepView[];
};

export function RoutineGroup({ heading, period, steps }: RoutineGroupProps) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">{heading}</h2>
      <ol className="flex flex-col gap-6">
        {steps.map((step, index) => {
          const id = `routine-${period}-${index + 1}`;
          return (
            <li key={id} className="flex gap-3">
              <span
                aria-hidden="true"
                className="w-4 shrink-0 pt-1 font-body text-small tabular-nums text-text-muted"
              >
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="font-body text-body font-semibold text-text">
                  {step.stepName}
                </p>
                <p className="font-body text-micro font-medium text-accent">
                  {/*
                    "for pigmentation": the doc writes the tag in lower case
                    inside the sentence, while the concern label is a display
                    name that starts a row elsewhere.
                  */}
                  {fill(copy.report.routineConcernTagTemplate, {
                    concern: step.concernLabel.toLowerCase(),
                  })}
                </p>
                <p className="max-w-[70ch] font-body text-small text-text-muted">
                  {step.why}
                </p>
                {/*
                  The card is given the step name, not the search query: the
                  step name is the ingredient or product type in the person's
                  words ("gel cleanser", "niacinamide serum"), which is what
                  docs/06-safety-privacy.md asks the advice to name when no
                  listing came back. The query is a search string and is never
                  shown.
                */}
                <ProductCard
                  id={id}
                  product={step.product}
                  productType={step.stepName}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
