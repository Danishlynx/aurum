import { Suspense } from "react";

import { AnalyzingScreen } from "@/components/analyzing/AnalyzingScreen";
import { Column } from "@/components/layout/Column";
import { SkeletonRow } from "@/components/ui/SkeletonRow";

/**
 * E. Analyzing, docs/01-user-flow.md section E.
 *
 * The capture id arrives as a search parameter, so the screen reads it on the
 * client and the Suspense boundary holds the shape of the status line until it
 * does. Basalt skeleton, static, no spinner over a face.
 */
export default function AnalyzingPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-[100svh] flex-col justify-end bg-surface pb-12">
          <Column>
            <SkeletonRow lines={1} height={24} />
          </Column>
        </main>
      }
    >
      <AnalyzingScreen />
    </Suspense>
  );
}
