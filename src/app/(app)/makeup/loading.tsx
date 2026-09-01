import { MakeupSkeleton } from "@/components/makeup/MakeupSkeleton";

/**
 * The loading state for /makeup, wired to the route so it shows while the server
 * builds the view. Static Basalt skeletons, no shimmer, no spinner over a face
 * (docs/02-design-system.md, SkeletonRow).
 */
export default function MakeupLoading() {
  return <MakeupSkeleton />;
}
