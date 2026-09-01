import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { copy } from "@/lib/shared/copy";

/** G. Color identity. Built in Layer 2, docs/09-build-order-and-demo.md. */
export default function ColorPage() {
  return <ScreenTitle>{copy.nav.color}</ScreenTitle>;
}
