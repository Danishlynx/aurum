import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { copy } from "@/lib/shared/copy";

/** J. Wardrobe. Built in Layer 4, docs/09-build-order-and-demo.md. */
export default function WardrobePage() {
  return <ScreenTitle>{copy.nav.wardrobe}</ScreenTitle>;
}
