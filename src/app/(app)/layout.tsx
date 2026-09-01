import type { ReactNode } from "react";

import { BottomNav } from "@/components/app-shell/BottomNav";
import { ProfileLink } from "@/components/app-shell/ProfileLink";
import { Column } from "@/components/layout/Column";

/**
 * The (app) shell. docs/01-user-flow.md "Screen map": bottom navigation lives
 * inside this group only, and Profile is reached from the top right.
 *
 * The public, consent, capture, and reveal screens have no chrome, which is why
 * this shell is here and not in the root layout.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-[100svh] flex-col">
      <header className="pt-6">
        <Column className="flex justify-end">
          <ProfileLink />
        </Column>
      </header>
      <main className="flex-1 pb-24 pt-2">{children}</main>
      <BottomNav />
    </div>
  );
}
