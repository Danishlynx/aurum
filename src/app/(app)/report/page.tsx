import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { copy } from "@/lib/shared/copy";

/** F. Skin report. Built in Layer 1, docs/09-build-order-and-demo.md. */
export default function ReportPage() {
  return <ScreenTitle>{copy.nav.report}</ScreenTitle>;
}
