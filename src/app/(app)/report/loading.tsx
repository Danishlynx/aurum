import { ReportSkeleton } from "@/components/report/ReportSkeleton";

/**
 * The loading state docs/01-user-flow.md section F describes, wired to the route
 * so it shows while the server builds the report view.
 *
 * Basalt skeletons in the exact shape of the content, static: no shimmer, no
 * pulse, no spinner over a face (docs/02-design-system.md, SkeletonRow).
 */
export default function ReportLoading() {
  return <ReportSkeleton />;
}
