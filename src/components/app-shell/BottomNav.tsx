"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Column } from "@/components/layout/Column";
import { copy } from "@/lib/shared/copy";

/**
 * Bottom navigation, docs/01-user-flow.md "Screen map": Report, Color, Makeup,
 * Hair, Looks. Wardrobe is reached from Looks, Profile from the top right.
 *
 * docs/02-design-system.md: Manrope micro, Sand, active Ivory. Text only, so
 * nothing here is an icon without a label. The hairline above it is the only
 * separation; there is no shadow and no fill change.
 */

const ITEMS = [
  { href: "/report", label: copy.nav.report },
  { href: "/color", label: copy.nav.color },
  { href: "/makeup", label: copy.nav.makeup },
  { href: "/hair", label: copy.nav.hair },
  { href: "/looks", label: copy.nav.looks },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-raised bg-canvas">
      <Column className="flex items-stretch justify-between">
        {ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[56px] flex-1 items-center justify-center font-body text-micro font-medium ${
                active ? "text-text" : "text-text-muted"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </Column>
    </nav>
  );
}
