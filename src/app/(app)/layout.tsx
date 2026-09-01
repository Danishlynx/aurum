import Link from "next/link";
import type { ReactNode } from "react";

import { BottomNav } from "@/components/app-shell/BottomNav";
import { Column } from "@/components/layout/Column";
import { copy } from "@/lib/shared/copy";

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
          <Link
            href="/profile"
            className="inline-flex min-h-[44px] items-center font-body text-small text-text-muted underline-offset-4 hover:underline focus-visible:underline"
          >
            {copy.nav.profile}
          </Link>
        </Column>
      </header>
      <main className="flex-1 pb-24 pt-2">{children}</main>
      <BottomNav />
    </div>
  );
}
