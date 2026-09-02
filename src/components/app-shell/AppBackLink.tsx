"use client";

import { usePathname } from "next/navigation";

import { BackLink } from "@/components/app-shell/BackLink";
import { backTargetFor } from "@/lib/shared/navigation";

/**
 * The back control in the header of the (app) group, resolved for whichever
 * screen is on.
 *
 * The shell is one layout for seven screens, and only one of them has a way back
 * (docs/01-user-flow.md "Screen map": "Wardrobe is reached from Looks", and it is
 * the only screen in the group that the bottom navigation and the profile link
 * do not reach). So the layout asks the shared table which screen it is drawing
 * and draws nothing on the other six. The reasoning for each of those six is
 * written in src/lib/shared/navigation.ts.
 *
 * A client component only because the pathname is what it reads. It renders the
 * same markup on the server as it does in the browser, and it holds no state.
 *
 * The onboarding screens do not use this one. They are not inside a shared shell
 * (the consent, capture, and reveal screens have no chrome at all, which is why
 * the bottom navigation lives in the (app) layout), so each of them renders
 * BackLink itself with its own path.
 */
export function AppBackLink() {
  return <BackLink href={backTargetFor(usePathname())} />;
}
