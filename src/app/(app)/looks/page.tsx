import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { copy } from "@/lib/shared/copy";

/** K. Looks. Built in Layer 4, docs/09-build-order-and-demo.md. */
export default function LooksPage() {
  return <ScreenTitle>{copy.nav.looks}</ScreenTitle>;
}
