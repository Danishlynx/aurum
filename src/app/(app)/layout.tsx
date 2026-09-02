import type { ReactNode } from "react";

import { AppBackLink } from "@/components/app-shell/AppBackLink";
import { BottomNav } from "@/components/app-shell/BottomNav";
import { ProfileLink } from "@/components/app-shell/ProfileLink";
import { Column } from "@/components/layout/Column";

/**
 * The (app) shell. docs/01-user-flow.md "Screen map": bottom navigation lives
 * inside this group only, and Profile is reached from the top right.
 *
 * The public, consent, capture, and reveal screens have no chrome, which is why
 * this shell is here and not in the root layout.
 *
 * The header is the skeleton's own row (docs/02-design-system.md, "Layout"):
 * back on the left, the profile link on the right, and the screen's title under
 * it. The title stays below rather than between them because it is display-2 at
 * 32px, and three things on one row do not fit a 390px column.
 *
 * The back control is drawn on one screen in this group, /wardrobe, and the
 * table in src/lib/shared/navigation.ts says why that is the only one. It is
 * pulled left with mr-auto rather than by justifying the row, so the profile
 * link sits in the same place on all seven screens whether or not there is a
 * chevron beside it, and the row keeps its height either way.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-[100svh] flex-col">
      <header className="pt-6">
        <Column className="flex min-h-[44px] items-center justify-end gap-4">
          <div className="mr-auto">
            <AppBackLink />
          </div>
          <ProfileLink />
        </Column>
      </header>
      <main className="flex-1 pb-24 pt-2">{children}</main>
      <BottomNav />
    </div>
  );
}
