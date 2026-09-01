import { copy } from "@/lib/shared/copy";
import type { SavedItemRow } from "@/lib/shared/profile-view";

/**
 * "Saved", docs/01-user-flow.md section L item 2: "saved makeup look, hair
 * choice, saved looks."
 *
 * The same hairline rows as the summary above, because they are the same kind of
 * thing: a short record of a decision the person made. The label is what they
 * saved; the detail beside it is what the server had to say about it, which for
 * a saved look is its occasion. A row with no detail simply has none, and no
 * filler is written in its place.
 *
 * Empty is one quiet line, with the verb the person needs (docs/01-user-flow.md
 * "Global states and rules": empty screens invite action with one specific
 * verb). There is nothing to link to here that the bottom navigation does not
 * already reach.
 */

type SavedListProps = {
  readonly saved: readonly SavedItemRow[];
};

/** Two saved looks are two rows, so the key is the position and the kind. */
function rowKey(row: SavedItemRow, index: number): string {
  return `${row.kind}-${index}`;
}

export function SavedList({ saved }: SavedListProps) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">
        {copy.profile.savedHeading}
      </h2>

      {saved.length === 0 ? (
        <p className="max-w-[64ch] font-body text-small text-text-muted">
          {copy.profile.savedEmpty}
        </p>
      ) : (
        <ul className="flex flex-col">
          {saved.map((row, index) => (
            <li
              key={rowKey(row, index)}
              className="flex min-h-[44px] flex-col justify-center gap-2 border-t border-raised py-4 first:border-t-0 first:pt-0"
            >
              <span className="max-w-[70ch] font-body text-body text-text">
                {row.label}
              </span>
              {row.detail === null ? null : (
                <span className="max-w-[70ch] font-body text-small text-text-muted">
                  {row.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
