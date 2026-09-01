import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { copy } from "@/lib/shared/copy";

/** H. Makeup. Built in Layer 3, docs/09-build-order-and-demo.md. */
export default function MakeupPage() {
  return <ScreenTitle>{copy.nav.makeup}</ScreenTitle>;
}
