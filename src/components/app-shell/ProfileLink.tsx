"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { copy } from "@/lib/shared/copy";

/**
 * The profile link in the top right of every screen inside the (app) group,
 * docs/01-user-flow.md "Screen map": "Profile is reached from the top right."
 *
 * It marks itself when the person is already on /profile, which is the same rule
 * BottomNav follows for its own current item: aria-current="page" and Ivory
 * instead of Sand. Before Layer 5 the profile screen was a stub nobody landed
 * on, so the link was never the current one; now that it is a screen, a link
 * that points at the screen you are reading without saying so is a link that
 * does nothing and does not admit it.
 *
 * It stays a link rather than disappearing on /profile: the header holds the top
 * rhythm of every screen in the group, and dropping the only thing in it would
 * lift the profile title 44px above where every other title sits.
 */
export function ProfileLink() {
  const current = usePathname() === "/profile";

  return (
    <Link
      href="/profile"
      aria-current={current ? "page" : undefined}
      className={`inline-flex min-h-[44px] items-center font-body text-small underline-offset-4 hover:underline focus-visible:underline ${
        current ? "text-text" : "text-text-muted"
      }`}
    >
      {copy.nav.profile}
    </Link>
  );
}
