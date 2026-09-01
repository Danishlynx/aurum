import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { copy } from "@/lib/shared/copy";

/** L. Profile. Built in Layer 5, docs/09-build-order-and-demo.md. */
export default function ProfilePage() {
  return <ScreenTitle>{copy.nav.profile}</ScreenTitle>;
}
